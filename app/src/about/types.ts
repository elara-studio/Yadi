export type LicenseKind = "app" | "library" | "runtime" | "model";

export interface LicenseEntry {
  id: string;
  name: string;
  kind: LicenseKind;
  version: string;
  license_spdx: string;
  license_url?: string;
  attribution?: string;
  source_url?: string;
  ecosystem?: "npm" | "cargo";
  /** Keys into LicenseData.texts. */
  text_ids: string[];
}

/** Shape of app/src/generated/licenses.json (written by scripts/gen-licenses.mjs). */
export interface LicenseData {
  entries: LicenseEntry[];
  texts: Record<string, string>;
}
