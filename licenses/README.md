# Licence manifest

`manifest.json` is a hand-written JSON array. Every thing Yadi bundles or depends on at run time that is **not** an npm or Rust dependency (the app itself, runtimes such as Ollama, speech and language models) needs an entry. npm and Rust production dependencies are collected automatically.

## Entry schema

| Field          | Required | Meaning                                                                                                      |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `id`           | yes      | Unique id. A model in `app/src-tauri/resources/models.json` points at it with `license_id`.                  |
| `name`         | yes      | Display name.                                                                                                |
| `kind`         | yes      | `app`, `library`, `runtime` or `model`.                                                                      |
| `version`      | yes      | Version or a short description.                                                                              |
| `license_spdx` | yes      | SPDX id, or the literal `UNVERIFIED` when the licence has not been confirmed (fails `--release` for models). |
| `license_url`  | yes      | Where the licence is published.                                                                              |
| `attribution`  | yes      | Copyright / attribution line, as the upstream states it.                                                     |
| `source_url`   | yes      | The URL you actually read to verify the licence (LICENSE file, model card or README).                        |
| `notice_file`  | no       | Path under `licenses/` to the full licence text, shown in About.                                             |

Only add an entry after reading the upstream licence or model card. Never guess.

## Tooling

- `node scripts/gen-licenses.mjs` merges the manifest with the production dependencies and writes `app/src/generated/licenses.json` (gitignored). npm: `pnpm --filter app licenses list --prod --json`. Rust: `cargo tree -e normal` plus `cargo metadata` (no `cargo-about` or `cargo-license` needed). Licence files are read from each package directory and deduplicated by content hash.
- `node scripts/check-licenses.mjs [--release]` fails when (a) a model in `models.json` has no manifest entry, (b) with `--release`, a model entry is `UNVERIFIED`, (c) a production dependency's licence is not on the allow-list: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MPL-2.0, Unicode-3.0, CC0-1.0, 0BSD, Zlib, CC-BY-4.0. `A OR B` needs one allowed side, `A AND B` needs both, `X WITH exception` is judged by `X`, legacy `A/B` means `A OR B`. Disallowed ones are printed for a human decision; do not extend the list yourself.
- `pnpm check:licenses` runs both. `pnpm build` and CI run it.
- Tests: `node --test "scripts/**/*.test.mjs"` (part of `pnpm test`).
