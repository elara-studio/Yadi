import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

function messageOf(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : "Something went wrong.";
}

/** Add, edit, delete, import and export the custom vocabulary (names and jargon). */
export function VocabularyEditor({ reloadKey = 0 }: { reloadKey?: number }) {
  const [words, setWords] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ index: number; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<string[]>("get_vocabulary").then(
      (w) => !cancelled && setWords(w ?? []),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  /** Saves the whole list; what Rust sends back (cleaned, no repeats) is what is shown. */
  const persist = async (next: string[]) => {
    setError(null);
    try {
      setWords(await invoke<string[]>("set_vocabulary", { words: next }));
    } catch (e) {
      setError(messageOf(e));
    }
  };

  const add = async () => {
    if (draft.trim() === "") return;
    await persist([...words, draft]);
    setDraft("");
  };

  const commitEdit = async () => {
    if (!editing) return;
    const next = words.map((w, i) => (i === editing.index ? editing.text : w));
    setEditing(null);
    await persist(next);
  };

  const importFile = async () => {
    setError(null);
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: "Text", extensions: ["txt"] }],
      });
      if (typeof path !== "string") return;
      setWords(await invoke<string[]>("vocabulary_import", { path }));
    } catch (e) {
      setError(messageOf(e));
    }
  };

  const exportFile = async () => {
    setError(null);
    try {
      const path = await save({
        defaultPath: "yadi-vocabulary.txt",
        filters: [{ name: "Text", extensions: ["txt"] }],
      });
      if (typeof path !== "string") return;
      await invoke("vocabulary_export", { path });
    } catch (e) {
      setError(messageOf(e));
    }
  };

  return (
    <fieldset className="settings-group">
      <legend>My words</legend>
      <p className="settings-help">
        Names and jargon Yadi should spell your way. They are used when the prompt is written.
      </p>
      <div className="settings-row">
        <input
          type="text"
          aria-label="New word"
          value={draft}
          placeholder="Add a word or phrase"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
          }}
        />
        <button type="button" onClick={() => void add()} disabled={draft.trim() === ""}>
          Add
        </button>
      </div>
      {words.length === 0 ? (
        <p className="settings-help">No words yet.</p>
      ) : (
        <ul className="vocab-list" aria-label="My words">
          {words.map((word, index) => (
            <li key={word} className="settings-row">
              {editing?.index === index ? (
                <input
                  type="text"
                  autoFocus
                  aria-label={`Edit ${word}`}
                  value={editing.text}
                  onChange={(e) => setEditing({ index, text: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void commitEdit();
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setEditing(null);
                    }
                  }}
                  onBlur={() => void commitEdit()}
                />
              ) : (
                <>
                  <span className="vocab-word">{word}</span>
                  <button
                    type="button"
                    aria-label={`Edit ${word}`}
                    onClick={() => setEditing({ index, text: word })}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${word}`}
                    onClick={() => void persist(words.filter((_, i) => i !== index))}
                  >
                    Delete
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="settings-row">
        <button type="button" onClick={() => void importFile()}>
          Import…
        </button>
        <button type="button" onClick={() => void exportFile()} disabled={words.length === 0}>
          Export…
        </button>
      </div>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
