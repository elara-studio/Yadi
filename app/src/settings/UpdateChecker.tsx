import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { formatBytes, percent } from "../setup/format";

/** Mirrors `UpdateCheck` in src-tauri/src/updates.rs. */
export type UpdateCheck =
  | { status: "no-release"; current: string }
  | { status: "up-to-date"; current: string; latest: string }
  | {
      status: "available";
      current: string;
      latest: string;
      notes: string;
      page_url: string;
      installable: boolean;
      reason: string | null;
      size_bytes: number | null;
    };

type Available = Extract<UpdateCheck, { status: "available" }>;

type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "result"; check: UpdateCheck }
  | { kind: "downloading"; check: Available }
  | { kind: "ready"; check: Available }
  | { kind: "error"; message: string };

function messageOf(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : "Something went wrong.";
}

/**
 * "Check for updates": only ever runs when the person presses the button. Compares Yadi's version
 * with the newest published release; if there is a newer one it can download, verify and open the
 * installer. All of the network work is done by the app itself (Rust), not by this screen.
 */
export function UpdateChecker({ version }: { version?: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [progress, setProgress] = useState<{ received: number; total: number | null } | null>(null);
  const [installing, setInstalling] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const check = async () => {
    setPhase({ kind: "checking" });
    try {
      const result = await invoke<UpdateCheck>("check_for_update");
      if (alive.current) setPhase({ kind: "result", check: result });
    } catch (e) {
      if (alive.current) setPhase({ kind: "error", message: messageOf(e) });
    }
  };

  const download = async (found: Available) => {
    setProgress(null);
    setPhase({ kind: "downloading", check: found });
    let off: (() => void) | undefined;
    try {
      const pending = listen<{ received: number; total: number | null }>("update:progress", (e) =>
        setProgress({ received: e.payload.received, total: e.payload.total }),
      );
      off = () => void pending.then((unlisten) => unlisten());
    } catch {
      // Progress is a nicety: the download works without it.
    }
    try {
      await invoke("download_update");
      if (alive.current) setPhase({ kind: "ready", check: found });
    } catch (e) {
      if (alive.current) setPhase({ kind: "error", message: messageOf(e) });
    } finally {
      off?.();
    }
  };

  const install = async () => {
    setInstalling(true);
    try {
      await invoke("install_update"); // Yadi closes a moment after this
    } catch (e) {
      setInstalling(false);
      setPhase({ kind: "error", message: messageOf(e) });
    }
  };

  const found = phase.kind === "result" && phase.check.status === "available" ? phase.check : null;
  const pct = progress ? percent(progress.received, progress.total) : null;

  return (
    <fieldset className="settings-group" data-testid="updates">
      <legend>Updates</legend>
      <div className="settings-row">
        {version && <span>You have Yadi {version}.</span>}
        <button
          type="button"
          disabled={phase.kind === "checking" || phase.kind === "downloading"}
          onClick={() => void check()}
        >
          {phase.kind === "checking" ? "Checking…" : "Check for updates"}
        </button>
      </div>
      <p className="settings-help">
        Only checks when you ask. It looks at Yadi's public releases on GitHub; nothing about you is
        sent.
      </p>

      {phase.kind === "result" && phase.check.status === "no-release" && (
        <p role="status">No update has been published yet, so you have the newest Yadi.</p>
      )}
      {phase.kind === "result" && phase.check.status === "up-to-date" && (
        <p role="status">You have the newest version ({phase.check.current}).</p>
      )}
      {found && (
        <div role="status" className="update-available">
          <p>
            <strong>Yadi {found.latest} is available</strong> (you have {found.current}
            {found.size_bytes ? `; download ${formatBytes(found.size_bytes)}` : ""}).
          </p>
          {found.notes && <pre className="update-notes">{found.notes}</pre>}
          {found.installable ? (
            <button type="button" onClick={() => void download(found)}>
              Download and install
            </button>
          ) : (
            <>
              <p className="settings-help">{found.reason}</p>
              <button
                type="button"
                onClick={() =>
                  void invoke("open_release_page", { url: found.page_url }).catch((e) =>
                    setPhase({ kind: "error", message: messageOf(e) }),
                  )
                }
              >
                Open the release page
              </button>
            </>
          )}
        </div>
      )}

      {phase.kind === "downloading" && (
        <div>
          <div
            className="setup-bar"
            role="progressbar"
            aria-label="Update download"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct ?? undefined}
            aria-busy={pct === null}
          >
            <div
              className={pct === null ? "setup-bar-fill setup-bar-indeterminate" : "setup-bar-fill"}
              style={pct === null ? undefined : { width: `${pct}%` }}
            />
          </div>
          <p className="setup-progress-text" data-testid="update-progress-text">
            {pct === null
              ? "Downloading the update…"
              : `Downloading Yadi ${phase.check.latest} · ${pct}%`}
          </p>
          <button type="button" onClick={() => void invoke("cancel_update_download")}>
            Cancel
          </button>
        </div>
      )}

      {phase.kind === "ready" && (
        <div role="status">
          <p>
            Yadi {phase.check.latest} is downloaded and checked. Installing closes Yadi while the
            installer runs.
          </p>
          <button type="button" disabled={installing} onClick={() => void install()}>
            {installing ? "Opening the installer…" : "Install now"}
          </button>
        </div>
      )}

      {phase.kind === "error" && (
        <p className="settings-error" role="alert">
          {phase.message}
        </p>
      )}
    </fieldset>
  );
}
