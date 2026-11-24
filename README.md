# Yadi

> **Work in progress.** Not usable yet.

Yadi is a local-first desktop app for macOS and Windows. You speak unfiltered thoughts. It transcribes them live and offline, then uses a local [Ollama](https://ollama.com) model to turn them into a clean, token-efficient prompt with a Copy button. After the one-time setup download, nothing needs the internet. No telemetry; your voice and prompts never leave the device.

Stack: Tauri 2 (Rust), React, TypeScript, Vite, pnpm workspace.

## Layout

| Path             | What                                                       |
| ---------------- | ---------------------------------------------------------- |
| `app/`           | Tauri app (React frontend in `src/`, Rust in `src-tauri/`) |
| `packages/core/` | Pure TypeScript: state machine, pipeline, renderer         |
| `eval/`          | Prompt-quality eval set and runner                         |
| `licenses/`      | Hand-written licence manifest for bundled models/runtimes  |
| `scripts/`       | Helper scripts                                             |

## Development setup

Prerequisites: Node 20+, pnpm, Rust (stable) with `cargo`, and on macOS the Xcode Command Line Tools. On Windows, the MSVC build tools and WebView2.

```sh
pnpm install
pnpm dev          # runs the Tauri app in dev mode
pnpm test         # vitest (all packages) + cargo test
pnpm lint         # eslint, prettier --check, cargo fmt --check, cargo clippy
pnpm typecheck
pnpm build        # production bundle
```

## Platform notes

- **macOS transparency:** the floating mascot and chat windows are transparent, which requires Tauri's `macOSPrivateApi` setting (`app.macOSPrivateApi` in `tauri.conf.json` plus the `macos-private-api` cargo feature). Apps that use private macOS APIs cannot be distributed through the Mac App Store; direct distribution is unaffected.
- The app runs as an "Accessory" on macOS: no Dock icon, only the floating mascot and the menu-bar tray icon.

## License

Apache-2.0 (see `LICENSE`). Bundled third-party models and runtimes carry their own licences, listed in the app under About.
