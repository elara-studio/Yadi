import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import type { AppEvent, TranscriptSnapshot } from "@yadi/core";
import { AboutView } from "../../about/AboutView";
import { SettingsView } from "../../settings/SettingsView";
import type { AppStatePayload, ChatView, ProgressPayload } from "../mascot/controller";
import { useKeyboardControls } from "./useKeyboardControls";

const sendToController = (event: AppEvent) => void emit("app:event", event);

/** Mirrors `Notice` in src-tauri/src/hotkey/mod.rs. */
interface Notice {
  message: string;
  action: string | null;
}

export const KEY_HINT = "Y = next step · Esc = stop / hide";

/** Placeholder chat overlay. Real content arrives in Tasks 05, 12, 19. */
export function ChatWindow() {
  const [app, setApp] = useState<AppStatePayload>({ state: "minimized", editing: false });
  const [view, setView] = useState<ChatView>("chat");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [progress, setProgress] = useState<ProgressPayload | null>(null);
  const [transcript, setTranscript] = useState<TranscriptSnapshot>({ segments: [], partial: "" });

  useKeyboardControls(sendToController);

  useEffect(() => {
    // A notice raised during startup (e.g. Hold-Y fell back to the chord) waits in Rust.
    invoke<Notice | null>("get_notice").then(
      (n) => setNotice(n ?? null),
      () => {},
    );
  }, []);

  useEffect(() => {
    const pending = [
      listen<AppStatePayload>("app:state", (e) => setApp(e.payload)),
      listen<{ view: ChatView }>("app:view", (e) => setView(e.payload.view)),
      listen<TranscriptSnapshot>("app:transcript", (e) => setTranscript(e.payload)),
      listen<Notice>("app:notice", (e) => setNotice(e.payload)),
      listen<ProgressPayload | null>("app:progress", (e) => setProgress(e.payload)),
    ];
    // Ask the Controller for the current state in case we loaded after its last broadcast.
    void Promise.all(pending).then(() => emit("app:event", { type: "SYNC" }));
    return () => pending.forEach((p) => void p.then((unlisten) => unlisten()));
  }, []);

  return (
    <div className="chat-root">
      <div className="chat-card">
        {view === "about" ? (
          <div className="chat-body">
            <AboutView onBack={() => setView("chat")} />
          </div>
        ) : view === "settings" ? (
          <div className="chat-body">
            <SettingsView onBack={() => setView("chat")} />
          </div>
        ) : (
          <>
            <div className="chat-header">
              <span className="chat-title">Yadi</span>
              <span className="chat-state" data-testid="chat-state">
                {app.state}
              </span>
              <button
                type="button"
                className="chat-info"
                aria-label="Settings"
                title="Settings"
                onClick={() => setView("settings")}
              >
                ⚙
              </button>
              <button
                type="button"
                className="chat-info"
                aria-label="About Yadi"
                title="About"
                onClick={() => setView("about")}
              >
                i
              </button>
            </div>
            {notice && (
              <div className="chat-notice" role="alert">
                <span>{notice.message}</span>
                {notice.action === "fix-permissions" && (
                  <button type="button" onClick={() => void invoke("open_permission_settings")}>
                    Fix
                  </button>
                )}
                <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}>
                  ×
                </button>
              </div>
            )}
            {app.state === "processing" && (
              <ul className="stages" aria-label="Progress">
                <li className="stage-active" aria-current="step">
                  Transcribing
                  {progress && progress.total > 1 ? ` ${progress.done}/${progress.total}` : "…"}
                </li>
              </ul>
            )}
            <div className="chat-body" data-testid="transcript">
              {transcript.segments.length === 0 && transcript.partial === "" ? (
                <span className="transcript-empty">Press Y and start talking.</span>
              ) : (
                <>
                  {transcript.segments.map((s) => (
                    <span key={s.id} className="transcript-final">
                      {s.text}{" "}
                    </span>
                  ))}
                  <span className="transcript-partial">{transcript.partial}</span>
                </>
              )}
            </div>
            <div className="chat-hint">{KEY_HINT}</div>
          </>
        )}
      </div>
    </div>
  );
}
