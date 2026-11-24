//! A small blocking HTTP client for the parts of the Ollama API Yadi needs from Rust:
//! version, tag list and streamed model pulls. (The prompt pipeline calls `/api/chat` itself,
//! from TypeScript, through the HTTP plugin.)

use std::io::Read;
use std::time::Duration;

use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::ndjson::NdjsonDecoder;
use crate::download::CancelToken;

/// Ollama's default address. Yadi never binds or connects anywhere else.
pub const DEFAULT_BASE: &str = "http://127.0.0.1:11434";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalModel {
    pub name: String,
    #[serde(default)]
    pub size: u64,
}

/// One progress record of a pull (`ollama:pull` event payload).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PullEvent {
    pub status: String,
    pub completed: Option<u64>,
    pub total: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PullError {
    Cancelled,
    /// Ollama reported an error (unknown model, no disk space, no network, ...).
    Ollama(String),
    /// Could not talk to Ollama at all.
    Unreachable(String),
}

impl std::fmt::Display for PullError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PullError::Cancelled => f.write_str("The download was cancelled."),
            PullError::Ollama(m) => write!(f, "Ollama could not download the model: {m}"),
            PullError::Unreachable(m) => write!(f, "Cannot reach Ollama: {m}"),
        }
    }
}

pub struct OllamaClient {
    base: String,
    quick: Client,
    streaming: Client,
}

impl OllamaClient {
    pub fn new(base: impl Into<String>) -> Result<Self, String> {
        let build = |timeout: Option<Duration>| {
            Client::builder()
                .user_agent("Yadi")
                .connect_timeout(Duration::from_secs(2))
                .timeout(timeout)
                // Ollama is local; never go through a system proxy for it.
                .no_proxy()
                .build()
                .map_err(|e| e.to_string())
        };
        Ok(Self {
            base: base.into().trim_end_matches('/').to_string(),
            quick: build(Some(Duration::from_secs(5)))?,
            streaming: build(None)?,
        })
    }

    pub fn local() -> Result<Self, String> {
        Self::new(DEFAULT_BASE)
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    fn get_json<T: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<T, String> {
        let body = self
            .quick
            .get(format!("{}{path}", self.base))
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.text())
            .map_err(|e| e.to_string())?;
        serde_json::from_str(&body).map_err(|e| format!("unexpected answer from Ollama: {e}"))
    }

    /// `GET /api/version`: the running server's version.
    pub fn version(&self) -> Result<String, String> {
        let v: Value = self.get_json("/api/version")?;
        v.get("version")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "the answer has no version".to_string())
    }

    /// `GET /api/tags`: the models already on this machine.
    pub fn list(&self) -> Result<Vec<LocalModel>, String> {
        #[derive(Deserialize)]
        struct Tags {
            #[serde(default)]
            models: Vec<LocalModel>,
        }
        let tags: Tags = self.get_json("/api/tags")?;
        Ok(tags.models)
    }

    /// Whether `tag` is installed. A bare name means `:latest`, like Ollama itself.
    pub fn has(&self, tag: &str) -> Result<bool, String> {
        let wanted = normalise_tag(tag);
        Ok(self
            .list()?
            .iter()
            .any(|m| normalise_tag(&m.name) == wanted))
    }

    /// `POST /api/pull` with streaming. Calling it again resumes: Ollama keeps partial blobs.
    pub fn pull(
        &self,
        tag: &str,
        on_event: &mut dyn FnMut(PullEvent),
        cancel: &CancelToken,
    ) -> Result<(), PullError> {
        let mut response = self
            .streaming
            .post(format!("{}/api/pull", self.base))
            .header("Content-Type", "application/json")
            .body(json!({ "model": tag, "stream": true }).to_string())
            .send()
            .map_err(|e| PullError::Unreachable(e.to_string()))?;
        if !response.status().is_success() {
            // Ollama answers 4xx/5xx with a JSON {"error": ...} body.
            let status = response.status();
            let body = response.text().unwrap_or_default();
            let msg = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_string))
                .unwrap_or_else(|| format!("HTTP {}", status.as_u16()));
            return Err(PullError::Ollama(msg));
        }

        let mut decoder = NdjsonDecoder::new();
        let mut finished = false;
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            if cancel.is_cancelled() {
                return Err(PullError::Cancelled);
            }
            let n = response
                .read(&mut buf)
                .map_err(|e| PullError::Unreachable(format!("the connection broke: {e}")))?;
            let lines = if n == 0 {
                decoder.finish().into_iter().collect()
            } else {
                decoder.push(&buf[..n])
            };
            for line in lines {
                let Ok(value) = line else { continue };
                if let Some(err) = value.get("error").and_then(Value::as_str) {
                    return Err(PullError::Ollama(err.to_string()));
                }
                let status = value.get("status").and_then(Value::as_str).unwrap_or("");
                if status == "success" {
                    finished = true;
                }
                on_event(PullEvent {
                    status: status.to_string(),
                    completed: value.get("completed").and_then(Value::as_u64),
                    total: value.get("total").and_then(Value::as_u64),
                });
            }
            if n == 0 {
                break;
            }
        }
        if finished {
            Ok(())
        } else {
            Err(PullError::Unreachable(
                "the download ended before Ollama reported success".into(),
            ))
        }
    }
}

/// `llama3` and `llama3:latest` are the same model.
pub fn normalise_tag(tag: &str) -> String {
    let t = tag.trim().to_ascii_lowercase();
    if t.contains(':') {
        t
    } else {
        format!("{t}:latest")
    }
}

#[cfg(test)]
mod tests {
    use super::super::mock::{Mock, Reply};
    use super::*;

    fn client(m: &Mock) -> OllamaClient {
        OllamaClient::new(m.base()).unwrap()
    }

    #[test]
    fn version_is_read_from_the_api() {
        let m = Mock::start(|req| {
            assert_eq!(req.path, "/api/version");
            Reply::json(200, r#"{"version":"0.9.9"}"#)
        });
        assert_eq!(client(&m).version().unwrap(), "0.9.9");
    }

    #[test]
    fn version_errors_when_nothing_is_listening() {
        // a port that was just closed
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        assert!(
            OllamaClient::new(format!("http://127.0.0.1:{port}"))
                .unwrap()
                .version()
                .is_err()
        );
    }

    #[test]
    fn list_and_has_understand_latest() {
        let m = Mock::start(|_| {
            Reply::json(
                200,
                r#"{"models":[{"name":"qwen3:4b","size":2500000000},{"name":"llama3:latest","size":1}]}"#,
            )
        });
        let c = client(&m);
        let list = c.list().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(
            list[0],
            LocalModel {
                name: "qwen3:4b".into(),
                size: 2_500_000_000
            }
        );
        assert!(c.has("qwen3:4b").unwrap());
        assert!(c.has("QWEN3:4B").unwrap());
        assert!(c.has("llama3").unwrap(), "a bare name means :latest");
        assert!(!c.has("qwen3:8b").unwrap());
    }

    #[test]
    fn an_empty_or_missing_models_list_is_fine() {
        let m = Mock::start(|_| Reply::json(200, "{}"));
        assert!(client(&m).list().unwrap().is_empty());
    }

    #[test]
    fn pull_parses_a_stream_with_lines_split_across_chunks() {
        let body = concat!(
            "{\"status\":\"pulling manifest\"}\n",
            "{\"status\":\"pulling abc123\",\"digest\":\"sha256:abc123\",\"total\":1000,\"completed\":250}\n",
            "{\"status\":\"pulling abc123\",\"digest\":\"sha256:abc123\",\"total\":1000,\"completed\":1000}\n",
            "{\"status\":\"verifying sha256 digest\"}\n",
            "{\"status\":\"success\"}\n",
        );
        let m = Mock::start(move |req| {
            assert_eq!(req.method, "POST");
            assert_eq!(req.path, "/api/pull");
            let sent: Value = serde_json::from_str(&req.body).unwrap();
            assert_eq!(sent["model"], "qwen3:4b");
            assert_eq!(sent["stream"], true);
            // cut the body into awkward 17-byte pieces, so almost every line is split
            Reply::chunks(
                200,
                body.as_bytes().chunks(17).map(<[u8]>::to_vec).collect(),
            )
        });
        let mut events = Vec::new();
        client(&m)
            .pull("qwen3:4b", &mut |e| events.push(e), &CancelToken::new())
            .unwrap();
        let statuses: Vec<&str> = events.iter().map(|e| e.status.as_str()).collect();
        assert_eq!(
            statuses,
            [
                "pulling manifest",
                "pulling abc123",
                "pulling abc123",
                "verifying sha256 digest",
                "success"
            ]
        );
        assert_eq!(
            (events[1].completed, events[1].total),
            (Some(250), Some(1000))
        );
        assert_eq!(
            (events[2].completed, events[2].total),
            (Some(1000), Some(1000))
        );
        assert_eq!(events[0].completed, None);
    }

    #[test]
    fn pull_reports_an_error_line_from_ollama() {
        let m = Mock::start(|_| {
            Reply::chunks(
                200,
                vec![
                    b"{\"status\":\"pulling manifest\"}\n".to_vec(),
                    b"{\"error\":\"pull model manifest: file does not exist\"}\n".to_vec(),
                ],
            )
        });
        let err = client(&m)
            .pull("nope:1b", &mut |_| {}, &CancelToken::new())
            .unwrap_err();
        assert_eq!(
            err,
            PullError::Ollama("pull model manifest: file does not exist".into())
        );
        assert!(err.to_string().contains("file does not exist"));
    }

    #[test]
    fn pull_reports_an_http_error_body() {
        let m = Mock::start(|_| Reply::json(500, r#"{"error":"disk full"}"#));
        let err = client(&m)
            .pull("x:1", &mut |_| {}, &CancelToken::new())
            .unwrap_err();
        assert_eq!(err, PullError::Ollama("disk full".into()));
    }

    #[test]
    fn a_stream_that_ends_without_success_is_an_error() {
        let m = Mock::start(|_| {
            Reply::chunks(200, vec![b"{\"status\":\"pulling manifest\"}\n".to_vec()])
        });
        let err = client(&m)
            .pull("x:1", &mut |_| {}, &CancelToken::new())
            .unwrap_err();
        assert!(matches!(err, PullError::Unreachable(_)), "{err:?}");
    }

    #[test]
    fn cancel_stops_a_pull() {
        let m = Mock::start(|_| {
            let line = b"{\"status\":\"pulling x\",\"total\":10,\"completed\":1}\n".to_vec();
            Reply::chunks(200, vec![line; 50]).with_delay_ms(10)
        });
        let cancel = CancelToken::new();
        let c2 = cancel.clone();
        let mut seen = 0;
        let err = client(&m)
            .pull(
                "x:1",
                &mut |_| {
                    seen += 1;
                    if seen == 3 {
                        c2.cancel();
                    }
                },
                &cancel,
            )
            .unwrap_err();
        assert_eq!(err, PullError::Cancelled);
        assert!((3..50).contains(&seen), "stopped early after {seen} events");
    }

    #[test]
    fn pulling_again_after_a_failure_just_asks_again() {
        // resumable by re-calling: the client holds no state between calls
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let c2 = calls.clone();
        let m = Mock::start(move |_| {
            if c2.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                Reply::chunks(
                    200,
                    vec![b"{\"status\":\"pulling a\",\"total\":10,\"completed\":4}\n".to_vec()],
                )
            } else {
                Reply::chunks(
                    200,
                    vec![b"{\"status\":\"pulling a\",\"total\":10,\"completed\":10}\n{\"status\":\"success\"}\n".to_vec()],
                )
            }
        });
        let c = client(&m);
        assert!(c.pull("a:1", &mut |_| {}, &CancelToken::new()).is_err());
        assert!(c.pull("a:1", &mut |_| {}, &CancelToken::new()).is_ok());
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[test]
    fn tag_normalisation() {
        assert_eq!(normalise_tag("Llama3"), "llama3:latest");
        assert_eq!(normalise_tag(" qwen3:4b "), "qwen3:4b");
    }

    /// Optional: uses the Ollama that is already running on this machine, read-only (it lists
    /// models, it never pulls or installs anything). Skips with a message when none is running.
    #[test]
    fn a_locally_running_ollama_reports_running_and_lists_models() {
        let c = OllamaClient::local().unwrap();
        let Ok(version) = c.version() else {
            eprintln!("SKIPPED: no Ollama is running on {DEFAULT_BASE}");
            return;
        };
        let status = crate::ollama::process::status(&c, None);
        assert_eq!(
            status,
            crate::ollama::process::Status::Running {
                version: version.clone()
            }
        );
        let models = c.list().expect("list works against the real server");
        // only the count is printed: which models a person has is theirs
        println!(
            "LOCAL OLLAMA: version {version}, {} model(s) installed",
            models.len()
        );
        assert!(
            c.has("definitely-not-a-real-model:0b")
                .map(|h| !h)
                .unwrap_or(false)
        );
    }
}
