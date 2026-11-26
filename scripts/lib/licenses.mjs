// Pure helpers for the licence manifest, SPDX evaluation and the compliance checks.
// No I/O here so everything is unit-testable (see scripts/check-licenses.test.mjs).

export const KINDS = ["app", "library", "runtime", "model"];
export const KIND_LABELS = {
  app: "Application",
  runtime: "Runtimes",
  model: "Models",
  library: "Libraries",
};

/** Allow-list from PLAN.md Task 04. Do not extend it without a human decision. */
export const ALLOWED_SPDX = [
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MPL-2.0",
  "Unicode-3.0",
  "CC0-1.0",
  "0BSD",
  "Zlib",
  "CC-BY-4.0",
  // Fonts (Outfit). Added by the project owner on 2026-11-26.
  "OFL-1.1",
];

export const UNVERIFIED = "UNVERIFIED";

const REQUIRED_FIELDS = [
  "id",
  "name",
  "kind",
  "version",
  "license_spdx",
  "license_url",
  "attribution",
  "source_url",
];

/** Returns a list of human-readable problems with the hand-written manifest. */
export function validateManifest(entries) {
  const errors = [];
  if (!Array.isArray(entries)) return ["manifest must be a JSON array"];
  const seen = new Set();
  entries.forEach((e, i) => {
    const label = `manifest entry #${i + 1}${e && e.id ? ` (${e.id})` : ""}`;
    for (const f of REQUIRED_FIELDS) {
      if (typeof e?.[f] !== "string" || e[f].trim() === "")
        errors.push(`${label}: missing or empty "${f}"`);
    }
    if (e?.kind && !KINDS.includes(e.kind))
      errors.push(`${label}: kind "${e.kind}" must be one of ${KINDS.join(", ")}`);
    if (e?.id) {
      if (seen.has(e.id)) errors.push(`${label}: duplicate id`);
      seen.add(e.id);
    }
  });
  return errors;
}

// ---- SPDX expression evaluation -------------------------------------------------------

function tokenize(expr) {
  const normalised = expr.replace(/\//g, " OR ");
  return normalised.match(/\(|\)|[^\s()]+/g) ?? [];
}

/**
 * Evaluates an SPDX licence expression against an allow-list.
 * `A OR B` passes if either side passes, `A AND B` needs both. `X WITH exception` is judged
 * by `X` (an exception only adds permissions). Legacy "A/B" means "A OR B".
 * Anything unparsable fails.
 */
export function evaluateSpdx(expr, allowed = ALLOWED_SPDX) {
  const tokens = tokenize(String(expr ?? ""));
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (t, op) => t !== undefined && t.toUpperCase() === op;

  function parseOr() {
    let ok = parseAnd();
    while (isOp(peek(), "OR")) {
      pos++;
      const rhs = parseAnd();
      ok = ok || rhs;
    }
    return ok;
  }
  function parseAnd() {
    let ok = parseTerm();
    while (isOp(peek(), "AND")) {
      pos++;
      const rhs = parseTerm();
      ok = ok && rhs;
    }
    return ok;
  }
  function parseTerm() {
    const t = peek();
    if (t === undefined) throw new Error("unexpected end");
    if (t === "(") {
      pos++;
      const ok = parseOr();
      if (peek() !== ")") throw new Error("missing )");
      pos++;
      return ok;
    }
    if (t === ")" || isOp(t, "AND") || isOp(t, "OR") || isOp(t, "WITH"))
      throw new Error(`unexpected ${t}`);
    pos++;
    if (isOp(peek(), "WITH")) {
      pos++;
      if (peek() === undefined) throw new Error("WITH without exception");
      pos++;
    }
    return allowed.includes(t);
  }

  try {
    const ok = parseOr();
    return pos === tokens.length ? ok : false;
  } catch {
    return false;
  }
}

// ---- compliance checks ------------------------------------------------------------------

/**
 * @param {object} input
 * @param {object[]} input.manifest   hand-written entries
 * @param {object[]|null} input.models entries of models.json (null when the file does not exist)
 * @param {object[]} input.libraries  auto-collected production dependencies {name, version, ecosystem, license_spdx}
 * @param {boolean} input.release
 * @returns {{errors: string[], review: string[]}}
 *   `errors` fail the build. `review` lists dependencies whose licence is not on the allow-list
 *   and needs a human decision (they also fail the build).
 */
export function runChecks({ manifest, models = null, libraries = [], release = false }) {
  const errors = [...validateManifest(manifest)];
  const review = [];
  const ids = new Set((manifest ?? []).map((e) => e?.id));

  // (a) every shipped model needs a manifest entry
  for (const m of models ?? []) {
    if (!m.license_id) errors.push(`model "${m.id}" in models.json has no license_id`);
    else if (!ids.has(m.license_id)) {
      errors.push(
        `model "${m.id}" references license_id "${m.license_id}" which has no entry in licenses/manifest.json`,
      );
    }
  }

  // (b) release builds must not ship models with an unverified licence
  if (release) {
    for (const e of manifest ?? []) {
      if (e?.kind === "model" && e.license_spdx === UNVERIFIED) {
        errors.push(`model "${e.id}" has license_spdx UNVERIFIED and --release was passed`);
      }
    }
  }

  // (c) production dependencies must be on the allow-list
  for (const lib of libraries) {
    if (!evaluateSpdx(lib.license_spdx)) {
      review.push(
        `${lib.ecosystem}:${lib.name}@${lib.version} has licence "${lib.license_spdx}" (not on the allow-list; needs a human decision)`,
      );
    }
  }

  return { errors, review };
}

/**
 * Plain-text third-party notices for the installer: every component with its licence and
 * attribution, then each distinct licence text once. Pure, so it can be tested.
 * `data` is the shape of app/src/generated/licenses.json: { entries, texts }.
 */
export function renderNotices({ entries, texts }) {
  const rule = "=".repeat(78);
  const textNumbers = new Map(
    Object.keys(texts)
      .sort()
      .map((id, i) => [id, i + 1]),
  );
  const out = [
    "Yadi: third-party notices",
    "",
    "Yadi is built with the components below. Each is used under the licence shown; the full",
    "text of every licence follows the list. Language and speech models run on this computer",
    "and are downloaded on first use from the sources named in the list.",
    "",
  ];
  const byKind = (kind) => entries.filter((e) => e.kind === kind);
  for (const kind of KINDS) {
    const group = byKind(kind);
    if (group.length === 0) continue;
    out.push(rule, KIND_LABELS[kind].toUpperCase(), rule, "");
    for (const e of group.sort((a, b) => a.name.localeCompare(b.name))) {
      out.push(`${e.name} ${e.version ?? ""}`.trim());
      out.push(`  Licence: ${e.license_spdx}`);
      if (e.attribution) out.push(`  ${e.attribution}`);
      if (e.source_url) out.push(`  Source: ${e.source_url}`);
      const refs = (e.text_ids ?? []).map((id) => textNumbers.get(id)).filter(Boolean);
      if (refs.length) out.push(`  Licence text: ${refs.map((n) => `[${n}]`).join(", ")}`);
      else
        out.push(
          "  Licence text: not shipped with this component; standard texts: https://spdx.org/licenses/",
        );
      out.push("");
    }
  }
  out.push(rule, "LICENCE TEXTS", rule, "");
  for (const [id, n] of textNumbers) {
    out.push(`[${n}]`, texts[id].trim(), "", "-".repeat(78), "");
  }
  return out.join("\n");
}
