//! The custom vocabulary (Task 21): words and phrases the user wants Yadi to spell correctly
//! (names, jargon). Stored with tauri-plugin-store in `vocabulary.json`; the prompt pipeline uses
//! the first 100 as preferred spellings. Entries are only ever read by this app; they are never
//! logged.

use std::collections::HashSet;
use std::path::Path;

use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "vocabulary.json";
const STORE_KEY: &str = "words";
/// Entries kept in total (the pipeline reads the first 100 of them).
pub const MAX_ENTRIES: usize = 500;
/// Longest entry, in characters.
pub const MAX_ENTRY_CHARS: usize = 80;
/// Largest file accepted for import.
pub const MAX_IMPORT_BYTES: u64 = 1024 * 1024;

/// Trims, collapses spaces, removes control characters, cuts long entries, drops blanks and
/// repeats (ignoring case; the first spelling wins) and keeps at most `MAX_ENTRIES`.
pub fn normalize(words: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for raw in words {
        let cleaned: String = raw.chars().filter(|c| !c.is_control()).collect();
        let word: String = cleaned
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(MAX_ENTRY_CHARS)
            .collect();
        let word = word.trim().to_string();
        if word.is_empty() || !seen.insert(word.to_lowercase()) {
            continue;
        }
        out.push(word);
        if out.len() == MAX_ENTRIES {
            break;
        }
    }
    out
}

/// One word per line; blank lines and lines starting with `#` are ignored.
pub fn parse_text(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(str::to_string)
        .collect()
}

pub fn to_text(words: &[String]) -> String {
    let mut out = words.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    out
}

pub fn load(app: &AppHandle) -> Vec<String> {
    app.store(STORE_FILE)
        .ok()
        .and_then(|s| s.get(STORE_KEY))
        .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
        .map(normalize)
        .unwrap_or_default()
}

fn save(app: &AppHandle, words: &[String]) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(
        STORE_KEY,
        serde_json::to_value(words).map_err(|e| e.to_string())?,
    );
    store.save().map_err(|e| e.to_string())
}

pub fn clear(app: &AppHandle) -> Result<(), String> {
    save(app, &[])
}

#[tauri::command]
pub fn get_vocabulary(app: AppHandle) -> Vec<String> {
    load(&app)
}

/// Replaces the whole list (add, edit and delete are done by the caller on its copy).
#[tauri::command]
pub fn set_vocabulary(app: AppHandle, words: Vec<String>) -> Result<Vec<String>, String> {
    let words = normalize(words);
    save(&app, &words)?;
    Ok(words)
}

/// Adds one word (from "Remember it for next time?"). Returns the whole list.
#[tauri::command]
pub fn add_vocabulary(app: AppHandle, word: String) -> Result<Vec<String>, String> {
    let mut words = load(&app);
    words.push(word);
    let words = normalize(words);
    save(&app, &words)?;
    Ok(words)
}

/// Reads a plain `.txt` (one entry per line) and adds its entries to the list.
#[tauri::command]
pub async fn vocabulary_import(app: AppHandle, path: String) -> Result<Vec<String>, String> {
    let text = tauri::async_runtime::spawn_blocking(move || read_import(Path::new(&path)))
        .await
        .map_err(|_| "The file could not be read.".to_string())??;
    let mut words = load(&app);
    words.extend(parse_text(&text));
    let words = normalize(words);
    save(&app, &words)?;
    Ok(words)
}

fn read_import(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|_| "The file could not be read.".to_string())?;
    if !meta.is_file() {
        return Err("That is not a file.".into());
    }
    if meta.len() > MAX_IMPORT_BYTES {
        return Err("That file is too big for a word list (1 MB at most).".into());
    }
    let bytes = std::fs::read(path).map_err(|_| "The file could not be read.".to_string())?;
    if bytes.contains(&0) {
        return Err("That does not look like a text file.".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Writes the list as a plain `.txt`, one entry per line.
#[tauri::command]
pub async fn vocabulary_export(app: AppHandle, path: String) -> Result<(), String> {
    let text = to_text(&load(&app));
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::write(path, text).map_err(|_| "The file could not be saved.".to_string())
    })
    .await
    .map_err(|_| "The file could not be saved.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(words: &[&str]) -> Vec<String> {
        normalize(words.iter().map(|w| w.to_string()))
    }

    #[test]
    fn trims_collapses_and_drops_blanks() {
        assert_eq!(
            n(&["  Yadi ", "", "   ", "Elara   Software"]),
            ["Yadi", "Elara Software"]
        );
    }

    #[test]
    fn repeats_are_dropped_ignoring_case_and_the_first_spelling_wins() {
        assert_eq!(
            n(&["Kubernetes", "kubernetes", "KUBERNETES", "Postgres"]),
            ["Kubernetes", "Postgres"]
        );
    }

    #[test]
    fn control_characters_are_removed_and_long_entries_cut() {
        assert_eq!(n(&["Ya\u{7}di\n"]), ["Yadi"]);
        let long = "x".repeat(200);
        assert_eq!(n(&[&long])[0].chars().count(), MAX_ENTRY_CHARS);
    }

    #[test]
    fn the_list_is_capped() {
        let many: Vec<String> = (0..MAX_ENTRIES + 50).map(|i| format!("word{i}")).collect();
        let kept = normalize(many);
        assert_eq!(kept.len(), MAX_ENTRIES);
        assert_eq!(kept[0], "word0");
    }

    #[test]
    fn text_files_ignore_blank_lines_and_comments() {
        assert_eq!(
            parse_text("# my words\nYadi\n\n  Elara  \n#skip\r\nOllama\r\n"),
            ["Yadi", "Elara", "Ollama"]
        );
    }

    #[test]
    fn export_then_import_gives_the_same_list() {
        let words = n(&["Yadi", "Elara Software", "Ollama"]);
        assert_eq!(normalize(parse_text(&to_text(&words))), words);
        assert_eq!(to_text(&[]), "");
    }

    #[test]
    fn import_refuses_big_binary_and_missing_files() {
        let dir = std::env::temp_dir().join(format!("yadi-vocab-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let ok = dir.join("ok.txt");
        std::fs::write(&ok, "a\nb\n").unwrap();
        assert_eq!(read_import(&ok).unwrap(), "a\nb\n");
        let bin = dir.join("bin.txt");
        std::fs::write(&bin, [b'a', 0, b'b']).unwrap();
        assert!(read_import(&bin).is_err());
        let big = dir.join("big.txt");
        std::fs::File::create(&big)
            .unwrap()
            .set_len(MAX_IMPORT_BYTES + 1)
            .unwrap();
        assert!(read_import(&big).unwrap_err().contains("too big"));
        assert!(read_import(&dir.join("missing.txt")).is_err());
        assert!(read_import(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
