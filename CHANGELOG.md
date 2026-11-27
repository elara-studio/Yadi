# Changelog

What changed in each version of Yadi, newest first. Downloads are on the
[Releases page](https://github.com/elara-studio/Yadi/releases).

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
- **A shorter closing line:** "If anything is missing or unclear, ask me before answering."

### Measured

On the eval set (granite4:3b, judged by qwen3:8b), prompts are about a quarter shorter than in
0.1.0 relative to what was said. The overall score went from 0.833 to 0.847, and every prompt
followed the layout (1.000, was 0.857). Short requests can still come out longer than what was
said, because the prompt adds structure and the closing line. Details are in
[`eval/results/SUMMARY.md`](eval/results/SUMMARY.md).

## 0.1.0 · 2026-11-26

The first preview: hold **Y**, talk, and get a clean, structured prompt. Speech recognition and
the language model run on your own computer. macOS (Apple Silicon) and Windows (x64) installers,
not signed yet.
