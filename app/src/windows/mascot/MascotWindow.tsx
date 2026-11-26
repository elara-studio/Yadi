import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isSetupComplete, loadSetupState } from "@yadi/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Mascot } from "../../components/Mascot";
import type { Settings } from "../../settings/types";
import { Controller, mascotStateFor } from "./controller";
import { PointerGesture } from "./pointerGesture";
import { tauriPorts } from "./tauriPorts";

export function MascotWindow() {
  const controller = useMemo(() => new Controller(tauriPorts), []);
  const [model, setModel] = useState(controller.model);
  const gesture = useRef(new PointerGesture());
  const [animated, setAnimated] = useState(true);

  // Settings > General > "Animate the mascot", read at start and on every save.
  useEffect(() => {
    const apply = (s: Settings | null | undefined) =>
      setAnimated(s?.appearance?.animations ?? true);
    invoke<Settings>("get_settings").then(apply, () => {});
    const off = listen<Settings>("settings:changed", (e) => apply(e.payload));
    return () => void off.then((unlisten) => unlisten());
  }, []);

  // First run (or unfinished setup): show the wizard instead of an idle chat.
  useEffect(() => {
    let cancelled = false;
    invoke("get_setup_state").then(
      (raw) => {
        if (cancelled) return;
        const complete = isSetupComplete(loadSetupState(raw));
        controller.setSetupComplete(complete);
        if (!complete) controller.dispatch({ type: "SETUP_START" });
      },
      () => {
        // Unreadable state: treat as unfinished rather than silently skipping setup.
        if (!cancelled) controller.dispatch({ type: "SETUP_START" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [controller]);

  useEffect(() => {
    const unsubscribe = controller.subscribe(setModel);
    const pending: Promise<UnlistenFn>[] = [
      listen("app:event", (e) => controller.handleAppEvent(e.payload)),
      listen("hotkey:summon", () => controller.dispatch({ type: "SUMMON" })),
      listen("stt:partial", (e) => controller.handleSttPartial(e.payload)),
      listen("stt:final", (e) => controller.handleSttFinal(e.payload)),
      listen("stt:final-progress", (e) => controller.handleFinalProgress(e.payload)),
      listen("audio:error", (e) => controller.handleAudioError(e.payload)),
      listen("tray:toggle", () => controller.toggleChat()),
      listen("tray:about", () => controller.openAbout()),
    ];
    return () => {
      unsubscribe();
      pending.forEach((p) => void p.then((unlisten) => unlisten()));
    };
  }, [controller]);

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    gesture.current.down(e.screenX, e.screenY);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (gesture.current.move(e.screenX, e.screenY) === "drag-start") {
      void getCurrentWindow().startDragging();
    }
  };
  const onPointerUp = () => {
    if (gesture.current.up() === "click") controller.toggleChat();
  };

  return (
    <div
      className="mascot-root"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => gesture.current.cancel()}
      onContextMenu={(e) => {
        e.preventDefault();
        void invoke("show_context_menu");
      }}
    >
      <Mascot state={mascotStateFor(model)} still={!animated} />
    </div>
  );
}
