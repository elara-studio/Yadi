import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { getVersion } from "@tauri-apps/api/app";
import { HoldTest } from "./HoldTest";
import { UpdateChecker } from "./UpdateChecker";
import { VocabularyEditor } from "./VocabularyEditor";
import {
  MAX_THRESHOLD_MS,
  MIN_THRESHOLD_MS,
  type InputDevice,
  type LlmOption,
  type Settings,
  type SummonMode,
} from "./types";

const GB = 1024 * 1024 * 1024;
const gbText = (bytes: number) => `${(bytes / GB).toFixed(1)} GB`;

function messageOf(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : "Something went wrong.";
}

/** Everything the person can change, in the order they are likely to look for it. */
export function SettingsView({
  onBack,
  onRerunSetup,
  onOpenAbout,
}: {
  onBack: () => void;
  /** Re-opens the setup wizard; `repair` also downloads the models again. */
  onRerunSetup?: (repair: boolean) => void;
  /** Opens the About / licences page. */
  onOpenAbout?: () => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [devices, setDevices] = useState<InputDevice[]>([]);
  const [models, setModels] = useState<LlmOption[]>([]);
  const [modelInstalled, setModelInstalled] = useState<boolean | null>(null);
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [vocabularyKey, setVocabularyKey] = useState(0);
  const [version, setVersion] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    invoke<Settings>("get_settings").then(
      (s) => !cancelled && setSettings(s),
      (e) => !cancelled && setError(String(e)),
    );
    // These are extras: if one fails the rest of the screen still works.
    invoke<InputDevice[]>("audio_list_devices").then(
      (d) => !cancelled && setDevices(d ?? []),
      () => {},
    );
    invoke<LlmOption[]>("llm_options_list").then(
      (m) => !cancelled && setModels(m ?? []),
      () => {},
    );
    isEnabled().then(
      (on) => !cancelled && setAutostart(on),
      () => {},
    );
    getVersion().then(
      (v) => !cancelled && setVersion(v),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Is the chosen model already on this computer?
  const chosenTag = models.find((m) => m.id === settings?.llm?.model_id)?.tag;
  useEffect(() => {
    let cancelled = false;
    setModelInstalled(null);
    if (chosenTag) {
      invoke<boolean>("ollama_has", { tag: chosenTag }).then(
        (has) => !cancelled && setModelInstalled(has),
        () => {},
      );
    }
    return () => {
      cancelled = true;
    };
  }, [chosenTag]);

  if (!settings) {
    return <p>{error ?? "Loading…"}</p>;
  }

  const change = (next: Settings) => {
    setSaved(false);
    setSettings(next);
  };
  const updateSummon = (patch: Partial<Settings["summon"]>) =>
    change({ ...settings, summon: { ...settings.summon, ...patch } });

  const save = async () => {
    setError(null);
    try {
      setSettings(await invoke<Settings>("set_settings", { settings }));
      setSaved(true);
    } catch (e) {
      setError(messageOf(e));
    }
  };

  const toggleAutostart = async (on: boolean) => {
    setError(null);
    try {
      await (on ? enable() : disable());
      setAutostart(await isEnabled());
    } catch (e) {
      setError(messageOf(e));
    }
  };

  const resetEverything = async () => {
    setError(null);
    setConfirmReset(false);
    try {
      setSettings(await invoke<Settings>("reset_everything"));
      await disable().catch(() => {});
      setAutostart(await isEnabled().catch(() => null));
      setVocabularyKey((k) => k + 1);
      setSaved(false);
    } catch (e) {
      setError(messageOf(e));
    }
  };

  const { mode, threshold_ms, chord } = settings.summon;
  const device = settings.microphone?.device ?? null;
  const modelId = settings.llm?.model_id ?? null;
  const chosenModel = models.find((m) => m.id === modelId);
  const deviceMissing = device !== null && !devices.some((d) => d.name === device);

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
              onChange={() => updateSummon({ mode: value })}
            />{" "}
            {label}
          </label>
        ))}
        {mode === "longpress-y" ? (
          <>
            <label className="settings-row">
              Hold time: {threshold_ms} ms
              <input
                type="range"
                aria-label="Hold time in milliseconds"
                min={MIN_THRESHOLD_MS}
                max={MAX_THRESHOLD_MS}
                step={50}
                value={threshold_ms}
                onChange={(e) => updateSummon({ threshold_ms: Number(e.target.value) })}
              />
            </label>
            <HoldTest thresholdMs={threshold_ms} />
          </>
        ) : (
          <label className="settings-row">
            Shortcut
            <input
              type="text"
              aria-label="Shortcut"
              value={chord}
              onChange={(e) => updateSummon({ chord: e.target.value })}
            />
          </label>
        )}
      </fieldset>

      <fieldset className="settings-group">
        <legend>Microphone</legend>
        <label className="settings-row">
          Record from
          <select
            aria-label="Microphone"
            value={device ?? ""}
            onChange={(e) =>
              change({ ...settings, microphone: { device: e.target.value || null } })
            }
          >
            <option value="">System default</option>
            {deviceMissing && <option value={device ?? ""}>{device} (not connected)</option>}
            {devices.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
                {d.is_default ? " (default)" : ""}
              </option>
            ))}
          </select>
        </label>
        {deviceMissing && (
          <p className="settings-help" role="status">
            That microphone is not connected, so the system default is used.
          </p>
        )}
      </fieldset>

      <fieldset className="settings-group">
        <legend>Language model</legend>
        <label className="settings-row">
          Write prompts with
          <select
            aria-label="Language model"
            value={modelId ?? ""}
            onChange={(e) => change({ ...settings, llm: { model_id: e.target.value || null } })}
          >
            <option value="">Automatic (best for this computer)</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.tag} · {gbText(m.size_bytes)}
                {m.recommended ? " · recommended" : ""}
                {m.fits ? "" : " · may not fit"}
              </option>
            ))}
          </select>
        </label>
        {chosenModel && !chosenModel.tested && (
          <p className="settings-help">This model has not been tested with Yadi yet.</p>
        )}
        {chosenModel?.warning && (
          <p className="settings-error" role="alert">
            {chosenModel.warning}
          </p>
        )}
        {chosenModel && modelInstalled === false && (
          <p className="settings-help" role="status">
            This model is not downloaded yet.{" "}
            {onRerunSetup && (
              <button type="button" onClick={() => onRerunSetup(false)}>
                Download it
              </button>
            )}
          </p>
        )}
      </fieldset>

      <fieldset className="settings-group">
        <legend>General</legend>
        <label className="settings-row">
          <input
            type="checkbox"
            checked={settings.finalPass.enabled}
            onChange={(e) =>
              change({
                ...settings,
                finalPass: { ...settings.finalPass, enabled: e.target.checked },
              })
            }
          />
          Polish the transcript after recording (more accurate, a few seconds slower)
        </label>
        {autostart !== null && (
          <label className="settings-row">
            <input
              type="checkbox"
              checked={autostart}
              onChange={(e) => void toggleAutostart(e.target.checked)}
            />
            Start Yadi when I log in
          </label>
        )}
      </fieldset>

      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {saved && <p role="status">Saved.</p>}
      <button type="button" className="settings-save" onClick={() => void save()}>
        Save
      </button>

      <VocabularyEditor reloadKey={vocabularyKey} />

      <fieldset className="settings-group">
        <legend>Setup and about</legend>
        <div className="settings-row">
          {onRerunSetup && (
            <>
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
            </>
          )}
          {onOpenAbout && (
            <button type="button" onClick={onOpenAbout}>
              About and licences
            </button>
          )}
        </div>
      </fieldset>

      <UpdateChecker version={version} />

      <fieldset className="settings-group">
        <legend>Reset</legend>
        {confirmReset ? (
          <div className="settings-row" role="alertdialog" aria-label="Confirm reset">
            <span>Reset all settings and delete your words? Downloaded models are kept.</span>
            <button type="button" onClick={() => void resetEverything()}>
              Yes, reset everything
            </button>
            <button type="button" onClick={() => setConfirmReset(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirmReset(true)}>
            Reset everything
          </button>
        )}
      </fieldset>
    </section>
  );
}
