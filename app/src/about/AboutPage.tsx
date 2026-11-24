import { useMemo, useState } from "react";
import type { LicenseData, LicenseEntry, LicenseKind } from "./types";

export const PRIVACY_LINE = "Your voice and prompts never leave this device.";

const GROUPS: { kind: LicenseKind; label: string }[] = [
  { kind: "app", label: "Application" },
  { kind: "runtime", label: "Runtimes" },
  { kind: "model", label: "Models" },
  { kind: "library", label: "Libraries" },
];

function matches(entry: LicenseEntry, query: string): boolean {
  if (!query) return true;
  const haystack = `${entry.name} ${entry.license_spdx} ${entry.version} ${entry.ecosystem ?? ""}`;
  return haystack.toLowerCase().includes(query);
}

function EntryRow({ entry, texts }: { entry: LicenseEntry; texts: Record<string, string> }) {
  // Licence texts are only put in the DOM once the row is opened (there are hundreds of rows).
  const [open, setOpen] = useState(false);
  return (
    <details className="about-entry" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span className="about-name">{entry.name}</span>{" "}
        <span className="about-version">{entry.version}</span>{" "}
        <span className="about-spdx">{entry.license_spdx}</span>
      </summary>
      {open && (
        <div className="about-detail">
          {entry.attribution && <p>{entry.attribution}</p>}
          {entry.license_url && <p className="about-url">Licence: {entry.license_url}</p>}
          {entry.source_url && <p className="about-url">Source: {entry.source_url}</p>}
          {entry.text_ids.length === 0 && (
            <p>Full licence text not bundled; see the licence identifier above.</p>
          )}
          {entry.text_ids.map((id) => (
            <pre key={id} className="about-text">
              {texts[id]}
            </pre>
          ))}
        </div>
      )}
    </details>
  );
}

export function AboutPage({
  data,
  version,
  onBack,
}: {
  data: LicenseData;
  version: string;
  onBack?: () => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  const groups = useMemo(
    () =>
      GROUPS.map((g) => ({
        ...g,
        entries: data.entries.filter((e) => e.kind === g.kind && matches(e, q)),
      })).filter((g) => g.entries.length > 0),
    [data, q],
  );

  return (
    <section className="about" aria-label="About Yadi">
      <header className="about-header">
        {onBack && (
          <button type="button" className="about-back" onClick={onBack} aria-label="Back to chat">
            ←
          </button>
        )}
        <div>
          <h1 className="about-title">Yadi</h1>
          <div className="about-version-line">Version {version}</div>
        </div>
      </header>
      <p className="about-privacy">{PRIVACY_LINE}</p>
      <input
        type="search"
        className="about-search"
        placeholder="Search licences"
        aria-label="Search licences"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="about-list">
        {groups.length === 0 && <p>No licences match "{query}".</p>}
        {groups.map((g) => (
          <div key={g.kind} className="about-group">
            <h2>
              {g.label} ({g.entries.length})
            </h2>
            {g.entries.map((e) => (
              <EntryRow key={e.id} entry={e} texts={data.texts} />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
