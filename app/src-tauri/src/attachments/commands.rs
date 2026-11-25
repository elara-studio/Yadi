//! Tauri commands for attachments. The file name and contents never reach the log.

use super::{AttachmentError, ErrorKind, Extracted, extract_from_bytes, extract_from_path};
use std::path::PathBuf;
use tauri::ipc::{InvokeBody, Request};

/// Reads a dropped file by path.
#[tauri::command]
pub async fn attachment_from_path(path: String) -> Result<Extracted, AttachmentError> {
    tauri::async_runtime::spawn_blocking(move || extract_from_path(&PathBuf::from(path)))
        .await
        .map_err(|_| AttachmentError {
            kind: ErrorKind::Unreadable,
            message: "This file could not be read.".into(),
        })?
}

/// Reads a pasted file. The body is the raw file; the name travels in the `x-file-name` header,
/// percent-encoded.
#[tauri::command]
pub async fn attachment_from_bytes(request: Request<'_>) -> Result<Extracted, AttachmentError> {
    let name = request
        .headers()
        .get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .unwrap_or_else(|| "attachment".to_string());
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(AttachmentError {
            kind: ErrorKind::Unreadable,
            message: "The pasted file could not be read.".into(),
        });
    };
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || extract_from_bytes(&name, &bytes))
        .await
        .map_err(|_| AttachmentError {
            kind: ErrorKind::Unreadable,
            message: "This file could not be read.".into(),
        })?
}

/// Decodes `%XX` sequences (what JavaScript's `encodeURIComponent` produces). Invalid sequences
/// are kept as they are.
pub(super) fn percent_decode(s: &str) -> String {
    fn hex(b: u8) -> Option<u8> {
        (b as char).to_digit(16).map(|d| d as u8)
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let pair = (bytes[i] == b'%' && i + 2 < bytes.len())
            .then(|| (hex(bytes[i + 1]), hex(bytes[i + 2])));
        if let Some((Some(hi), Some(lo))) = pair {
            out.push(hi * 16 + lo);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::percent_decode;

    #[test]
    fn decodes_what_encode_uri_component_makes() {
        assert_eq!(percent_decode("my%20file%20%281%29.txt"), "my file (1).txt");
        assert_eq!(percent_decode("caf%C3%A9.md"), "café.md");
    }

    #[test]
    fn invalid_sequences_are_kept() {
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("a%zzb"), "a%zzb");
        assert_eq!(percent_decode("%4"), "%4");
        assert_eq!(percent_decode("é%é"), "é%é");
    }
}
