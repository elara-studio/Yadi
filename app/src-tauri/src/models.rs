//! The catalogue of downloadable models (`resources/models.json`) and the commands that
//! download them into `<app data>/models`.
//!
//! Schema per entry: `{id, kind: "stt-stream"|"stt-final"|"llm", url?, sha256?, size_bytes?,
//! ollama_tag?, license_id, min_ram_gb, notes}`. Speech models need `url`, `sha256` and
//! `size_bytes`; LLMs (pulled through Ollama) need `ollama_tag`. `license_id` must match an entry
//! in `licenses/manifest.json` (checked by `scripts/check-licenses.mjs`).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::download::{CancelToken, Downloader, archive};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelKind {
    SttStream,
    SttFinal,
    Llm,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelEntry {
    pub id: String,
    pub kind: ModelKind,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub size_bytes: Option<u64>,
    #[serde(default)]
    pub ollama_tag: Option<String>,
    pub license_id: String,
    pub min_ram_gb: u32,
    #[serde(default)]
    pub notes: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Catalog {
    pub version: u32,
    pub models: Vec<ModelEntry>,
}

fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

impl Catalog {
    /// The catalogue compiled into the app.
    pub fn embedded() -> Result<Self, String> {
        Self::parse(include_str!("../resources/models.json"))
    }

    pub fn parse(json: &str) -> Result<Self, String> {
        let catalog: Catalog =
            serde_json::from_str(json).map_err(|e| format!("models.json: {e}"))?;
        catalog.validate()?;
        Ok(catalog)
    }

    pub fn find(&self, id: &str) -> Option<&ModelEntry> {
        self.models.iter().find(|m| m.id == id)
    }

    fn validate(&self) -> Result<(), String> {
        let mut seen = HashSet::new();
        for m in &self.models {
            let id = &m.id;
            if id.is_empty()
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
            {
                return Err(format!(
                    "model id '{id}' must be non-empty and use only letters, digits, '-' and '.'"
                ));
            }
            if !seen.insert(id.as_str()) {
                return Err(format!("duplicate model id '{id}'"));
            }
            if m.license_id.trim().is_empty() {
                return Err(format!("model '{id}' has no license_id"));
            }
            match m.kind {
                ModelKind::SttStream | ModelKind::SttFinal => {
                    let url = m
                        .url
                        .as_deref()
                        .ok_or(format!("model '{id}' needs a url"))?;
                    if !url.starts_with("https://") {
                        return Err(format!("model '{id}': url must be https"));
                    }
                    let sha = m
                        .sha256
                        .as_deref()
                        .ok_or(format!("model '{id}' needs a sha256"))?;
                    if !is_sha256_hex(sha) {
                        return Err(format!(
                            "model '{id}': sha256 must be 64 lowercase hex characters"
                        ));
                    }
                    if m.size_bytes.unwrap_or(0) == 0 {
                        return Err(format!("model '{id}' needs a size_bytes"));
                    }
                    if archive_file_name(url).is_none() {
                        return Err(format!("model '{id}': url must end in .tar.bz2 or .zip"));
                    }
                }
                ModelKind::Llm => {
                    if m.ollama_tag.as_deref().is_none_or(|t| t.trim().is_empty()) {
                        return Err(format!("LLM '{id}' needs an ollama_tag"));
                    }
                }
            }
        }
        Ok(())
    }
}

/// The archive's file name from its URL (`.tar.bz2` or `.zip` only).
pub fn archive_file_name(url: &str) -> Option<String> {
    let name = url.split(['?', '#']).next()?.rsplit('/').next()?;
    let lower = name.to_ascii_lowercase();
    if name.is_empty() || !(lower.ends_with(".tar.bz2") || lower.ends_with(".zip")) {
        return None;
    }
    Some(name.to_string())
}

pub fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("models"))
        .map_err(|e| format!("no app data directory: {e}"))
}

const COMPLETE_MARKER: &str = ".complete";

/// Where an installed model lives, if it is fully installed.
pub fn installed_dir(models_root: &std::path::Path, id: &str) -> Option<PathBuf> {
    let dir = models_root.join(id);
    dir.join(COMPLETE_MARKER).exists().then_some(dir)
}

#[derive(Default)]
pub struct DownloadState {
    active: Mutex<HashMap<String, CancelToken>>,
}

#[derive(Serialize)]
pub struct ModelStatus {
    #[serde(flatten)]
    pub entry: ModelEntry,
    pub installed: bool,
}

#[tauri::command]
pub fn list_models(app: AppHandle) -> Result<Vec<ModelStatus>, String> {
    let catalog = Catalog::embedded()?;
    let root = models_dir(&app)?;
    Ok(catalog
        .models
        .into_iter()
        .map(|entry| {
            let installed = installed_dir(&root, &entry.id).is_some();
            ModelStatus { entry, installed }
        })
        .collect())
}

/// Downloads, verifies and unpacks a speech model. Emits `download:progress {id, received, total}`
/// (at most about 10 times a second).
#[tauri::command]
pub async fn download_model(
    app: AppHandle,
    state: State<'_, DownloadState>,
    id: String,
) -> Result<(), String> {
    let catalog = Catalog::embedded()?;
    let entry = catalog
        .find(&id)
        .ok_or_else(|| format!("unknown model '{id}'"))?
        .clone();
    let (Some(url), Some(sha)) = (entry.url.clone(), entry.sha256.clone()) else {
        return Err(format!("model '{id}' is not a downloadable file"));
    };
    let root = models_dir(&app)?;
    let token = {
        let mut active = state.active.lock().unwrap_or_else(|e| e.into_inner());
        if active.contains_key(&id) {
            return Err(format!("'{id}' is already downloading"));
        }
        let token = CancelToken::new();
        active.insert(id.clone(), token.clone());
        token
    };

    let emit_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking({
        let id = id.clone();
        move || {
            install(&root, &id, &url, &sha, &token, &mut |received, total| {
                let _ = emit_app.emit(
                    "download:progress",
                    json!({ "id": id, "received": received, "total": total }),
                );
            })
        }
    })
    .await
    .map_err(|e| format!("download task failed: {e}"))?;

    state
        .active
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
    result
}

#[tauri::command]
pub fn cancel_download(state: State<DownloadState>, id: String) {
    if let Some(token) = state
        .active
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&id)
    {
        token.cancel();
    }
}

/// Download + verify + extract + mark complete. Progress is throttled to ~10 Hz.
pub fn install(
    root: &std::path::Path,
    id: &str,
    url: &str,
    sha256: &str,
    cancel: &CancelToken,
    progress: &mut dyn FnMut(u64, Option<u64>),
) -> Result<(), String> {
    if installed_dir(root, id).is_some() {
        return Ok(());
    }
    let file = archive_file_name(url).ok_or("unsupported archive type")?;
    let downloads = root.join("downloads");
    let archive_path = downloads.join(&file);
    let downloader = Downloader::new().map_err(|e| e.to_string())?;

    let mut last = Instant::now() - Duration::from_secs(1);
    let mut throttled = |received: u64, total: Option<u64>| {
        let done = total == Some(received);
        if done || last.elapsed() >= Duration::from_millis(100) {
            last = Instant::now();
            progress(received, total);
        }
    };
    downloader
        .download(url, &archive_path, sha256, &mut throttled, cancel)
        .map_err(|e| e.to_string())?;

    // Unpack beside the final folder, then rename, so a half-extracted model is never "installed".
    let staging = root.join(format!("{id}.extracting"));
    let dest = root.join(id);
    for dir in [&staging, &dest] {
        if dir.exists() {
            fs::remove_dir_all(dir).map_err(|e| format!("cannot clean {}: {e}", dir.display()))?;
        }
    }
    if let Err(e) = archive::extract(&archive_path, &staging) {
        let _ = fs::remove_dir_all(&staging);
        return Err(e.to_string());
    }
    fs::rename(&staging, &dest).map_err(|e| format!("cannot finish install: {e}"))?;
    fs::write(dest.join(COMPLETE_MARKER), b"")
        .map_err(|e| format!("cannot mark install complete: {e}"))?;
    let _ = fs::remove_file(&archive_path); // free the space; the extracted files are what we use
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(extra: &str) -> String {
        format!(
            r#"{{"version":1,"models":[{{"id":"m1","kind":"stt-final","license_id":"x","min_ram_gb":2{extra}}}]}}"#
        )
    }
    const GOOD: &str = r#","url":"https://example.test/a.tar.bz2","sha256":"0000000000000000000000000000000000000000000000000000000000000000","size_bytes":10"#;

    #[test]
    fn the_embedded_catalogue_is_valid_and_complete() {
        let c = Catalog::embedded().unwrap();
        assert_eq!(c.models.len(), 5);
        assert_eq!(
            c.models
                .iter()
                .filter(|m| m.kind == ModelKind::SttStream)
                .count(),
            2
        );
        assert_eq!(
            c.models
                .iter()
                .filter(|m| m.kind == ModelKind::SttFinal)
                .count(),
            3
        );
        for m in &c.models {
            assert!(
                m.url.as_deref().unwrap().starts_with("https://"),
                "{}",
                m.id
            );
            assert!(is_sha256_hex(m.sha256.as_deref().unwrap()), "{}", m.id);
            assert!(m.size_bytes.unwrap() > 1_000_000, "{}", m.id);
            assert!(!m.license_id.is_empty());
        }
        assert!(c.find("stt-final-whisper-base-en").is_some());
        assert!(c.find("nope").is_none());
    }

    #[test]
    fn every_catalogue_licence_id_has_a_manifest_entry() {
        let manifest = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../licenses/manifest.json"
        ))
        .unwrap();
        let manifest: serde_json::Value = serde_json::from_str(&manifest).unwrap();
        let ids: HashSet<&str> = manifest
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["id"].as_str().unwrap())
            .collect();
        for m in Catalog::embedded().unwrap().models {
            assert!(
                ids.contains(m.license_id.as_str()),
                "{} -> {}",
                m.id,
                m.license_id
            );
        }
    }

    #[test]
    fn valid_entry_parses() {
        assert!(Catalog::parse(&entry(GOOD)).is_ok());
    }

    #[test]
    fn rejects_bad_entries_with_clear_messages() {
        let cases: &[(&str, &str)] = &[
            (
                r#","sha256":"00","size_bytes":1,"url":"https://e.test/a.zip""#,
                "64 lowercase hex",
            ),
            (
                r#","url":"http://e.test/a.zip","sha256":"0000000000000000000000000000000000000000000000000000000000000000","size_bytes":1"#,
                "https",
            ),
            (
                r#","url":"https://e.test/a.zip","size_bytes":1"#,
                "needs a sha256",
            ),
            (
                r#","sha256":"0000000000000000000000000000000000000000000000000000000000000000","size_bytes":1"#,
                "needs a url",
            ),
            (
                r#","url":"https://e.test/a.exe","sha256":"0000000000000000000000000000000000000000000000000000000000000000","size_bytes":1"#,
                ".tar.bz2 or .zip",
            ),
            (
                r#","url":"https://e.test/a.zip","sha256":"0000000000000000000000000000000000000000000000000000000000000000""#,
                "size_bytes",
            ),
            (
                r#","url":"https://e.test/a.zip","sha256":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","size_bytes":1"#,
                "lowercase",
            ),
        ];
        for (extra, needle) in cases {
            let err = Catalog::parse(&entry(extra)).unwrap_err();
            assert!(err.contains(needle), "{extra} -> {err}");
        }
    }

    #[test]
    fn rejects_duplicate_ids_empty_licence_and_unknown_kind() {
        let two = format!(
            r#"{{"version":1,"models":[{0},{0}]}}"#,
            format!(r#"{{"id":"a","kind":"stt-final","license_id":"x","min_ram_gb":1{GOOD}}}"#)
        );
        assert!(Catalog::parse(&two).unwrap_err().contains("duplicate"));
        let no_lic = format!(
            r#"{{"version":1,"models":[{{"id":"a","kind":"stt-final","license_id":" ","min_ram_gb":1{GOOD}}}]}}"#
        );
        assert!(Catalog::parse(&no_lic).unwrap_err().contains("license_id"));
        assert!(Catalog::parse(r#"{"version":1,"models":[{"id":"a","kind":"weird","license_id":"x","min_ram_gb":1}]}"#).is_err());
        let bad_id = format!(
            r#"{{"version":1,"models":[{{"id":"../a","kind":"stt-final","license_id":"x","min_ram_gb":1{GOOD}}}]}}"#
        );
        assert!(Catalog::parse(&bad_id).unwrap_err().contains("model id"));
    }

    #[test]
    fn llm_entries_need_an_ollama_tag_not_a_url() {
        let ok = r#"{"version":1,"models":[{"id":"llm1","kind":"llm","ollama_tag":"qwen2.5:3b","license_id":"x","min_ram_gb":8}]}"#;
        assert!(Catalog::parse(ok).is_ok());
        let bad = r#"{"version":1,"models":[{"id":"llm1","kind":"llm","license_id":"x","min_ram_gb":8}]}"#;
        assert!(Catalog::parse(bad).unwrap_err().contains("ollama_tag"));
    }

    #[test]
    fn archive_names_come_from_the_url_path() {
        assert_eq!(
            archive_file_name("https://h/x/model.tar.bz2").as_deref(),
            Some("model.tar.bz2")
        );
        assert_eq!(
            archive_file_name("https://h/x/model.ZIP?token=1").as_deref(),
            Some("model.ZIP")
        );
        assert_eq!(archive_file_name("https://h/x/model.tar.gz"), None);
        assert_eq!(archive_file_name("https://h/x/"), None);
    }

    /// Opt-in (downloads hundreds of MB): `YADI_REAL_MODEL=<catalogue id> cargo test real_download -- --ignored --nocapture`.
    /// Downloads the real file from the catalogue URL, verifies the stored SHA-256, unpacks it.
    #[test]
    #[ignore = "downloads a real model; run explicitly"]
    fn real_download_matches_the_stored_checksum_and_unpacks() {
        let id = std::env::var("YADI_REAL_MODEL").expect("set YADI_REAL_MODEL to a catalogue id");
        let catalog = Catalog::embedded().unwrap();
        let m = catalog.find(&id).expect("unknown id").clone();
        let root = std::env::temp_dir().join(format!("yadi-real-{}-{id}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let started = Instant::now();
        let mut last_pct = 0;
        install(
            &root,
            &id,
            m.url.as_deref().unwrap(),
            m.sha256.as_deref().unwrap(),
            &CancelToken::new(),
            &mut |r, t| {
                if let Some(t) = t {
                    let pct = r * 100 / t.max(1);
                    if pct >= last_pct + 25 {
                        last_pct = pct;
                        println!("{id}: {pct}%");
                    }
                }
            },
        )
        .expect("real download + verify + extract");
        let dir = installed_dir(&root, &id).expect("installed marker");
        let mut onnx = Vec::new();
        let mut stack = vec![dir];
        while let Some(d) = stack.pop() {
            for e in fs::read_dir(&d).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else if p.extension().is_some_and(|x| x == "onnx") {
                    onnx.push(p);
                }
            }
        }
        println!(
            "{id}: {} .onnx file(s), took {:.1}s",
            onnx.len(),
            started.elapsed().as_secs_f32()
        );
        assert!(
            !onnx.is_empty(),
            "the archive should contain .onnx model files"
        );
        assert!(
            !root
                .join("downloads")
                .join(archive_file_name(m.url.as_deref().unwrap()).unwrap())
                .exists(),
            "archive removed after install"
        );
        let _ = fs::remove_dir_all(&root);
    }
}
