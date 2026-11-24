//! Finding, starting and stopping Ollama.

use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;

use super::client::OllamaClient;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum Status {
    /// The API answers.
    Running {
        version: String,
    },
    /// Found on disk but not answering.
    Installed {
        path: PathBuf,
    },
    Missing,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    Mac,
    Windows,
    Other,
}

impl Os {
    pub fn current() -> Os {
        if cfg!(target_os = "macos") {
            Os::Mac
        } else if cfg!(windows) {
            Os::Windows
        } else {
            Os::Other
        }
    }
}

/// Where Ollama is normally installed (PLAN Task 14).
pub fn candidate_paths(os: Os, home: Option<&Path>, local_app_data: Option<&Path>) -> Vec<PathBuf> {
    match os {
        Os::Mac => {
            let mut v = vec![PathBuf::from("/Applications/Ollama.app")];
            if let Some(h) = home {
                v.push(h.join("Applications/Ollama.app"));
            }
            v.push(PathBuf::from("/usr/local/bin/ollama"));
            v.push(PathBuf::from("/opt/homebrew/bin/ollama"));
            v
        }
        Os::Windows => local_app_data
            .map(|l| vec![l.join("Programs").join("Ollama").join("ollama.exe")])
            .unwrap_or_default(),
        Os::Other => vec![
            PathBuf::from("/usr/local/bin/ollama"),
            PathBuf::from("/usr/bin/ollama"),
        ],
    }
}

pub fn find_installed(paths: &[PathBuf], exists: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    paths.iter().find(|p| exists(p)).cloned()
}

pub fn status(client: &OllamaClient, installed: Option<PathBuf>) -> Status {
    if let Ok(version) = client.version() {
        return Status::Running { version };
    }
    match installed {
        Some(path) => Status::Installed { path },
        None => Status::Missing,
    }
}

/// The command-line binary to run: inside an `.app` bundle it is `Contents/Resources/ollama`.
pub fn cli_path(installed: &Path) -> PathBuf {
    if installed.extension().is_some_and(|e| e == "app") {
        installed.join("Contents/Resources/ollama")
    } else {
        installed.to_path_buf()
    }
}

pub trait Spawner {
    fn spawn(&self, exe: &Path, host: &str) -> io::Result<Child>;
}

/// Starts `ollama serve` bound to the given `host:port` and nothing else.
pub struct RealSpawner;

impl Spawner for RealSpawner {
    fn spawn(&self, exe: &Path, host: &str) -> io::Result<Child> {
        let mut cmd = Command::new(exe);
        cmd.arg("serve")
            .env("OLLAMA_HOST", host) // 127.0.0.1 only: never exposed to the network
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        cmd.spawn()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum StartOutcome {
    /// Ollama was already answering; Yadi did not start it and will not stop it.
    AlreadyRunning,
    /// Yadi started it and will stop it when the app quits.
    Started,
}

#[derive(Default)]
pub struct OllamaProcess {
    child: Mutex<Option<Child>>,
}

/// `http://127.0.0.1:11434` -> `127.0.0.1:11434`
fn host_of(base: &str) -> &str {
    base.trim_start_matches("http://")
        .trim_start_matches("https://")
}

impl OllamaProcess {
    /// Starts the server if needed and waits for the API (`wait` in total, polling every `poll`).
    pub fn start(
        &self,
        client: &OllamaClient,
        exe: &Path,
        spawner: &dyn Spawner,
        wait: Duration,
        poll: Duration,
        sleep: &dyn Fn(Duration),
    ) -> Result<StartOutcome, String> {
        if client.version().is_ok() {
            return Ok(StartOutcome::AlreadyRunning);
        }
        let mut child = spawner
            .spawn(exe, host_of(client.base()))
            .map_err(|e| format!("could not start Ollama: {e}"))?;
        let mut waited = Duration::ZERO;
        loop {
            if client.version().is_ok() {
                *self.child.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);
                return Ok(StartOutcome::Started);
            }
            if let Ok(Some(status)) = child.try_wait() {
                return Err(format!("Ollama stopped right after starting ({status})."));
            }
            if waited >= wait {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "Ollama did not become ready within {} seconds.",
                    wait.as_secs()
                ));
            }
            sleep(poll);
            waited += poll;
        }
    }

    /// Stops Ollama only if Yadi started it.
    pub fn stop_if_started(&self) -> bool {
        let child = self.child.lock().unwrap_or_else(|e| e.into_inner()).take();
        match child {
            Some(mut c) => {
                let _ = c.kill();
                let _ = c.wait();
                true
            }
            None => false,
        }
    }

    #[cfg(all(test, unix))]
    pub fn started_by_yadi(&self) -> bool {
        self.child
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::super::mock::{Mock, Reply};
    use super::*;
    #[cfg(unix)]
    use std::sync::Arc;
    #[cfg(unix)]
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn mac_candidate_paths_match_the_plan() {
        let p = candidate_paths(Os::Mac, Some(Path::new("/Users/me")), None);
        let p: Vec<&str> = p.iter().map(|x| x.to_str().unwrap()).collect();
        assert_eq!(
            p,
            [
                "/Applications/Ollama.app",
                "/Users/me/Applications/Ollama.app",
                "/usr/local/bin/ollama",
                "/opt/homebrew/bin/ollama"
            ]
        );
    }

    #[test]
    fn windows_candidate_path_is_under_local_app_data() {
        let p = candidate_paths(
            Os::Windows,
            None,
            Some(Path::new(r"C:\Users\me\AppData\Local")),
        );
        assert_eq!(p.len(), 1);
        assert!(
            p[0].ends_with("Programs/Ollama/ollama.exe")
                || p[0].ends_with(r"Programs\Ollama\ollama.exe")
        );
        assert!(candidate_paths(Os::Windows, None, None).is_empty());
    }

    #[test]
    fn find_installed_returns_the_first_existing_path() {
        let paths = vec![
            PathBuf::from("/a"),
            PathBuf::from("/b"),
            PathBuf::from("/c"),
        ];
        assert_eq!(
            find_installed(&paths, &|p| p == Path::new("/b") || p == Path::new("/c")),
            Some(PathBuf::from("/b"))
        );
        assert_eq!(find_installed(&paths, &|_| false), None);
    }

    #[test]
    fn cli_path_goes_inside_app_bundles() {
        assert_eq!(
            cli_path(Path::new("/Applications/Ollama.app")),
            PathBuf::from("/Applications/Ollama.app/Contents/Resources/ollama")
        );
        assert_eq!(
            cli_path(Path::new("/usr/local/bin/ollama")),
            PathBuf::from("/usr/local/bin/ollama")
        );
    }

    fn dead_client() -> OllamaClient {
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        OllamaClient::new(format!("http://127.0.0.1:{port}")).unwrap()
    }

    #[test]
    fn status_running_installed_missing() {
        let m = Mock::start(|_| Reply::json(200, r#"{"version":"1.2.3"}"#));
        let running = OllamaClient::new(m.base()).unwrap();
        assert_eq!(
            status(&running, None),
            Status::Running {
                version: "1.2.3".into()
            }
        );
        // running wins even if no install path was found (e.g. installed somewhere unusual)
        assert_eq!(
            status(&running, Some("/x".into())),
            Status::Running {
                version: "1.2.3".into()
            }
        );

        let dead = dead_client();
        assert_eq!(
            status(&dead, Some("/Applications/Ollama.app".into())),
            Status::Installed {
                path: "/Applications/Ollama.app".into()
            }
        );
        assert_eq!(status(&dead, None), Status::Missing);
    }

    #[test]
    fn status_serialises_with_a_state_tag() {
        let v = serde_json::to_value(Status::Missing).unwrap();
        assert_eq!(v["state"], "missing");
        let v = serde_json::to_value(Status::Running {
            version: "1".into(),
        })
        .unwrap();
        assert_eq!(
            (v["state"].as_str(), v["version"].as_str()),
            (Some("running"), Some("1"))
        );
    }

    #[test]
    fn a_server_that_answers_a_5xx_is_not_running() {
        let m = Mock::start(|_| Reply::json(503, "{}"));
        assert_eq!(
            status(&OllamaClient::new(m.base()).unwrap(), None),
            Status::Missing
        );
    }

    #[test]
    fn host_is_taken_from_the_base_url() {
        assert_eq!(host_of("http://127.0.0.1:11434"), "127.0.0.1:11434");
    }

    // ---- start / stop (unix only: the fake server process is `sleep`) ----

    #[cfg(unix)]
    struct SleepSpawner {
        spawned: Arc<AtomicUsize>,
        hosts: Arc<Mutex<Vec<String>>>,
        command: &'static str,
        args: &'static [&'static str],
    }
    #[cfg(unix)]
    impl Spawner for SleepSpawner {
        fn spawn(&self, _exe: &Path, host: &str) -> io::Result<Child> {
            self.spawned.fetch_add(1, Ordering::SeqCst);
            self.hosts.lock().unwrap().push(host.to_string());
            Command::new(self.command)
                .args(self.args)
                .stdout(Stdio::null())
                .spawn()
        }
    }
    #[cfg(unix)]
    fn spawner(
        command: &'static str,
        args: &'static [&'static str],
    ) -> (SleepSpawner, Arc<AtomicUsize>, Arc<Mutex<Vec<String>>>) {
        let spawned = Arc::new(AtomicUsize::new(0));
        let hosts = Arc::new(Mutex::new(Vec::new()));
        (
            SleepSpawner {
                spawned: spawned.clone(),
                hosts: hosts.clone(),
                command,
                args,
            },
            spawned,
            hosts,
        )
    }
    fn no_sleep() -> impl Fn(Duration) {
        |_| std::thread::sleep(Duration::from_millis(5))
    }

    #[cfg(unix)]
    #[test]
    fn already_running_is_left_alone() {
        let m = Mock::start(|_| Reply::json(200, r#"{"version":"1"}"#));
        let client = OllamaClient::new(m.base()).unwrap();
        let (sp, spawned, _) = spawner("sleep", &["30"]);
        let p = OllamaProcess::default();
        let out = p
            .start(
                &client,
                Path::new("ollama"),
                &sp,
                Duration::from_secs(1),
                Duration::from_millis(10),
                &no_sleep(),
            )
            .unwrap();
        assert_eq!(out, StartOutcome::AlreadyRunning);
        assert_eq!(spawned.load(Ordering::SeqCst), 0);
        assert!(!p.started_by_yadi());
        assert!(
            !p.stop_if_started(),
            "a server Yadi did not start is never stopped"
        );
    }

    #[cfg(unix)]
    #[test]
    fn start_waits_for_the_api_then_stop_kills_only_what_it_started() {
        // the API starts answering on the 4th request
        let hits = Arc::new(AtomicUsize::new(0));
        let h2 = hits.clone();
        let m = Mock::start(move |_| {
            if h2.fetch_add(1, Ordering::SeqCst) >= 3 {
                Reply::json(200, r#"{"version":"1"}"#)
            } else {
                Reply::json(503, "{}")
            }
        });
        let client = OllamaClient::new(m.base()).unwrap();
        let (sp, spawned, hosts) = spawner("sleep", &["30"]);
        let p = OllamaProcess::default();
        let out = p
            .start(
                &client,
                Path::new("ollama"),
                &sp,
                Duration::from_secs(5),
                Duration::from_millis(10),
                &no_sleep(),
            )
            .unwrap();
        assert_eq!(out, StartOutcome::Started);
        assert_eq!(spawned.load(Ordering::SeqCst), 1);
        assert_eq!(
            hosts.lock().unwrap().as_slice(),
            [m.base().trim_start_matches("http://").to_string()],
            "bound to the client's 127.0.0.1 address only"
        );
        assert!(p.started_by_yadi());
        assert!(p.stop_if_started());
        assert!(!p.started_by_yadi());
        assert!(!p.stop_if_started(), "second stop does nothing");
    }

    #[cfg(unix)]
    #[test]
    fn a_server_that_never_answers_times_out_and_is_killed() {
        let client = dead_client();
        let (sp, _, _) = spawner("sleep", &["30"]);
        let p = OllamaProcess::default();
        let err = p
            .start(
                &client,
                Path::new("ollama"),
                &sp,
                Duration::from_millis(100),
                Duration::from_millis(10),
                &no_sleep(),
            )
            .unwrap_err();
        assert!(err.contains("did not become ready"), "{err}");
        assert!(!p.started_by_yadi());
    }

    #[cfg(unix)]
    #[test]
    fn a_process_that_exits_immediately_is_reported() {
        let client = dead_client();
        let (sp, _, _) = spawner("false", &[]);
        let p = OllamaProcess::default();
        let err = p
            .start(
                &client,
                Path::new("ollama"),
                &sp,
                Duration::from_secs(5),
                Duration::from_millis(10),
                &no_sleep(),
            )
            .unwrap_err();
        assert!(err.contains("stopped right after starting"), "{err}");
    }

    #[test]
    fn a_missing_executable_is_a_readable_error() {
        struct Missing;
        impl Spawner for Missing {
            fn spawn(&self, exe: &Path, _host: &str) -> io::Result<Child> {
                Command::new(exe).spawn()
            }
        }
        let err = OllamaProcess::default()
            .start(
                &dead_client(),
                Path::new("/no/such/ollama-binary"),
                &Missing,
                Duration::from_secs(1),
                Duration::from_millis(10),
                &no_sleep(),
            )
            .unwrap_err();
        assert!(err.contains("could not start Ollama"), "{err}");
    }
}
