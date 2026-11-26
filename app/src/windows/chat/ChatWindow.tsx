import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import {
  attachmentCopyText,
  loadSetupState,
  restartSetup,
  type AppEvent,
  type TranscriptSnapshot,
} from "@yadi/core";
import { useAttachments } from "../../attachments/useAttachments";
import { AttachmentBar } from "../../components/AttachmentBar";
import { AboutView } from "../../about/AboutView";
import { ProcessErrorView } from "../../components/ProcessErrorView";
import { ProcessingView } from "../../components/ProcessingView";
import { ResultView } from "../../components/ResultView";
import { TranscriptView } from "../../components/TranscriptView";
import { SettingsView } from "../../settings/SettingsView";
import { SetupWizard } from "../../setup/SetupWizard";
import { createTauriSetupApi, isMockSetup, type SetupApi } from "../../setup/api";
import { createMockSetupApi } from "../../setup/mockApi";
import { SETTINGS_OPEN_EVENT } from "../mascot/controller";
import type {
  AppStatePayload,
  ChatView,
  ProcessErrorPayload,
  ProgressPayload,
  ResultPayload,
  TranscriptEditEvent,
} from "../mascot/controller";
import { useKeyboardControls } from "./useKeyboardControls";

type ToController = AppEvent | TranscriptEditEvent | { type: "ATTACHMENTS_SET"; items: unknown[] };
const sendToController = (event: ToController) => void emit("app:event", event);

/** Mirrors `Notice` in src-tauri/src/hotkey/mod.rs. */
interface Notice {
  message: string;
  action: string | null;
}

export const KEY_HINT = "Y = next step · Esc = stop / hide";
/** While the prompt is shown, C copies it. */
export const RESULT_KEY_HINT = `C = copy · ${KEY_HINT}`;

/** An upright gear drawn as SVG, so it fills its circle and never inherits a text style. */
function GearIcon() {
  return (
    <svg
      className="gear-icon"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/** Placeholder chat overlay. Real content arrives in Tasks 05, 12, 19. */
export function ChatWindow() {
  const [app, setApp] = useState<AppStatePayload>({ state: "minimized", editing: false });
  const [view, setView] = useState<ChatView>("chat");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [setupApi, setSetupApi] = useState<SetupApi | null>(null);
  const [progress, setProgress] = useState<ProgressPayload | null>(null);
  const [result, setResult] = useState<ResultPayload | null>(null);
  const [processError, setProcessError] = useState<ProcessErrorPayload | null>(null);
  const [transcript, setTranscript] = useState<TranscriptSnapshot>({ segments: [], partial: "" });

  // Settings on screen: Y types normally (e.g. in "My words") and neither records nor summons.
  // A hidden chat may still remember the Settings view, so it only counts while it is shown.
  const settingsOpen = view === "settings" && app.state !== "minimized";
  useKeyboardControls(sendToController, !settingsOpen);
  useEffect(() => {
    void invoke("summon_set_paused", { paused: settingsOpen }).catch(() => {});
    void emit(SETTINGS_OPEN_EVENT, settingsOpen);
  }, [settingsOpen]);
  // Files can be added while talking or reading the result, not while the prompt is made.
  const attachments = useAttachments(
    app.state === "idle" || app.state === "recording" || app.state === "result",
    sendToController,
  );

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
      // `null`: the notice was resolved (e.g. Hold-Y started once permission was granted).
      listen<Notice | null>("app:notice", (e) => setNotice(e.payload)),
      listen<ProgressPayload | null>("app:progress", (e) => setProgress(e.payload)),
      listen<ResultPayload | null>("app:result", (e) => setResult(e.payload)),
      listen<ProcessErrorPayload | null>("app:error", (e) => setProcessError(e.payload)),
    ];
    // Ask the Controller for the current state in case we loaded after its last broadcast.
    void Promise.all(pending).then(() => emit("app:event", { type: "SYNC" }));
    return () => pending.forEach((p) => void p.then((unlisten) => unlisten()));
  }, []);

  return (
    <div className="chat-root">
      <div className="chat-card">
        {/* Grab here (or on the title bar) to drag the chat; it keeps its place beside Yadi. */}
        <div
          className="chat-grip"
          data-tauri-drag-region
          data-testid="chat-grip"
          aria-hidden="true"
        >
          <span className="chat-grip-pill" />
        </div>
        {app.state === "setup" && (
          // Kept mounted under About/Settings so the wizard keeps its place (and ticked boxes).
          <div className="chat-body" hidden={view !== "chat"} data-testid="setup-body">
            {setupApi ? (
              <SetupWizard
                api={setupApi}
                onFinished={() => {
                  sendToController({ type: "SETUP_DONE" });
                  // From now on Hold-Y or the shortcut can open Yadi after it was quit.
                  void invoke("summon_listener_ensure").catch(() => {});
                }}
                onOpenAbout={() => setView("about")}
              />
            ) : (
              <p>Loading…</p>
            )}
          </div>
        )}
        {view === "about" ? (
          <div className="chat-body">
            <AboutView onBack={() => setView("chat")} />
          </div>
        ) : view === "settings" ? (
          <div className="chat-body">
            <SettingsView
              onBack={() => setView("chat")}
              onRerunSetup={(r) => void rerunSetup(r)}
              onOpenAbout={() => setView("about")}
            />
          </div>
        ) : app.state === "setup" ? null : (
          <>
            <div className="chat-header" data-tauri-drag-region>
              <span className="chat-title" data-tauri-drag-region>
                Yadi
              </span>
              <span className="chat-state" data-testid="chat-state" data-tauri-drag-region>
                {app.state}
              </span>
              <button
                type="button"
                className="chat-info chat-icon-button"
                aria-label="Settings"
                title="Settings"
                onClick={() => setView("settings")}
              >
                <GearIcon />
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
            {notice && notice.message !== processError?.message && (
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
            {app.state === "processing" && <ProcessingView progress={progress} />}
            {app.state === "idle" && processError && (
              <ProcessErrorView
                error={processError}
                onRetry={() => sendToController({ type: "PROCESS_RETRY" })}
                onRepair={() => void rerunSetup(true)}
              />
            )}
            <div className="chat-body">
              {app.state === "result" && result && (
                <ResultView
                  result={result}
                  attachmentText={
                    attachments.items.length > 0 ? attachmentCopyText(attachments.items) : undefined
                  }
                  onRegenerate={() => sendToController({ type: "PROCESS_RETRY" })}
                />
              )}
              <TranscriptView
                snapshot={transcript}
                state={app.state}
                editing={app.editing}
                send={sendToController}
              />
            </div>
            <AttachmentBar {...attachments} />
            <div className="chat-hint">
              {app.state === "result" && result ? RESULT_KEY_HINT : KEY_HINT}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
