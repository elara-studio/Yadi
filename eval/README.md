# Prompt-pipeline eval set

`cases.jsonl`: 42 messy spoken inputs (one JSON object per line) used to compare local models and pipeline versions.

## Fields

| Field | Meaning |
|---|---|
| `id`, `category` | Case id and group (coding, writing, self-correction, vague, attachment, ...) |
| `transcript` | Raw speech-to-text output, with fillers, retractions and ASR errors on purpose |
| `must_include` | Facts the optimized prompt must keep, in any wording |
| `must_not_add` | Specifics the user never gave. If they appear as fact, it is a hallucination. |
| `must_not_include` | Things the user retracted, which must be gone |
| `role` | Acceptable role framing, deduced only from what was said |
| `expect_clarify` | The prompt must lean on its "ask me clarifying questions" line, because key info is missing |
| `attachment` | The prompt must refer to the attachment, not invent its content |
| `traps` | What this case is specifically testing |

## Scoring (per case, 0 or 1 each)

1. **Faithful**: every `must_include` item is present, and every number or name is exact.
2. **No invention**: nothing from `must_not_add` is stated as fact.
3. **Retractions honored**: nothing from `must_not_include` is present.
4. **Template**: the prompt follows the fixed layout (Role, Task, Context, Constraints, Output, Attachments, Clarify line, in that order, empty sections left out). A request that is only a task may be a plain sentence followed by the clarify line.
5. **Concise**: the prompt is shorter than the transcript, or at most 1.5x for very short inputs, with no filler.
6. **Clarify behavior**: if `expect_clarify` is true, the prompt tells the target agent to ask for the missing details. If it is false, no unnecessary questions are added.
7. **Assumptions marked**: any deduced detail is labeled "Assumed:", never stated as fact.

Score = passed checks / 7. Track the mean overall, per category, and tokens in vs out.

## Rules for adding cases

- Real speech patterns: fillers, restarts, mis-heard technical terms.
- Always list at least one `must_not_add` trap.
- Never use real names, company data or secrets.
- Add a case whenever a real user input fails in testing.
