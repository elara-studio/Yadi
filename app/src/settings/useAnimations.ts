import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Settings } from "./types";

/** Settings > General > "Animate the mascot", read at start and on every save. */
export function useAnimations(): boolean {
  const [animated, setAnimated] = useState(true);
  useEffect(() => {
    const apply = (s: Settings | null | undefined) =>
      setAnimated(s?.appearance?.animations ?? true);
    invoke<Settings>("get_settings").then(apply, () => {});
    const off = listen<Settings>("settings:changed", (e) => apply(e.payload));
    return () => void off.then((unlisten) => unlisten());
  }, []);
  return animated;
}
