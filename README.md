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

## License

Apache-2.0 (see `LICENSE`). Bundled third-party models and runtimes carry their own licences, listed in the app under About.
