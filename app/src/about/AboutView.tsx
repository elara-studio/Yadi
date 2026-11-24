import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { AboutPage } from "./AboutPage";
import type { LicenseData } from "./types";

// The generated file is large and gitignored, so it is loaded lazily and only if present.
// (import.meta.glob returns {} when the file does not exist, so dev and tests never break.)
const generated = import.meta.glob<LicenseData>("../generated/licenses.json", {
  import: "default",
});

export function AboutView({ onBack }: { onBack: () => void }) {
  const [data, setData] = useState<LicenseData | null>(null);
  const [version, setVersion] = useState("");
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    const load = Object.values(generated)[0];
    if (!load) {
      setMissing(true);
      return;
    }
    let cancelled = false;
    void load().then((d) => !cancelled && setData(d));
    void getVersion().then(
      (v) => !cancelled && setVersion(v),
      () => !cancelled && setVersion("unknown"),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (missing) {
    return (
      <p>
        Licence data was not generated. Run <code>node scripts/gen-licenses.mjs</code>.
      </p>
    );
  }
  if (!data) return <p>Loading…</p>;
  return <AboutPage data={data} version={version} onBack={onBack} />;
}
