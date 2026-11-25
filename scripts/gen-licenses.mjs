#!/usr/bin/env node
// Builds app/src/generated/licenses.json for the About page.
//
// Sources:
//  - licenses/manifest.json            hand-written app / runtime / model entries
//  - `pnpm --filter app licenses list --prod --json`   npm production dependencies of the app
//  - `cargo tree -e normal` + `cargo metadata`          Rust production dependencies
//    (no cargo-about / cargo-license is needed; both are plain `cargo` subcommands)
//
// Output shape: { entries: [{id,name,kind,version,license_spdx,license_url?,attribution?,
//                            source_url?,ecosystem?,text_ids:[...]}], texts: {id: text} }
// Licence texts are deduplicated by content hash.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderNotices, validateManifest } from "./lib/licenses.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "app/src/generated/licenses.json");
const CARGO_MANIFEST = join(ROOT, "app/src-tauri/Cargo.toml");

const texts = {};
function addText(text) {
  const id = createHash("sha256").update(text).digest("hex").slice(0, 16);
  texts[id] = text;
  return id;
}

const LICENSE_FILE = /^(licen[sc]e|copying|unlicense|notice)([-_.].*)?$/i;

/** Reads every licence-looking file directly inside `dir`; returns text ids. */
function textsFromDir(dir) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f) && statSync(join(dir, f)).isFile())
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8").trim())
    .filter((t) => t.length > 0)
    .map(addText);
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...opts,
  });
}

// ---- 1. hand-written manifest -------------------------------------------------------------
const manifest = JSON.parse(readFileSync(join(ROOT, "licenses/manifest.json"), "utf8"));
const manifestErrors = validateManifest(manifest);
if (manifestErrors.length) {
  console.error("licenses/manifest.json is invalid:\n  " + manifestErrors.join("\n  "));
  process.exit(1);
}
const appVersion = JSON.parse(
  readFileSync(join(ROOT, "app/src-tauri/tauri.conf.json"), "utf8"),
).version;

const entries = manifest.map((e) => {
  const { notice_file, ...rest } = e;
  const text_ids = [];
  if (notice_file) {
    const p = join(ROOT, "licenses", notice_file);
    if (!existsSync(p)) {
      console.error(`manifest entry "${e.id}": notice_file "${notice_file}" does not exist`);
      process.exit(1);
    }
    text_ids.push(addText(readFileSync(p, "utf8").trim()));
  }
  return { ...rest, version: e.kind === "app" ? appVersion : e.version, text_ids };
});

// ---- 2. npm production dependencies ---------------------------------------------------------
const npmJson = JSON.parse(sh("pnpm", ["--filter", "app", "licenses", "list", "--prod", "--json"]));
for (const [license, pkgs] of Object.entries(npmJson)) {
  for (const p of pkgs) {
    if (p.name.startsWith("@yadi/")) continue; // our own workspace packages
    p.versions.forEach((version, i) => {
      entries.push({
        id: `npm:${p.name}@${version}`,
        name: p.name,
        kind: "library",
        ecosystem: "npm",
        version,
        license_spdx: p.license ?? license,
        source_url: p.homepage,
        text_ids: textsFromDir(p.paths[i] ?? p.paths[0]),
      });
    });
  }
}

// ---- 3. Rust production dependencies --------------------------------------------------------
const tree = sh("cargo", [
  "tree",
  "--manifest-path",
  CARGO_MANIFEST,
  "-e",
  "normal",
  "--prefix",
  "none",
  "--target",
  "all",
  "-f",
  "{p}|{l}",
]);
const meta = JSON.parse(
  sh("cargo", ["metadata", "--format-version", "1", "--manifest-path", CARGO_MANIFEST], {
    stdio: ["ignore", "pipe", "ignore"],
  }),
);
const dirByKey = new Map(
  meta.packages.map((p) => [`${p.name}@${p.version}`, dirname(p.manifest_path)]),
);
const seenCrates = new Set();
let missingText = 0;
for (const raw of tree.split("\n")) {
  const line = raw.replace(/ \(\*\)$/, "").trim();
  const m = /^(\S+) v(\S+)(?: \((.*?)\))?\|(.*)$/.exec(line);
  if (!m) continue;
  const [, name, version, path, license] = m;
  if (path && path.startsWith("/")) continue; // local path crates (our own app)
  const key = `${name}@${version}`;
  if (seenCrates.has(key)) continue;
  seenCrates.add(key);
  const text_ids = textsFromDir(dirByKey.get(key));
  if (text_ids.length === 0) missingText++;
  entries.push({
    id: `cargo:${key}`,
    name,
    kind: "library",
    ecosystem: "cargo",
    version,
    license_spdx: license.trim() || "UNKNOWN",
    source_url: `https://crates.io/crates/${name}/${version}`,
    text_ids,
  });
}

entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : 0));
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ entries, texts }));
// The same data as plain text, shipped inside the installer (tauri.conf.json -> bundle.resources).
const NOTICES = join(ROOT, "app/src-tauri/resources/THIRD_PARTY_NOTICES.txt");
writeFileSync(NOTICES, renderNotices({ entries, texts }));
const libs = entries.filter((e) => e.kind === "library");
console.log(
  `gen-licenses: ${entries.length} entries (${manifest.length} hand-written, ${libs.filter((l) => l.ecosystem === "npm").length} npm, ` +
    `${libs.filter((l) => l.ecosystem === "cargo").length} cargo), ${Object.keys(texts).length} distinct texts, ` +
    `${missingText} crates without a licence file -> ${OUT.replace(ROOT + "/", "")}`,
);
