import { useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { AboutView } from "../../about/AboutView";
import type { AppStatePayload, ChatView } from "../mascot/controller";

/** Placeholder chat overlay. Real content arrives in Tasks 05, 12, 19. */
export function ChatWindow() {
  const [app, setApp] = useState<AppStatePayload>({ state: "minimized", editing: false });
  const [view, setView] = useState<ChatView>("chat");

  useEffect(() => {
    const pending = [
      listen<AppStatePayload>("app:state", (e) => setApp(e.payload)),
      listen<{ view: ChatView }>("app:view", (e) => setView(e.payload.view)),
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
                aria-label="About Yadi"
                title="About"
                onClick={() => setView("about")}
              >
                i
              </button>
            </div>
            <div className="chat-body">Chat overlay placeholder.</div>
          </>
        )}
      </div>
    </div>
  );
}
