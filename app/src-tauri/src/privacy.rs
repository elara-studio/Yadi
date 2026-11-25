//! Privacy audit (rule D12), as a test: no `log::...!` call in the Rust sources may pass a
//! transcript, prompt, text, partial result or audio to the logger. The scanner reads every source
//! file, finds each logging macro and rejects an argument that names such data. String contents
//! are ignored, so a message may *mention* "audio" or "text"; it may not *include* them.

use std::fs;
use std::path::{Path, PathBuf};

const SENSITIVE: &[&str] = &[
    "transcript",
    "prompt",
    "text",
    "partial",
    "preview",
    "samples",
    "words",
    "vocabulary",
    "content",
    "attachment",
];

/// The argument text of every `log::<level>!(...)` call in `source`.
fn log_calls(source: &str) -> Vec<String> {
    let mut calls = Vec::new();
    let mut rest = source;
    while let Some(i) = rest.find("log::") {
        rest = &rest[i + 5..];
        let after_level = rest.trim_start_matches(|c: char| c.is_ascii_lowercase());
        if !after_level.starts_with("!(") {
            continue;
        }
        let args = &after_level[2..];
        let mut depth = 1;
        let mut end = args.len();
        let mut in_string = false;
        let mut escaped = false;
        for (idx, c) in args.char_indices() {
            if in_string {
                match (escaped, c) {
                    (true, _) => escaped = false,
                    (false, '\\') => escaped = true,
                    (false, '"') => in_string = false,
                    _ => {}
                }
                continue;
            }
            match c {
                '"' => in_string = true,
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        end = idx;
                        break;
                    }
                }
                _ => {}
            }
        }
        calls.push(args[..end].to_string());
    }
    calls
}

/// The identifiers a log call actually uses: inline `{name}` in the format string and every word
/// outside string literals.
fn used_names(args: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut outside = String::new();
    let mut chars = args.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '"' {
            let mut literal = String::new();
            while let Some(d) = chars.next() {
                match d {
                    '\\' => {
                        chars.next();
                    }
                    '"' => break,
                    _ => literal.push(d),
                }
            }
            // inline format arguments: {name} or {name:?}
            let mut rest = literal.as_str();
            while let Some(open) = rest.find('{') {
                rest = &rest[open + 1..];
                if rest.starts_with('{') {
                    rest = &rest[1..];
                    continue;
                }
                let name: String = rest
                    .chars()
                    .take_while(|c| c.is_alphanumeric() || *c == '_')
                    .collect();
                if !name.is_empty() {
                    names.push(name);
                }
            }
            outside.push(' ');
        } else {
            outside.push(c);
        }
    }
    names.extend(
        outside
            .split(|c: char| !(c.is_alphanumeric() || c == '_'))
            .filter(|w| !w.is_empty())
            .map(str::to_string),
    );
    names
}

/// `samples.len()` is a count, not the audio: drop `<name>.len()` before looking at names.
fn strip_len_calls(args: &str) -> String {
    let mut out = String::new();
    let mut rest = args;
    while let Some(i) = rest.find(".len()") {
        let before = &rest[..i];
        let keep = before.trim_end_matches(|c: char| c.is_alphanumeric() || c == '_' || c == '.');
        out.push_str(keep);
        rest = &rest[i + 6..];
    }
    out.push_str(rest);
    out
}

fn violations(source: &str) -> Vec<String> {
    log_calls(source)
        .into_iter()
        .map(|a| strip_len_calls(&a))
        .filter(|args| {
            used_names(args).iter().any(|n| {
                let n = n.to_lowercase();
                SENSITIVE
                    .iter()
                    .any(|s| n == *s || n.ends_with(&format!("_{s}")))
            })
        })
        .collect()
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).expect("read src").flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_scanner_flags_text_audio_and_prompt_arguments() {
        assert_eq!(violations(r#"log::info!("got {text}")"#).len(), 1);
        assert_eq!(violations(r#"log::warn!("x {}", transcript)"#).len(), 1);
        assert_eq!(violations(r#"log::info!("x {prompt:?}")"#).len(), 1);
        assert_eq!(violations(r#"log::debug!("{}", final_text)"#).len(), 1);
        assert_eq!(violations(r#"log::info!("{}", self.partial)"#).len(), 1);
        assert_eq!(violations(r#"log::info!("{samples:?}")"#).len(), 1);
    }

    #[test]
    fn the_scanner_allows_messages_that_only_mention_those_words() {
        assert_eq!(
            violations(r#"log::info!("audio session ended")"#),
            Vec::<String>::new()
        );
        assert_eq!(
            violations(r#"log::info!("Counts only: never the text.")"#),
            Vec::<String>::new()
        );
        assert_eq!(
            violations(
                r#"log::info!("{} samples recorded, {level_updates} updates", buffer.len())"#
            ),
            Vec::<String>::new()
        );
        assert_eq!(
            violations(r#"log::warn!("failed: {e}")"#),
            Vec::<String>::new()
        );
        assert_eq!(
            violations(r#"log::info!("{{text}} is escaped")"#),
            Vec::<String>::new()
        );
    }

    #[test]
    fn the_scanner_reads_nested_parentheses_and_quotes() {
        let calls =
            log_calls(r#"log::info!("a (b) {}", f(g(1), ")"));  x(); log::warn!("second")"#);
        assert_eq!(calls.len(), 2);
        assert!(calls[0].contains("f(g(1)"));
    }

    #[test]
    fn no_rust_code_logs_a_transcript_prompt_text_or_audio() {
        let mut files = Vec::new();
        rust_files(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
            &mut files,
        );
        let mut bad = Vec::new();
        let mut calls = 0;
        for file in files {
            if file.ends_with("privacy.rs") {
                continue; // this file's own examples
            }
            let source = fs::read_to_string(&file).unwrap();
            calls += log_calls(&source).len();
            for v in violations(&source) {
                bad.push(format!("{}: log::...!({})", file.display(), v.trim()));
            }
        }
        assert!(
            calls > 20,
            "the scan should see the app's log calls, saw {calls}"
        );
        assert!(
            bad.is_empty(),
            "sensitive data reaches a log call:\n{}",
            bad.join("\n")
        );
    }

    // ---- network audit: where the app is allowed to talk to --------------------------------------

    fn host_of(url: &str) -> &str {
        url.strip_prefix("https://")
            .unwrap_or(url)
            .split('/')
            .next()
            .unwrap_or("")
    }

    /// Setup downloads come only from these hosts; nothing downloads during normal use.
    const DOWNLOAD_HOSTS: &[&str] = &["github.com", "ollama.com"];

    #[test]
    fn every_model_download_is_https_from_an_allowed_host() {
        let catalog = crate::models::Catalog::embedded().unwrap();
        let mut seen = 0;
        for model in &catalog.models {
            if let Some(url) = &model.url {
                assert!(url.starts_with("https://"), "{}: {url}", model.id);
                assert!(
                    DOWNLOAD_HOSTS.contains(&host_of(url)),
                    "{}: {url}",
                    model.id
                );
                seen += 1;
            }
        }
        assert!(seen >= 5, "the speech models are downloaded, saw {seen}");
    }

    #[test]
    fn the_ollama_installer_comes_from_ollama_com_over_https() {
        for url in [
            crate::ollama::install::MAC_URL,
            crate::ollama::install::WINDOWS_URL,
        ] {
            assert!(url.starts_with("https://"));
            assert_eq!(host_of(url), "ollama.com");
        }
    }

    #[test]
    fn the_http_plugin_may_only_reach_ollama_on_this_computer() {
        let caps: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let mut urls = Vec::new();
        for perm in caps["permissions"].as_array().unwrap() {
            if perm["identifier"] == "http:default" {
                for rule in perm["allow"].as_array().unwrap() {
                    urls.push(rule["url"].as_str().unwrap().to_string());
                }
                assert!(perm.get("deny").is_none() || perm["deny"].as_array().unwrap().is_empty());
            }
        }
        assert_eq!(urls, ["http://127.0.0.1:11434/*"]);
        // No other plugin that can reach the network is granted.
        let text = include_str!("../capabilities/default.json");
        for risky in ["shell:", "opener:", "websocket:", "fs:", "updater:"] {
            assert!(!text.contains(risky), "the capability file grants {risky}");
        }
    }

    #[test]
    fn the_content_security_policy_keeps_pages_from_reaching_the_internet() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let csp = conf["app"]["security"]["csp"].as_str().unwrap();
        assert!(csp.contains("default-src 'self'"));
        for part in csp.split(';').map(str::trim) {
            if let Some(sources) = part.strip_prefix("connect-src") {
                for source in sources.split_whitespace() {
                    assert!(
                        matches!(source, "ipc:" | "http://ipc.localhost" | "'self'"),
                        "connect-src allows {source}"
                    );
                }
            }
        }
        assert!(!csp.contains('*'), "no wildcard sources: {csp}");
        assert!(!csp.contains("https:"), "{csp}");
    }
}
