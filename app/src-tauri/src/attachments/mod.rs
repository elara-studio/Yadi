//! Attachments (Task 20): turns a dropped or pasted file into plain text for the prompt pipeline.
//!
//! Safety rules: a file is never executed or opened by another program; folders are refused (so
//! nothing is traversed); a dropped symlink is resolved once, to its own target, and nothing else
//! is followed; size, time and expanded-size limits apply to every type; control characters are
//! removed. Nothing is written to disk and nothing here logs file names or contents (D12).

pub mod commands;
mod docx;
mod pdf;

use serde::Serialize;
use std::fs::File;
use std::io::Read;
use std::path::Path;

/// Largest file accepted (also checked in the chat window, which shows a friendly message).
pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
/// Most characters of text kept from one attachment; the rest is cut and `truncated` is set.
pub const MAX_TEXT_CHARS: usize = 1_000_000;
/// How long PDF extraction may run before it is given up on.
pub const PDF_TIMEOUT_SECS: u64 = 15;
/// Largest `word/document.xml` we will expand (zip-bomb guard).
pub const MAX_DOCX_XML_BYTES: u64 = 25 * 1024 * 1024;

/// Extensions read as UTF-8 text.
const TEXT_EXTENSIONS: &[&str] = &[
    "txt",
    "md",
    "markdown",
    "csv",
    "tsv",
    "json",
    "jsonl",
    "log",
    "yaml",
    "yml",
    "toml",
    "ini",
    "cfg",
    "conf",
    "xml",
    "html",
    "htm",
    "css",
    "scss",
    "js",
    "mjs",
    "cjs",
    "jsx",
    "ts",
    "tsx",
    "py",
    "rs",
    "go",
    "java",
    "kt",
    "kts",
    "swift",
    "c",
    "h",
    "cc",
    "cpp",
    "hpp",
    "cs",
    "rb",
    "php",
    "sh",
    "bash",
    "zsh",
    "ps1",
    "bat",
    "sql",
    "r",
    "lua",
    "dart",
    "scala",
    "gradle",
    "properties",
    "tex",
    "rst",
    "env",
];

/// Extensions that are known not to be readable text (shown as "not supported yet").
const UNSUPPORTED_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif", "ico", "svg", "mp3",
    "wav", "m4a", "flac", "ogg", "mp4", "mov", "avi", "mkv", "webm", "zip", "tar", "gz", "bz2",
    "7z", "rar", "exe", "dll", "dmg", "pkg", "app", "so", "dylib", "bin", "iso", "doc", "xls",
    "xlsx", "ppt", "pptx", "pages", "numbers", "key", "odt", "rtf", "epub", "psd", "ai", "sketch",
    "fig", "ttf", "otf", "woff", "woff2", "class", "jar", "o", "a",
];

/// A finished attachment: what the chat window keeps and sends to the pipeline.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Extracted {
    pub name: String,
    /// Short label shown on the chip and in `[Attached: name (type)]`, e.g. "pdf" or "text".
    pub type_label: String,
    pub size_bytes: u64,
    pub text: String,
    /// True when the text was cut at `MAX_TEXT_CHARS`.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorKind {
    TooLarge,
    Unsupported,
    Binary,
    Empty,
    Folder,
    Unreadable,
    Timeout,
    ZipBomb,
}

/// Serialised as `{kind, message}`; the message is meant to be shown to the user as is.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AttachmentError {
    pub kind: ErrorKind,
    pub message: String,
}

impl AttachmentError {
    fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

/// How a file is read, chosen from its extension (and a look at its bytes when it has none we know).
#[derive(Debug, Clone, Copy, PartialEq)]
enum Kind {
    Text,
    Pdf,
    Docx,
}

fn extension(name: &str) -> Option<String> {
    let (stem, ext) = name.rsplit_once('.')?;
    if stem.is_empty() || ext.is_empty() {
        return None;
    }
    Some(ext.to_ascii_lowercase())
}

fn classify(name: &str, bytes: &[u8]) -> Result<(Kind, String), AttachmentError> {
    let unsupported = |what: &str| {
        AttachmentError::new(
            ErrorKind::Unsupported,
            format!("{what} is not supported yet."),
        )
    };
    match extension(name).as_deref() {
        Some("pdf") => Ok((Kind::Pdf, "pdf".into())),
        Some("docx") => Ok((Kind::Docx, "docx".into())),
        Some(ext) if TEXT_EXTENSIONS.contains(&ext) => Ok((Kind::Text, ext.to_string())),
        Some(ext) if UNSUPPORTED_EXTENSIONS.contains(&ext) => {
            Err(unsupported(&format!("This kind of file (.{ext})")))
        }
        // Unknown or no extension: accept it only if it looks like text.
        other => {
            if looks_binary(bytes) {
                Err(unsupported("This kind of file"))
            } else {
                Ok((
                    Kind::Text,
                    other.map_or_else(|| "text".to_string(), str::to_string),
                ))
            }
        }
    }
}

/// A NUL byte in the first 8 KB means this is not text.
fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|&b| b == 0)
}

/// Removes characters that could hide or inject something: control characters other than newline
/// and tab (CR is dropped, so CRLF becomes LF), bidirectional overrides and zero-width marks.
pub fn sanitize(text: &str) -> String {
    text.chars()
        .filter(|&c| match c {
            '\n' | '\t' => true,
            '\r' => false,
            c if c.is_control() => false,
            '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' => false,
            '\u{200B}' | '\u{200C}' | '\u{200E}' | '\u{200F}' | '\u{2060}' | '\u{FEFF}' => false,
            _ => true,
        })
        .collect()
}

fn too_large(size: u64) -> AttachmentError {
    AttachmentError::new(
        ErrorKind::TooLarge,
        format!(
            "This file is {:.1} MB; the limit is {} MB per file.",
            size as f64 / 1_048_576.0,
            MAX_FILE_BYTES / 1_048_576
        ),
    )
}

/// Extracts the text of a file given as bytes (a pasted file, or one already read from disk).
pub fn extract_from_bytes(name: &str, bytes: &[u8]) -> Result<Extracted, AttachmentError> {
    let size = bytes.len() as u64;
    if size > MAX_FILE_BYTES {
        return Err(too_large(size));
    }
    let (kind, type_label) = classify(name, bytes)?;
    let raw = match kind {
        Kind::Text => {
            if looks_binary(bytes) {
                return Err(AttachmentError::new(
                    ErrorKind::Binary,
                    "This file looks like a binary file, not text.",
                ));
            }
            String::from_utf8_lossy(bytes).into_owned()
        }
        Kind::Pdf => pdf::extract(bytes)?,
        Kind::Docx => docx::extract(bytes)?,
    };
    let clean = sanitize(&raw);
    let trimmed = clean.trim();
    if trimmed.is_empty() {
        return Err(AttachmentError::new(
            ErrorKind::Empty,
            if kind == Kind::Pdf {
                "No text found in this PDF (a scanned PDF has only pictures of text)."
            } else {
                "This file has no text in it."
            },
        ));
    }
    let (text, truncated) = truncate_chars(trimmed, MAX_TEXT_CHARS);
    Ok(Extracted {
        name: display_name(name),
        type_label,
        size_bytes: size,
        text,
        truncated,
    })
}

fn truncate_chars(text: &str, max: usize) -> (String, bool) {
    match text.char_indices().nth(max) {
        Some((byte, _)) => (text[..byte].to_string(), true),
        None => (text.to_string(), false),
    }
}

/// The file name without any folders, with control characters removed.
fn display_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let clean = sanitize(last).replace(['\n', '\t'], " ");
    let clean = clean.trim();
    if clean.is_empty() {
        "attachment".to_string()
    } else {
        clean.chars().take(200).collect()
    }
}

/// Extracts the text of a file on disk (a dropped file).
pub fn extract_from_path(path: &Path) -> Result<Extracted, AttachmentError> {
    let unreadable = |what: &str| AttachmentError::new(ErrorKind::Unreadable, what.to_string());
    let link =
        std::fs::symlink_metadata(path).map_err(|_| unreadable("This file could not be found."))?;
    // A dropped symlink is resolved once, to its own target. Nothing inside it is followed.
    let real = if link.file_type().is_symlink() {
        std::fs::canonicalize(path).map_err(|_| unreadable("This link points to nothing."))?
    } else {
        path.to_path_buf()
    };
    let meta = std::fs::metadata(&real).map_err(|_| unreadable("This file could not be read."))?;
    if meta.is_dir() {
        return Err(AttachmentError::new(
            ErrorKind::Folder,
            "Folders cannot be attached. Drop the files themselves.",
        ));
    }
    if !meta.is_file() {
        return Err(AttachmentError::new(
            ErrorKind::Unsupported,
            "This is not a regular file.",
        ));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(too_large(meta.len())); // refused before a single byte is read
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    // Read at most one byte over the limit, in case the file grew after the check.
    File::open(&real)
        .and_then(|f| f.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|_| unreadable("This file could not be read."))?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("attachment");
    extract_from_bytes(name, &bytes)
}

#[cfg(test)]
mod tests;
