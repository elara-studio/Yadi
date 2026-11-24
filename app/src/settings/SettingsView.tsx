import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MAX_THRESHOLD_MS, MIN_THRESHOLD_MS, type Settings, type SummonMode } from "./types";

/** Settings stub (Task 07): how Yadi is summoned. Task 21 completes the settings screen. */
export function SettingsView({
  onBack,
  onRerunSetup,
}: {
  onBack: () => void;
  /** Re-opens the setup wizard; `repair` also downloads the models again. */
  onRerunSetup?: (repair: boolean) => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    invoke<Settings>("get_settings").then(
      (s) => !cancelled && setSettings(s),
      (e) => !cancelled && setError(String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (!settings) {
    return <p>{error ?? "Loading…"}</p>;
  }

  const update = (patch: Partial<Settings["summon"]>) => {
    setSaved(false);
    setSettings({ ...settings, summon: { ...settings.summon, ...patch } });
  };

  const setFinalPass = (enabled: boolean) => {
    setSaved(false);
    setSettings({ ...settings, finalPass: { ...settings.finalPass, enabled } });
  };

  const save = async () => {
    setError(null);
    try {
      setSettings(await invoke<Settings>("set_settings", { settings }));
      setSaved(true);
    } catch (e) {
      setError(String(e));
    }
  };

  const { mode, threshold_ms, chord } = settings.summon;
  return (
    <section className="settings" aria-label="Settings">
      <header className="about-header">
        <button type="button" className="about-back" onClick={onBack} aria-label="Back to chat">
          ←
        </button>
        <h1 className="about-title">Settings</h1>
      </header>

      <fieldset className="settings-group">
        <legend>Summon Yadi with</legend>
        {(
          [
            ["longpress-y", "Hold the Y key"],
            ["chord", "A keyboard shortcut"],
          ] as [SummonMode, string][]
        ).map(([value, label]) => (
          <label key={value} className="settings-row">
            <input
              type="radio"
              name="summon-mode"
              checked={mode === value}
              onChange={() => update({ mode: value })}
            />{" "}
            {label}
          </label>
        ))}
      </fieldset>

      {mode === "longpress-y" ? (
        <label className="settings-row">
          Hold time: {threshold_ms} ms
          <input
            type="range"
            aria-label="Hold time in milliseconds"
            min={MIN_THRESHOLD_MS}
            max={MAX_THRESHOLD_MS}
            step={50}
            value={threshold_ms}
            onChange={(e) => update({ threshold_ms: Number(e.target.value) })}
          />
        </label>
      ) : (
        <label className="settings-row">
          Shortcut
          <input
            type="text"
            aria-label="Shortcut"
            value={chord}
            onChange={(e) => update({ chord: e.target.value })}
          />
        </label>
      )}

      <label className="settings-row">
        <input
          type="checkbox"
          checked={settings.finalPass.enabled}
          onChange={(e) => setFinalPass(e.target.checked)}
        />
        Polish the transcript after recording (more accurate, a few seconds slower)
      </label>

      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {saved && <p role="status">Saved.</p>}
      <button type="button" className="settings-save" onClick={() => void save()}>
        Save
      </button>

      {onRerunSetup && (
        <fieldset className="settings-group">
          <legend>Setup</legend>
          <div className="settings-row">
            <button type="button" onClick={() => onRerunSetup(false)}>
              Re-run setup
            </button>
            <button
              type="button"
              onClick={() => onRerunSetup(true)}
              title="Downloads the models again"
            >
              Repair models
            </button>
          </div>
        </fieldset>
      )}
    </section>
  );
}
