# Yadi

Speak your unfiltered thoughts. Yadi turns them into a clean, structured prompt you can paste into
any AI assistant. Speech recognition and the language model run **on your own computer**: after the
one-time setup download, Yadi works offline (it only goes online to check for updates when you ask).

> **Status: pre-release.** The app is built and tested, but there are no signed installers yet and
> the language models have not all been scored (see "Language models" below).

Platforms: macOS (Apple Silicon first) and Windows 10/11 (64-bit). Stack: Tauri 2 (Rust), React,
TypeScript, Vite, pnpm workspace.

## Install

There is no public download yet. To run it from source:

```sh
pnpm install
pnpm dev          # runs the app in development mode
pnpm build        # builds the installer (a .dmg on macOS, an NSIS .exe on Windows)
```

You need Node 20+, pnpm, Rust (stable) and, on macOS, the Xcode Command Line Tools; on Windows, the
MSVC build tools and WebView2. Installers are unsigned until a certificate is set up (see
"Releasing" below).

## First run

The first time Yadi starts it opens a short setup:

1. **Welcome:** shows your computer (memory, free disk), which models Yadi will use and how much
   it will download, and asks for your OK. Nothing is downloaded before you agree.
2. **Ollama:** the local engine that runs the language model. If it is not installed, Yadi can
   download the official installer, check its signature and install it, with your consent.
3. **Models:** the language model for your computer's size (about 2 to 5 GB) and two small speech
   models. Downloads resume if interrupted.
4. **Microphone and keyboard permissions**, then you are done. You can re-run or repair setup any
   time from Settings.

Free space needed: roughly 4 to 5 GB for a typical computer, more for the biggest model.

## Using Yadi

| Do this                          | What happens                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Hold the Y key** (about 0.4 s) | Yadi opens, from any app. A quick tap still types "y".                                                           |
| **Y** (in the Yadi window)       | Starts recording; press **Y** again to stop and make the prompt.                                                 |
| **Esc**                          | Stops what is happening. Esc again hides the window.                                                             |
| **Double-click a word**          | Fix it. The pencil edits the whole transcript. Yadi offers to remember the word.                                 |
| **Drop or paste files or text**  | Adds attachments (text, code, PDF, Word). Yadi uses their start to understand the topic and never rewrites them. |
| **Copy**                         | Copies the prompt. **Copy with attachment text** adds the attachments' contents.                                 |

The mascot is always on screen; click it to open or hide the chat. The menu-bar (tray) icon has
Show/Hide, About and Quit.

If holding Y does not work on your computer, switch to a shortcut such as **Cmd/Ctrl+Shift+Y** in
Settings. It is always available.

### Settings

Hold time (250 to 900 ms, with a test), shortcut, microphone, language model (with a warning if it
is too big for your computer), polishing the transcript after recording, start at login, your own
words (names and jargon), re-run setup, licences, and a reset.

### Language models

Yadi picks a language model for your computer's memory. The candidates are listed in
`app/src-tauri/resources/models.json`; `eval/results/SUMMARY.md` records how each scored on the
prompt-quality eval set. A model marked "untested" has not been scored yet.

## Privacy

- **Everything stays on your computer.** Your voice, the transcript and the prompts are never sent
  anywhere, never saved to disk and never written to logs. Audio exists only in memory while you
  record and is dropped right after the transcript is finished.
- **No telemetry, no accounts, no analytics.**
- **The only network use** is the setup download (speech models from `github.com`, the Ollama
  installer from `ollama.com`; the language model itself is pulled by Ollama from its own library)
  and **Settings > Check for updates**, which reads Yadi's public release information from
  `github.com` and downloads a new installer only when you press the button. Nothing about you is
  sent, and nothing is checked in the background. During normal use the only connection Yadi makes
  is to Ollama on your own machine (`127.0.0.1:11434`). The window's content-security policy and
  the HTTP permission list allow nothing else; the update check runs in the app itself.
- Attachments are read into memory for the session only, never executed, and treated as data: text
  inside a file cannot change what Yadi writes.

## Troubleshooting

- **Holding Y does nothing (macOS).** Yadi needs _Accessibility_ and _Input Monitoring_ permission
  to see the held key. Open System Settings > Privacy & Security, switch Yadi on in both, then
  restart Yadi. Until then it uses Cmd+Shift+Y.
- **No sound level / "microphone denied".** System Settings > Privacy & Security > Microphone:
  switch Yadi on. On Windows: Settings > Privacy > Microphone.
- **Antivirus warns about Yadi (Windows).** The Hold-Y feature uses a keyboard hook, which some
  antivirus programs flag. Choose a shortcut in Settings instead (no hook is used then) and, if you
  trust the build, allow Yadi in your antivirus.
- **"Could not reach the language model".** Yadi starts Ollama for you. If it still fails, open the
  Ollama app yourself, or check that nothing else uses port 11434.
- **"The language model is not installed".** Use "Open setup to install it" in the message, or
  Settings > Repair models.
- **The prompt is slow the first time.** The model is loading into memory; later prompts are
  faster. A smaller model (Settings) is faster still.
- **Something else.** Run the app from a terminal to see its log; the log never contains your
  words, only events and errors.

## Development

```sh
pnpm test         # vitest (all packages), script tests and cargo test
pnpm lint         # eslint, prettier --check, cargo fmt --check, cargo clippy -D warnings
pnpm typecheck
pnpm check:licenses   # licence data + THIRD_PARTY_NOTICES.txt + compliance checks
pnpm eval --model <ollama-tag> [--judge <ollama-tag>]   # score a model on eval/cases.jsonl
```

| Path             | What                                                                           |
| ---------------- | ------------------------------------------------------------------------------ |
| `app/`           | Tauri app (React frontend in `src/`, Rust in `src-tauri/`)                     |
| `packages/core/` | Pure TypeScript: state machine, transcript, prompt pipeline, attachments rules |
| `eval/`          | Prompt-quality eval set, scorers and runner                                    |
| `licenses/`      | Hand-written licence manifest for bundled runtimes and models                  |
| `scripts/`       | Licence tooling and test fixtures                                              |

Guidelines for contributors:

- The prompt pipeline's last step is **code, not a model**: the model returns structured findings,
  every detail needs a quote of what the person said as evidence, and a template renders the
  prompt. Do not let a model write the final prompt.
- **Privacy is a rule, not a preference:** never log transcripts, audio, prompts or attachment
  text, and never write them to disk. Tests check the redaction helper; reviewers check the rest.
- Add an eval case (`eval/cases.jsonl`, append only) whenever a real input fails. Prompt tuning
  must not look at the hold-out cases (every 4th case).
- Every new dependency must pass `pnpm check:licenses` (allow-list in
  `scripts/lib/licenses.mjs`; extending it needs a human decision).
- Windows behaviour cannot be run on a Mac: keep platform code compiling for both
  (`cargo clippy --target x86_64-pc-windows-msvc`) and add it to the manual QA list.

### Platform notes

- **macOS transparency:** the floating windows are transparent, which needs Tauri's
  `macOSPrivateApi` setting. Apps using it cannot be on the Mac App Store; direct distribution is
  unaffected.
- On macOS Yadi runs without a Dock icon (only the mascot and the menu-bar icon).

### Releasing

Signing and notarisation are instructions only and are not part of this repository's automation.
CI builds unsigned installers as workflow artifacts. The release owner follows the signing steps
kept with the project's release notes.

## Licence

Application code: Apache-2.0 (see `LICENSE`; a placeholder until the copyright holder confirms).
Bundled and downloaded third-party components, models and runtimes carry their own licences. They
are listed in the app under **About** and in `THIRD_PARTY_NOTICES.txt` inside the installer.
