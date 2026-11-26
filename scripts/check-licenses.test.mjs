import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateSpdx, runChecks, validateManifest } from "./lib/licenses.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "check-licenses.mjs");

const entry = (over = {}) => ({
  id: "ollama",
  name: "Ollama",
  kind: "runtime",
  version: "1",
  license_spdx: "MIT",
  license_url: "https://example.test/l",
  attribution: "x",
  source_url: "https://example.test/s",
  ...over,
});

test("evaluateSpdx accepts allow-listed expressions", () => {
  for (const e of [
    "MIT",
    "MIT OR Apache-2.0",
    "Apache-2.0/MIT",
    "Apache-2.0 / MIT",
    "(MIT OR Apache-2.0) AND Unicode-3.0",
    "Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT",
    "MIT OR Apache-2.0 OR LGPL-2.1-or-later", // one allowed alternative is enough
    "BSD-3-Clause AND MIT",
  ]) {
    assert.equal(evaluateSpdx(e), true, e);
  }
});

test("evaluateSpdx rejects anything else", () => {
  for (const e of [
    "GPL-3.0-only",
    "MIT AND GPL-3.0-only",
    "LGPL-2.1-or-later",
    "UNKNOWN",
    "",
    "MIT OR",
    "(MIT",
    "LicenseRef-x",
  ]) {
    assert.equal(evaluateSpdx(e), false, JSON.stringify(e));
  }
});

test("validateManifest flags missing fields, bad kind and duplicate ids", () => {
  const errs = validateManifest([entry(), entry({ kind: "thing" }), { id: "z" }]);
  assert.ok(errs.some((e) => e.includes('kind "thing"')));
  assert.ok(errs.some((e) => e.includes("duplicate id")));
  assert.ok(errs.some((e) => e.includes('missing or empty "name"')));
});

test("a model without a manifest entry fails with a clear message", () => {
  const { errors } = runChecks({
    manifest: [entry()],
    models: [{ id: "whisper-base.en", license_id: "whisper-base-en" }],
  });
  assert.equal(errors.length, 1);
  assert.match(
    errors[0],
    /model "whisper-base\.en" references license_id "whisper-base-en" which has no entry in licenses\/manifest\.json/,
  );
});

test("a model without license_id fails", () => {
  const { errors } = runChecks({ manifest: [entry()], models: [{ id: "m" }] });
  assert.match(errors[0], /has no license_id/);
});

test("UNVERIFIED model licence fails only with --release", () => {
  const manifest = [entry({ id: "m1", kind: "model", license_spdx: "UNVERIFIED" })];
  assert.equal(runChecks({ manifest, release: false }).errors.length, 0);
  const { errors } = runChecks({ manifest, release: true });
  assert.match(errors[0], /UNVERIFIED and --release/);
});

test("UNVERIFIED on a non-model is not a release error", () => {
  const manifest = [entry({ license_spdx: "UNVERIFIED" })];
  assert.equal(runChecks({ manifest, release: true }).errors.length, 0);
});

test("dependency with a licence outside the allow-list needs a human decision", () => {
  const { review } = runChecks({
    manifest: [entry()],
    libraries: [
      { ecosystem: "npm", name: "ok", version: "1.0.0", license_spdx: "MIT" },
      { ecosystem: "cargo", name: "bad", version: "2.0.0", license_spdx: "GPL-3.0-only" },
    ],
  });
  assert.equal(review.length, 1);
  assert.match(review[0], /cargo:bad@2\.0\.0 .*GPL-3\.0-only.*human decision/);
});

function fixtureRoot({ models, libraries = [] }) {
  const root = mkdtempSync(join(tmpdir(), "yadi-lic-"));
  mkdirSync(join(root, "licenses"), { recursive: true });
  mkdirSync(join(root, "app/src-tauri/resources"), { recursive: true });
  mkdirSync(join(root, "app/src/generated"), { recursive: true });
  writeFileSync(join(root, "licenses/manifest.json"), JSON.stringify([entry()]));
  if (models)
    writeFileSync(join(root, "app/src-tauri/resources/models.json"), JSON.stringify(models));
  writeFileSync(
    join(root, "app/src/generated/licenses.json"),
    JSON.stringify({ entries: libraries, texts: {} }),
  );
  return root;
}

test("CLI: fails (exit 1) when a model has no manifest entry", () => {
  const root = fixtureRoot({ models: [{ id: "stt-x", license_id: "missing-entry" }] });
  const r = spawnSync("node", [CLI, "--root", root], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /model "stt-x" references license_id "missing-entry" which has no entry/);
});

test("CLI: passes with a matching model entry and no models.json at all", () => {
  const ok = fixtureRoot({ models: [{ id: "stt-x", license_id: "ollama" }] });
  assert.equal(spawnSync("node", [CLI, "--root", ok], { encoding: "utf8" }).status, 0);
  const none = fixtureRoot({});
  assert.equal(spawnSync("node", [CLI, "--root", none], { encoding: "utf8" }).status, 0);
});

test("CLI: prints disallowed dependency licences and exits 1", () => {
  const root = fixtureRoot({
    libraries: [
      {
        kind: "library",
        ecosystem: "npm",
        name: "evil",
        version: "1.0.0",
        license_spdx: "AGPL-3.0-only",
      },
    ],
  });
  const r = spawnSync("node", [CLI, "--root", root], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /npm:evil@1\.0\.0/);
});

// ---- third-party notices (Task 22) -----------------------------------------------------------

import { renderNotices } from "./lib/licenses.mjs";

const NOTICE_DATA = {
  entries: [
    {
      id: "yadi",
      name: "Yadi",
      kind: "app",
      version: "0.1.0",
      license_spdx: "Apache-2.0",
      attribution: "Copyright Elara Software Services FZ-LLC.",
      source_url: "https://example.org/yadi",
      text_ids: ["aaa"],
    },
    {
      id: "serde",
      name: "serde",
      kind: "library",
      version: "1.0.0",
      license_spdx: "MIT OR Apache-2.0",
      text_ids: ["bbb", "aaa"],
    },
    { id: "nolic", name: "zeta", kind: "library", version: "2", license_spdx: "MIT", text_ids: [] },
  ],
  texts: { aaa: "APACHE TEXT", bbb: "MIT TEXT" },
};

test("renderNotices lists every component with its licence and attribution", () => {
  const text = renderNotices(NOTICE_DATA);
  assert.match(text, /^Yadi: third-party notices/);
  assert.match(text, /APPLICATION/);
  assert.match(text, /LIBRARIES/);
  assert.match(text, /Yadi 0\.1\.0\n {2}Licence: Apache-2\.0\n {2}Copyright Elara Software Services FZ-LLC\./);
  assert.match(text, /Source: https:\/\/example\.org\/yadi/);
  assert.match(text, /serde 1\.0\.0\n {2}Licence: MIT OR Apache-2\.0/);
});

test("renderNotices prints each licence text once and refers to it by number", () => {
  const text = renderNotices(NOTICE_DATA);
  assert.equal(text.split("APACHE TEXT").length - 1, 1);
  assert.equal(text.split("MIT TEXT").length - 1, 1);
  // aaa sorts first -> [1]; serde uses bbb ([2]) and aaa ([1])
  assert.match(text, /Licence text: \[2\], \[1\]/);
  assert.match(text, /\[1\]\nAPACHE TEXT/);
  assert.match(text, /\[2\]\nMIT TEXT/);
});

test("renderNotices copes with components that have no licence file", () => {
  const text = renderNotices(NOTICE_DATA);
  assert.match(text, /zeta 2\n {2}Licence: MIT\n {2}Licence text: not shipped with this component/);
});

test("renderNotices is deterministic", () => {
  assert.equal(renderNotices(NOTICE_DATA), renderNotices(structuredClone(NOTICE_DATA)));
});
