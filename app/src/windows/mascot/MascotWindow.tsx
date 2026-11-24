import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Mascot } from "../../components/Mascot";
import { Controller, mascotStateFor } from "./controller";
import { PointerGesture } from "./pointerGesture";
import { tauriPorts } from "./tauriPorts";

export function MascotWindow() {
  const controller = useMemo(() => new Controller(tauriPorts), []);
  const [model, setModel] = useState(controller.model);
  const gesture = useRef(new PointerGesture());

  useEffect(() => {
    const unsubscribe = controller.subscribe(setModel);
    const pending: Promise<UnlistenFn>[] = [
      listen("app:event", (e) => controller.handleAppEvent(e.payload)),
      listen("hotkey:summon", () => controller.dispatch({ type: "SUMMON" })),
      listen("tray:toggle", () => controller.toggleChat()),
      listen("tray:about", () => tauriPorts.log("About is not built yet (Task 04)")),
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
      <Mascot state={mascotStateFor(model)} />
    </div>
  );
}
