#!/usr/bin/env node
// Fails the build when a bundled thing has no (verified) licence entry.
// Usage: node scripts/check-licenses.mjs [--release] [--root <repo root>]
// Run `node scripts/gen-licenses.mjs` first: dependency licences are read from its output.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOWED_SPDX, runChecks } from "./lib/licenses.mjs";

const args = process.argv.slice(2);
const release = args.includes("--release");
const rootIdx = args.indexOf("--root");
const ROOT =
  rootIdx >= 0
    ? resolve(args[rootIdx + 1])
    : resolve(dirname(fileURLToPath(import.meta.url)), "..");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

const manifest = readJson(join(ROOT, "licenses/manifest.json"));
const modelsPath = join(ROOT, "app/src-tauri/resources/models.json");
const rawModels = existsSync(modelsPath) ? readJson(modelsPath) : null;
const models = rawModels && !Array.isArray(rawModels) ? (rawModels.models ?? []) : rawModels;
const genPath = join(ROOT, "app/src/generated/licenses.json");
if (!existsSync(genPath)) {
  console.error(
    "check-licenses: app/src/generated/licenses.json is missing. Run `node scripts/gen-licenses.mjs` first.",
  );
  process.exit(1);
}
const libraries = readJson(genPath).entries.filter((e) => e.kind === "library");

const { errors, review } = runChecks({ manifest, models, libraries, release });

for (const e of errors) console.error(`ERROR: ${e}`);
for (const r of review) console.error(`NEEDS DECISION: ${r}`);
if (errors.length || review.length) {
  console.error(
    `\ncheck-licenses failed (${errors.length} error(s), ${review.length} licence(s) needing a human decision).`,
  );
  console.error(`Allow-list: ${ALLOWED_SPDX.join(", ")}`);
  process.exit(1);
}
console.log(
  `check-licenses: OK (${manifest.length} manifest entries, ${models ? models.length : 0} models, ${libraries.length} dependencies${release ? ", release mode" : ""})`,
);
