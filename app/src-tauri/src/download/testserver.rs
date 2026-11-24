//! A tiny HTTP/1.1 server for the downloader tests (std only). It serves one body and can
//! honour or ignore `Range`, cut a response short, fail with 503, or answer a fixed status.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;

#[derive(Clone)]
pub struct ServerConfig {
    pub body: Vec<u8>,
    /// Send the headers for the whole body but close the connection after this many bytes,
    /// on the first full-body response only (simulates a dropped connection).
    pub cut_first_response_after: Option<usize>,
    /// Answer every request with 200 and the whole body, ignoring `Range`.
    pub ignore_range: bool,
    /// Answer the first N requests with 503.
    pub fail_first: usize,
    /// Answer every request with this status and an empty body.
    pub status_override: Option<u16>,
}

impl ServerConfig {
    pub fn new(body: Vec<u8>) -> Self {
        Self {
            body,
            cut_first_response_after: None,
            ignore_range: false,
            fail_first: 0,
            status_override: None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct RecordedRequest {
    pub range: Option<String>,
}

pub struct Server {
    port: u16,
    log: Arc<Mutex<Vec<RecordedRequest>>>,
}

impl Server {
    pub fn start(config: ServerConfig) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let log: Arc<Mutex<Vec<RecordedRequest>>> = Arc::default();
        let state = Arc::new(Mutex::new((config, 0usize, false))); // (config, requests seen, cut used)
        let log2 = log.clone();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { break };
                let state = state.clone();
                let log = log2.clone();
                thread::spawn(move || handle(stream, &state, &log));
            }
        });
        Server { port, log }
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/model.bin", self.port)
    }

    pub fn requests(&self) -> Vec<RecordedRequest> {
        self.log.lock().unwrap().clone()
    }
}

fn handle(
    mut stream: TcpStream,
    state: &Mutex<(ServerConfig, usize, bool)>,
    log: &Mutex<Vec<RecordedRequest>>,
) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut range = None;
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        let l = line.trim_end();
        if l.is_empty() {
            break;
        }
        if let Some(v) = l.to_ascii_lowercase().strip_prefix("range:") {
            range = Some(v.trim().to_string());
        }
    }
    log.lock().unwrap().push(RecordedRequest {
        range: range.clone(),
    });

    let (cfg, seen, cut_used) = {
        let mut s = state.lock().unwrap();
        s.1 += 1;
        (s.0.clone(), s.1, s.2)
    };

    if let Some(code) = cfg.status_override {
        let _ = write!(
            stream,
            "HTTP/1.1 {code} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        return;
    }
    if seen <= cfg.fail_first {
        let _ = write!(
            stream,
            "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        return;
    }

    let total = cfg.body.len();
    let start = if cfg.ignore_range {
        None
    } else {
        range
            .as_deref()
            .and_then(|r| r.strip_prefix("bytes="))
            .and_then(|r| r.split('-').next())
            .and_then(|s| s.parse::<usize>().ok())
    };

    match start {
        Some(s) if s >= total => {
            let _ = write!(
                stream,
                "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{total}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
        }
        Some(s) => {
            let body = &cfg.body[s..];
            let _ = write!(
                stream,
                "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {s}-{}/{total}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                total - 1,
                body.len()
            );
            let _ = stream.write_all(body);
        }
        None => {
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {total}\r\nConnection: close\r\n\r\n"
            );
            match cfg.cut_first_response_after {
                Some(n) if !cut_used => {
                    state.lock().unwrap().2 = true;
                    let _ = stream.write_all(&cfg.body[..n]);
                    let _ = stream.flush();
                    // dropping the stream closes it before the declared length was sent
                }
                _ => {
                    let _ = stream.write_all(&cfg.body);
                }
            }
        }
    }
    let _ = stream.flush();
}
