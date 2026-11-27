# Prompt tuning (Task 18)

Model tuned: **granite4:3b** (the low-tier candidate, the one furthest from the target). Judge: `qwen3:8b`. Scorers, eval cases and the hold-out set (every 4th case) were **not** changed or looked at. Only `prompts.ts` and `fewshot.ts` changed. Tuning rounds ran on the 32 non-hold-out cases.

| Round | Tuning-set mean | faithful | no_invention | retractions | template | concise | clarify | assumptions | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Baseline (Task 17, untuned) | 0.777 | 0.93 | 0.98 | 1.00 | 0.64 | 0.29 | 0.64 | 1.00 | all 42: mean 0.782, hold-out 0.800 (per-check column is all 42 cases) |
| Round 1 | 0.795 | 0.94 | 0.97 | 1.00 | 0.59 | 0.41 | 0.66 | 1.00 | 32 tuning cases, 0 degraded |
| Round 2 | 0.799 | 1.00 | 1.00 | 1.00 | 0.50 | 0.44 | 0.66 | 1.00 | 32 tuning cases, 0 degraded |
| Round 3 | 0.835 | 1.00 | 1.00 | 1.00 | 0.84 | 0.47 | 0.53 | 1.00 | 32 tuning cases, 0 degraded |

## What changed in each round

1. **Analyze prompt:** context items must be short, concrete facts; `missing_info` only for details the assistant cannot do without, empty when the request stands on its own. Result: small gain (0.777 to 0.795); template unchanged because the model still left Context empty.
2. **Analyze prompt:** the task sentence is only the action; every named detail goes into Context even if the task also says it; `missing_info` is empty when in doubt. Result: 0.799; template got worse (0.50): the 3B model ignored the instruction and returned an empty Context (confirmed by running the pipeline on one case and reading the raw analysis).
3. **Teaching by example:** two new few-shot examples (a Flutter question, a Bash backup script) that show details in Context and an empty `missing_info`, plus a one-line reminder at the end of the Analyze request. Result: **0.835**, template 0.84. The trade-off: `clarify` dropped (0.66 to 0.53) because the model now asks fewer questions, including in the cases that expect them.

Three rounds were used (the maximum). No scorer was changed.

## Final run on all 42 cases (tuned prompts)

| Model | Mean | Hold-out | Degraded | p50 latency | Target (mean >= 0.80, hold-out >= 0.75) |
|---|---|---|---|---|---|
| granite4:3b | 0.833 | 0.800 | 0 | 3.0 s | **met** |
| qwen3:4b-instruct-2507 (q4_K_M) | 0.806 | 0.729 | 0 | 4.9 s | mean met, hold-out 0.02 short |
| qwen3:1.7b | 0.793 | 0.743 | 0 | 1.9 s | not met (0.007 / 0.007 short) |
| phi4-mini:3.8b | 0.786 | 0.786 | 0 | 12.2 s | mean 0.014 short |
| qwen3:8b | 0.769 | 0.714 | 0 | 22.6 s | not met; **judged by `gemma3`**, a weaker judge (invention 0.86, assumptions 0.81), so not comparable |

`gemma4:e2b` and `gemma4:e4b` were not pulled (disk space) and stay untested.

## Reading the numbers

- The hold-out set has only 10 cases, so one case moves a hold-out score by 0.1 / 7 checks = about 0.014 and a model's hold-out score easily swings by 0.03 between runs. Differences of that size are not evidence.
- **granite4:3b meets the target and is the fastest of the 3B to 4B class**; it is the recommendation for the low tier. For the mid tier `qwen3:4b-instruct-2507` is close (mean 0.806 but hold-out 0.729) and slower (4.9 s). Granite scored better than it on this set, so the mid-tier choice is genuinely open: **recommended pending user review**, not decided.
- **`concise` is the weak check for every model (0.24 to 0.45)**: see Task 17's finding that the fixed layout cannot satisfy the "shorter than the transcript" rule on short inputs. It was left as specified.
- **`clarify` is 0.50 to 0.57 for every model**: the cases that expect clarifying questions and the cases that expect none pull the prompt in opposite directions. Better results need either a stronger model or a decision about what the eval should reward.
- The tuned prompt was also run on the four other models without further change: the tuning mostly helped granite and left the others about where they were (qwen3:4b 0.823 to 0.806, phi4-mini 0.799 to 0.786, qwen3:1.7b 0.765 to 0.793), all within run-to-run noise.

## Checks

- `pnpm --filter @yadi/eval run check:fewshot`: no few-shot example equals, contains or is contained in an eval transcript (8 examples, 42 cases).
- All pipeline tests still pass (`@yadi/core` 248).

## Shorter prompts (after 0.1.1, qwen3:4b-instruct, 47 cases, judge qwen3:8b)

Three real sessions came out wordy (sentences copied into Context, the task repeated as
constraints, a turned-down city kept). They were added as `real-01`..`real-03` and five rounds were
compared against the 0.1.1 prompts on all 47 cases:

| Round | Mean | Tokens out (47 cases) | concise | real-01 / 02 / 03 tokens | Change |
|---|---|---|---|---|---|
| 0.1.1 baseline | 0.875 | 2,045 | 0.68 | 14 / 92 / 180 | |
| 2 | 0.848 | 2,476 | 0.43 | 88 / 87 / 122 | short notes, `evidence` before `text`, context vs constraints defined |
| 3 | 0.851 | 2,595 | 0.43 | 59 / 108 / 153 | + "no notes about the user or the request" |
| 4 | 0.851 | 2,145 | 0.55 | 27 / 86 / 139 | "say each thing once", few-shots made consistent, near-repeat guard |
| **5** | 0.869 | **2,021** | 0.57 | **11 / 71 / 125** | the model labels `repeats_task` / `turned_down`, code removes them |

What we learned:

- **Labelling beats omitting.** Rules that ask the 4B model to leave something out ("drop options
  the person turned down") were ignored in every round. Asking it to label each item and removing
  labelled items in code worked: real-01 became the plain sentence, and the total went below the
  baseline for the first time. A `repeats_task` label is ignored when the item has a number the
  task lacks, so a wrong label cannot cost a budget or a date.
- **Writing the quote first** (`evidence` before `text` in the schema) stopped the model copying
  whole sentences into the note.
- **Stage 1 (cleanup) is fragile; leave it alone.** Every attempt to make it cut more (drop
  openers, keep only the chosen option, "remove whatever does not change the meaning") made it
  rewrite numbers (400 euros became "40.00" or "40-500") or delete real requirements ("in
  English", "a Slack message"). Safer cuts belong in Stage 0 (code) or behind a number check.
- The mean score is within run-to-run noise of the baseline (0.869 vs 0.875). The new
  `no_invention` failures were read by hand and invent nothing; the judge varies between runs.
- Open: the Analyze prompt grew from about 2,360 to about 2,960 tokens against `num_ctx` 4096, so
  a very long ramble plus an attachment has less room than before.
