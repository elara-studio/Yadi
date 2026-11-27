# Changelog

What changed in each version of Yadi, newest first. Downloads are on the
[Releases page](https://github.com/elara-studio/Yadi/releases).

## Unreleased

### New

- **Uninstall Yadi… (macOS).** In the tray menu. Stops the background helper, removes the login
  items and moves Yadi to the Trash, optionally with your settings and downloaded models. Before,
  Finder refused to delete Yadi because the helper was still running.

### Improved

- **Shorter, cleaner prompts.** Each detail is now a short note instead of your whole sentence,
  and it appears once: details the task already says and options you turned down are left out. A
  simple request ("a name for a white and brown dog") comes back as one plain sentence. Long
  rambles come out about a quarter shorter than before.

### Fixed

- **Hold-Y now reopens Yadi after you quit it (macOS).** The helper that listens while Yadi is
  closed asked macOS to open Yadi, but macOS took the helper itself for the running Yadi and
  opened nothing.
- The helper now keeps a log (`~/Library/Logs/com.elarasoftware.yadi/summon-listener.log`), so a
  summon that does not open Yadi can be traced.

## 0.1.1 · 2026-11-27

### New

- **See the tokens Yadi saves you.** When the prompt comes out shorter than what you said, confetti
  and the mascot tell you roughly how many tokens you saved. No confetti if you turned mascot
  animations off, or if your system asks for reduced motion.
- **Token counts under each text.** Your recorded words show their approximate token count under
  them, and the prompt shows its own under it, with what was saved.
- **A local savings history.** Each prompt's token counts (numbers only, never your words) are
  kept on your computer, ready for a future overview. **Settings > Reset everything** clears it.

### Better prompts

- **No more repeats.** Context no longer restates what the task already says. Before, "Write an
  email for my CV to the recruiter" could come with two Context lines saying the same thing again.
- **Simple requests stay simple.** A request with nothing to add beyond the task is now one plain
  sentence instead of a one-line template.
- **Smarter corrections.** "Thursday, actually it moved to Friday" now keeps only Friday, unless
  the change itself is the point ("tell the team the demo moved from Thursday to Friday").
- **"Ask me" only when needed.** The line asking the assistant to check with you now appears
  only when something seems to be missing, next to what that is. It is also shorter: "If anything
  is missing or unclear, ask me before answering."

### Measured

On the eval set (granite4:3b, judged by qwen3:8b, before the "ask me" change) the overall score
went from 0.833 to 0.847, and every prompt followed the layout (1.000, was 0.857). Details are in
[`eval/results/SUMMARY.md`](eval/results/SUMMARY.md).

## 0.1.0 · 2026-11-26

The first preview: hold **Y**, talk, and get a clean, structured prompt. Speech recognition and
the language model run on your own computer. macOS (Apple Silicon) and Windows (x64) installers,
not signed yet.
