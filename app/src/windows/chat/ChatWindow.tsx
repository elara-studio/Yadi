import { useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import type { AppStatePayload } from "../mascot/controller";

/** Placeholder chat overlay. Real content arrives in Tasks 05, 12, 19. */
export function ChatWindow() {
  const [app, setApp] = useState<AppStatePayload>({ state: "minimized", editing: false });

  useEffect(() => {
    const pending = listen<AppStatePayload>("app:state", (e) => setApp(e.payload));
    // Ask the Controller for the current state in case we loaded after its last broadcast.
    void pending.then(() => emit("app:event", { type: "SYNC" }));
    return () => void pending.then((unlisten) => unlisten());
  }, []);

  return (
    <div className="chat-root">
      <div className="chat-card">
        <div className="chat-header">
          <span className="chat-title">Yadi</span>
          <span className="chat-state" data-testid="chat-state">
            {app.state}
          </span>
        </div>
        <div className="chat-body">Chat overlay placeholder.</div>
      </div>
    </div>
  );
}
