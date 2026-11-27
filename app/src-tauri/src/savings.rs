//! The local history of tokens Yadi saved (`savings.json`, tauri-plugin-store). Only numbers are
//! kept: when a prompt was made, the approximate tokens of the recorded message and of the
//! prompt. Never the words. Nothing leaves this computer.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "savings.json";
const STORE_KEY: &str = "savings";
/// Entries kept; older ones are folded into the totals, which always count everything.
pub const MAX_ENTRIES: usize = 2000;

/// One prompt: when it was made (ms since 1970) and its approximate token counts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavingsEntry {
    pub at: u64,
    pub tokens_in: u32,
    pub tokens_out: u32,
}

impl SavingsEntry {
    /// Tokens saved by this prompt; 0 when the prompt was not shorter.
    pub fn saved(&self) -> u64 {
        u64::from(self.tokens_in.saturating_sub(self.tokens_out))
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Savings {
    /// Every prompt ever recorded (including those no longer in `entries`).
    pub prompts: u64,
    pub total_in: u64,
    pub total_out: u64,
    /// Sum of each prompt's own saving (prompts that saved nothing add 0).
    pub total_saved: u64,
    /// The most recent prompts, oldest first.
    pub entries: Vec<SavingsEntry>,
}

impl Savings {
    /// Adds one prompt and keeps at most `MAX_ENTRIES` entries.
    pub fn record(&mut self, entry: SavingsEntry) {
        self.prompts += 1;
        self.total_in += u64::from(entry.tokens_in);
        self.total_out += u64::from(entry.tokens_out);
        self.total_saved += entry.saved();
        self.entries.push(entry);
        if self.entries.len() > MAX_ENTRIES {
            let extra = self.entries.len() - MAX_ENTRIES;
            self.entries.drain(..extra);
        }
    }
}

fn load(app: &AppHandle) -> Savings {
    app.store(STORE_FILE)
        .ok()
        .and_then(|s| s.get(STORE_KEY))
        .and_then(|v| serde_json::from_value::<Savings>(v).ok())
        .unwrap_or_default()
}

fn save(app: &AppHandle, savings: &Savings) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(
        STORE_KEY,
        serde_json::to_value(savings).map_err(|e| e.to_string())?,
    );
    store.save().map_err(|e| e.to_string())
}

pub fn clear(app: &AppHandle) -> Result<(), String> {
    save(app, &Savings::default())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Records one finished prompt's approximate token counts. Returns the updated history.
#[tauri::command]
pub fn savings_record(app: AppHandle, tokens_in: u32, tokens_out: u32) -> Result<Savings, String> {
    let mut savings = load(&app);
    savings.record(SavingsEntry {
        at: now_ms(),
        tokens_in,
        tokens_out,
    });
    save(&app, &savings)?;
    Ok(savings)
}

#[tauri::command]
pub fn get_savings(app: AppHandle) -> Savings {
    load(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(tokens_in: u32, tokens_out: u32) -> SavingsEntry {
        SavingsEntry {
            at: 1,
            tokens_in,
            tokens_out,
        }
    }

    #[test]
    fn a_shorter_prompt_saves_the_difference_and_a_longer_one_nothing() {
        assert_eq!(entry(120, 45).saved(), 75);
        assert_eq!(entry(20, 55).saved(), 0);
    }

    #[test]
    fn record_adds_up_totals() {
        let mut s = Savings::default();
        s.record(entry(120, 45));
        s.record(entry(20, 55));
        assert_eq!(s.prompts, 2);
        assert_eq!(s.total_in, 140);
        assert_eq!(s.total_out, 100);
        assert_eq!(s.total_saved, 75);
        assert_eq!(s.entries.len(), 2);
    }

    #[test]
    fn old_entries_are_dropped_but_totals_keep_counting() {
        let mut s = Savings::default();
        for i in 0..(MAX_ENTRIES as u32 + 5) {
            s.record(SavingsEntry {
                at: u64::from(i),
                tokens_in: 10,
                tokens_out: 4,
            });
        }
        assert_eq!(s.entries.len(), MAX_ENTRIES);
        assert_eq!(s.entries[0].at, 5); // the oldest five went
        assert_eq!(s.prompts, MAX_ENTRIES as u64 + 5);
        assert_eq!(s.total_saved, 6 * (MAX_ENTRIES as u64 + 5));
    }

    #[test]
    fn older_or_partial_files_still_load() {
        let s: Savings = serde_json::from_str(r#"{"total_saved": 9}"#).unwrap();
        assert_eq!(s.total_saved, 9);
        assert!(s.entries.is_empty());
    }
}
