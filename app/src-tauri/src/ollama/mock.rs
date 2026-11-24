//! A tiny scriptable HTTP/1.1 server for the Ollama tests (std only).

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

pub struct Req {
    pub method: String,
    pub path: String,
    pub body: String,
}

pub struct Reply {
    status: u16,
    chunks: Vec<Vec<u8>>,
    delay_ms: u64,
    content_type: &'static str,
}

impl Reply {
    pub fn json(status: u16, body: &str) -> Self {
        Self {
            status,
            chunks: vec![body.as_bytes().to_vec()],
            delay_ms: 0,
            content_type: "application/json",
        }
    }

    /// The body is written in these pieces, each flushed separately (chunked encoding), so the
    /// client really sees the stream arrive in awkward pieces.
    pub fn chunks(status: u16, chunks: Vec<Vec<u8>>) -> Self {
        Self {
            status,
            chunks,
            delay_ms: 0,
            content_type: "application/x-ndjson",
        }
    }

    pub fn with_delay_ms(mut self, ms: u64) -> Self {
        self.delay_ms = ms;
        self
    }
}

pub struct Mock {
    port: u16,
}

impl Mock {
    pub fn start(handler: impl Fn(&Req) -> Reply + Send + Sync + 'static) -> Mock {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handler = Arc::new(handler);
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { break };
                let handler = handler.clone();
                thread::spawn(move || serve(stream, &*handler));
            }
        });
        Mock { port }
    }

    pub fn base(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

fn serve(mut stream: TcpStream, handler: &dyn Fn(&Req) -> Reply) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut first = String::new();
    if reader.read_line(&mut first).unwrap_or(0) == 0 {
        return;
    }
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        let l = line.trim_end();
        if l.is_empty() {
            break;
        }
        if let Some(v) = l.to_ascii_lowercase().strip_prefix("content-length:") {
            content_length = v.trim().parse().unwrap_or(0);
        }
    }
    let mut body = vec![0u8; content_length];
    let _ = reader.read_exact(&mut body);
    let reply = handler(&Req {
        method,
        path,
        body: String::from_utf8_lossy(&body).into_owned(),
    });

    let _ = write!(
        stream,
        "HTTP/1.1 {} X\r\nContent-Type: {}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
        reply.status, reply.content_type
    );
    for chunk in &reply.chunks {
        if write!(stream, "{:x}\r\n", chunk.len()).is_err()
            || stream.write_all(chunk).is_err()
            || stream.write_all(b"\r\n").is_err()
            || stream.flush().is_err()
        {
            return; // the client hung up (e.g. cancelled)
        }
        if reply.delay_ms > 0 {
            thread::sleep(Duration::from_millis(reply.delay_ms));
        } else {
            thread::sleep(Duration::from_millis(1)); // let the pieces arrive separately
        }
    }
    let _ = stream.write_all(b"0\r\n\r\n");
    let _ = stream.flush();
}
