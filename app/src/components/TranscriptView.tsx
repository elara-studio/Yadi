import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { splitWords, type AppEvent, type AppState, type TranscriptSnapshot } from "@yadi/core";
import type { TranscriptEditEvent } from "../windows/mascot/controller";
import { addVocabulary } from "../vocabulary/store";

export type TranscriptSend = (event: AppEvent | TranscriptEditEvent) => void;

interface Props {
  snapshot: TranscriptSnapshot;
  state: AppState;
  /** The state machine's `editing` flag (Y does nothing while true). */
  editing: boolean;
  send: TranscriptSend;
  /** Approximate tokens of the message as it was recorded, shown under it (with the result). */
  tokens?: number;
}

type Mode =
  | { kind: "read" }
  | { kind: "all"; draft: string }
  | { kind: "word"; segmentId: number; wordIndex: number; original: string };

const EMPTY = "Press Y and start talking.";

/**
 * Read-only live transcript (finished segments in normal text, the in-progress partial lighter
 * and italic) with two ways to fix it, both only in idle or result:
 *  - the pencil edits the whole transcript in a text box (Cmd/Ctrl+Enter or the check saves,
 *    Esc cancels);
 *  - double-click a word (or focus it and press Enter) to replace just that word.
 */
export function TranscriptView({ snapshot, state, editing, send, tokens }: Props) {
  const [mode, setMode] = useState<Mode>({ kind: "read" });
  const [offer, setOffer] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const sawEditing = useRef(false);

  const hasText = snapshot.segments.length > 0 || snapshot.partial !== "";
  const canEdit = (state === "idle" || state === "result") && snapshot.segments.length > 0;

  // Keep the newest words in view while recording.
  useEffect(() => {
    if (state === "recording" && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [snapshot, state]);

  // If the app leaves editing by itself (e.g. a global Esc), close our editor too.
  useEffect(() => {
    if (editing) sawEditing.current = true;
    else if (sawEditing.current) {
      sawEditing.current = false;
      setMode({ kind: "read" });
    }
  }, [editing]);

  // Editing is blocked while recording or processing: close anything still open.
  useEffect(() => {
    if (state !== "idle" && state !== "result") setMode({ kind: "read" });
  }, [state]);

  const begin = (next: Mode) => {
    if (!canEdit) return;
    setOffer(null);
    setMode(next);
    send({ type: "EDIT_START" });
  };
  const finish = () => {
    setMode({ kind: "read" });
    send({ type: "EDIT_END" });
  };

  const saveAll = (draft: string) => {
    send({ type: "TRANSCRIPT_SET_TEXT", text: draft });
    finish();
  };
  const saveWord = (m: Extract<Mode, { kind: "word" }>, value: string) => {
    const text = value.trim();
    if (text !== "" && text !== m.original) {
      send({
        type: "TRANSCRIPT_REPLACE_WORD",
        segmentId: m.segmentId,
        wordIndex: m.wordIndex,
        text,
      });
      setOffer(text);
    }
    finish();
  };

  const header = (
    <div className="transcript-bar">
      {mode.kind === "all" ? (
        <>
          <button
            type="button"
            aria-label="Save edits"
            title="Save (Cmd/Ctrl+Enter)"
            onClick={() => saveAll(mode.draft)}
          >
            ✓
          </button>
          <button type="button" aria-label="Cancel editing" title="Cancel (Esc)" onClick={finish}>
            ✕
          </button>
        </>
      ) : (
        <button
          type="button"
          aria-label="Edit transcript"
          title={
            canEdit ? "Edit transcript" : "You can edit once recording and processing are done"
          }
          disabled={!canEdit || mode.kind !== "read"}
          onClick={() =>
            begin({ kind: "all", draft: snapshot.segments.map((s) => s.text).join(" ") })
          }
        >
          ✎
        </button>
      )}
    </div>
  );

  if (mode.kind === "all") {
    const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Escape") finish();
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        saveAll(mode.draft);
      }
    };
    return (
      <div className="transcript-wrap">
        {header}
        <textarea
          className="transcript-editor"
          aria-label="Transcript"
          autoFocus
          value={mode.draft}
          onChange={(e) => setMode({ kind: "all", draft: e.target.value })}
          onKeyDown={onKey}
        />
      </div>
    );
  }

  return (
    <div className="transcript-wrap">
      {header}
      <div className="transcript-box" ref={box} data-testid="transcript">
        {!hasText ? (
          <span className="transcript-empty">{EMPTY}</span>
        ) : (
          <>
            {snapshot.segments.map((segment) => (
              <span key={segment.id} className="transcript-final" data-segment={segment.id}>
                {splitWords(segment.text).map((word, i) =>
                  mode.kind === "word" && mode.segmentId === segment.id && mode.wordIndex === i ? (
                    <WordInput
                      key={i}
                      word={word}
                      onSave={(v) => saveWord(mode, v)}
                      onCancel={finish}
                    />
                  ) : (
                    <Word
                      key={i}
                      word={word}
                      interactive={canEdit && mode.kind === "read"}
                      onOpen={() =>
                        begin({ kind: "word", segmentId: segment.id, wordIndex: i, original: word })
                      }
                    />
                  ),
                )}{" "}
              </span>
            ))}
            {snapshot.partial !== "" && (
              <span className="transcript-partial">{snapshot.partial}</span>
            )}
          </>
        )}
      </div>
      {tokens !== undefined && hasText && (
        <span
          className="token-note"
          data-testid="transcript-tokens"
          title="Approximate: about 4 characters per token"
        >
          ≈ {tokens} tokens as recorded
        </span>
      )}
      {offer && (
        <div className="transcript-offer" role="status">
          <span>Remember &lsquo;{offer}&rsquo; for next time?</span>
          <button
            type="button"
            onClick={() => {
              addVocabulary(offer);
              setOffer(null);
            }}
          >
            Yes
          </button>
          <button type="button" onClick={() => setOffer(null)}>
            No
          </button>
        </div>
      )}
    </div>
  );
}

function Word({
  word,
  interactive,
  onOpen,
}: {
  word: string;
  interactive: boolean;
  onOpen: () => void;
}) {
  if (!interactive) return <span className="word-plain">{word} </span>;
  return (
    <>
      <span
        className="word"
        role="button"
        tabIndex={0}
        aria-label={`Edit word ${word}`}
        onDoubleClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onOpen();
          }
        }}
      >
        {word}
      </span>{" "}
    </>
  );
}

function WordInput({
  word,
  onSave,
  onCancel,
}: {
  word: string;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(word);
  return (
    <>
      <input
        className="word-input"
        aria-label={`Replace word ${word}`}
        autoFocus
        size={Math.max(4, value.length + 1)}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSave(value);
          } else if (e.key === "Escape") {
            onCancel();
          }
        }}
        onBlur={onCancel}
      />{" "}
    </>
  );
}
