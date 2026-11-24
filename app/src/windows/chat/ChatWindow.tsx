import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { loadSetupState, restartSetup, type AppEvent, type TranscriptSnapshot } from "@yadi/core";
import { AboutView } from "../../about/AboutView";
import { TranscriptView } from "../../components/TranscriptView";
import { SettingsView } from "../../settings/SettingsView";
import { SetupWizard } from "../../setup/SetupWizard";
import { createTauriSetupApi, isMockSetup, type SetupApi } from "../../setup/api";
import { createMockSetupApi } from "../../setup/mockApi";
import type {
  AppStatePayload,
  ChatView,
  ProgressPayload,
  TranscriptEditEvent,
} from "../mascot/controller";
import { useKeyboardControls } from "./useKeyboardControls";

const sendToController = (event: AppEvent | TranscriptEditEvent) => void emit("app:event", event);

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
  const [setupApi, setSetupApi] = useState<SetupApi | null>(null);
  const [progress, setProgress] = useState<ProgressPayload | null>(null);
  const [transcript, setTranscript] = useState<TranscriptSnapshot>({ segments: [], partial: "" });

  useKeyboardControls(sendToController);

  // The real setup, or the simulated one when YADI_MOCK_SETUP=1 (development only).
  useEffect(() => {
    isMockSetup().then(
      (mock) => setSetupApi(mock ? createMockSetupApi() : createTauriSetupApi()),
      () => setSetupApi(createTauriSetupApi()),
    );
  }, []);

  const rerunSetup = async (repair: boolean) => {
    if (!setupApi) return;
    const state = loadSetupState(await setupApi.getState());
    await setupApi.saveState(restartSetup(state, repair));
    setView("chat");
    sendToController({ type: "SETUP_START" });
  };

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
            <SettingsView onBack={() => setView("chat")} onRerunSetup={(r) => void rerunSetup(r)} />
          </div>
        ) : app.state === "setup" ? (
          <div className="chat-body">
            {setupApi ? (
              <SetupWizard
                api={setupApi}
                onFinished={() => sendToController({ type: "SETUP_DONE" })}
                onOpenAbout={() => setView("about")}
              />
            ) : (
              <p>Loading…</p>
            )}
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
            <div className="chat-body">
              <TranscriptView
                snapshot={transcript}
                state={app.state}
                editing={app.editing}
                send={sendToController}
              />
            </div>
            <div className="chat-hint">{KEY_HINT}</div>
          </>
        )}
      </div>
    </div>
  );
}
