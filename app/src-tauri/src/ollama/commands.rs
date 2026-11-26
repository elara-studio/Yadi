//! Tauri commands for the Ollama manager. Events: `ollama:pull {status, completed, total}` and,
//! for the installer download, `download:progress {id: "ollama-installer", received, total}`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};

use super::client::{LocalModel, OllamaClient, PullEvent};
use super::install::{self, MacChecker, MacSteps, WindowsChecker, WindowsSteps};
use super::process::{self, OllamaProcess, Os, RealSpawner, StartOutcome, Status};
use crate::download::{CancelToken, Downloader};

pub struct OllamaState {
    client: OllamaClient,
    process: OllamaProcess,
    pulls: Mutex<HashMap<String, CancelToken>>,
}

impl OllamaState {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            client: OllamaClient::local()?,
            process: OllamaProcess::default(),
            pulls: Mutex::default(),
        })
    }

    /// Called when the app quits: stops Ollama only if Yadi started it.
    pub fn shutdown(&self) {
        if self.process.stop_if_started() {
            log::info!("stopped the Ollama server that Yadi started");
        }
    }
}

fn installed_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let paths = process::candidate_paths(Os::current(), home.as_deref(), local.as_deref());
    process::find_installed(&paths, &|p| p.exists())
}

#[tauri::command]
pub async fn ollama_status(state: State<'_, OllamaState>) -> Result<Status, String> {
    let installed = installed_path();
    // The probe is a quick local HTTP call but still blocking I/O.
    let client_base = state.client.base().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let client = OllamaClient::new(client_base)?;
        Ok(process::status(&client, installed))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Starts `ollama serve` on 127.0.0.1 if it is not already answering; waits up to 20 s.
#[tauri::command]
pub async fn ollama_start(app: AppHandle) -> Result<String, String> {
    let installed = installed_path().ok_or("Ollama is not installed.")?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<OllamaState>();
        let outcome = state.process.start(
            &state.client,
            &process::cli_path(&installed),
            &RealSpawner,
            Duration::from_secs(20),
            Duration::from_millis(250),
            &std::thread::sleep,
        )?;
        Ok(match outcome {
            StartOutcome::AlreadyRunning => "already-running",
            StartOutcome::Started => "started",
        }
        .to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Downloads the official installer, verifies its code signature, installs it. Refuses unless
/// `consent` is true (the setup wizard only passes true after the user agreed).
#[tauri::command]
pub async fn ollama_install(app: AppHandle, consent: bool) -> Result<String, String> {
    let work = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("downloads")
        .join("ollama-installer");
    tauri::async_runtime::spawn_blocking(move || {
        let downloader = Downloader::new().map_err(|e| e.to_string())?;
        let mut last = std::time::Instant::now() - Duration::from_secs(1);
        let mut progress = |received: u64, total: Option<u64>| {
            if last.elapsed() >= Duration::from_millis(100) || total == Some(received) {
                last = std::time::Instant::now();
                let _ = app.emit(
                    "download:progress",
                    json!({ "id": "ollama-installer", "received": received, "total": total }),
                );
            }
        };
        let mut phase = |name: &str| {
            let _ = app.emit(
                "download:progress",
                json!({ "id": "ollama-installer", "received": 0, "total": null, "phase": name }),
            );
        };
        let cancel = CancelToken::new();
        let installed = if cfg!(windows) {
            install::install(
                consent,
                &downloader,
                &WindowsSteps,
                &WindowsChecker,
                &work,
                &mut progress,
                &mut phase,
                &cancel,
            )
        } else {
            let home = std::env::var_os("HOME").map(PathBuf::from);
            let mut targets = vec![PathBuf::from("/Applications")];
            targets.extend(home.map(|h| h.join("Applications")));
            install::install(
                consent,
                &downloader,
                &MacSteps { targets },
                &MacChecker,
                &work,
                &mut progress,
                &mut phase,
                &cancel,
            )
        }
        .map_err(|e| e.to_string())?;
        Ok(installed.display().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Pulls a model, emitting `ollama:pull`. Call again to resume after a failure.
#[tauri::command]
pub async fn ollama_pull(
    app: AppHandle,
    state: State<'_, OllamaState>,
    tag: String,
) -> Result<(), String> {
    let token = {
        let mut pulls = state.pulls.lock().unwrap_or_else(|e| e.into_inner());
        if pulls.contains_key(&tag) {
            return Err(format!("'{tag}' is already downloading"));
        }
        let t = CancelToken::new();
        pulls.insert(tag.clone(), t.clone());
        t
    };
    let base = state.client.base().to_string();
    let worker_app = app.clone();
    let worker_tag = tag.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let client = OllamaClient::new(base)?;
        client
            .pull(
                &worker_tag,
                &mut |e: PullEvent| {
                    let _ = worker_app.emit("ollama:pull", &e);
                },
                &token,
            )
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;
    state
        .pulls
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&tag);
    result
}

#[tauri::command]
pub fn ollama_cancel_pull(state: State<OllamaState>, tag: String) {
    if let Some(t) = state
        .pulls
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&tag)
    {
        t.cancel();
    }
}

#[tauri::command]
pub async fn ollama_list(state: State<'_, OllamaState>) -> Result<Vec<LocalModel>, String> {
    let base = state.client.base().to_string();
    tauri::async_runtime::spawn_blocking(move || OllamaClient::new(base)?.list())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ollama_has(state: State<'_, OllamaState>, tag: String) -> Result<bool, String> {
    let base = state.client.base().to_string();
    tauri::async_runtime::spawn_blocking(move || OllamaClient::new(base)?.has(&tag))
        .await
        .map_err(|e| e.to_string())?
}
