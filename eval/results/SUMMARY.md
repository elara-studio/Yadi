# Eval summary

One block per run, newest last. Scores are the mean share of the 7 checks passed (see eval/README.md). The hold-out set is every 4th case; prompt tuning never looks at it.

## 2026-11-24 · llama3.2:latest
> RUNNER VALIDATION run 1 of 2 on a locally installed model that is NOT a Task 13 candidate (llama3.2, 3.2B); judge gemma3 (4.3B). Not a candidate result, not used for tier decisions.

- Judge: `gemma3:latest`
- Cases: 42
- **Mean score: 0.714** · hold-out 0.729 · tuning set 0.710
- Per check: faithful 1.000, no_invention 0.905, retractions 0.952, template 1.000, concise 0.024, clarify 0.548, assumptions 0.571
- Per category: already-good 0.571 (1), asr-errors 0.679 (4), attachment 0.643 (2), coding-android 0.762 (3), coding-backend 0.857 (1), coding-web 0.714 (2), constraints 0.857 (1), data 0.762 (3), data-ml 0.571 (1), filler-heavy 0.786 (2), format-request 0.714 (2), general 0.714 (5), long-ramble 0.714 (2), math 0.786 (2), multi-task 0.714 (1), self-correction 0.619 (3), sensitive 0.571 (1), vague 0.714 (2), writing 0.786 (2), writing-email 0.714 (2)
- Mean token ratio (out/in): 4.302 (approximate tokens)
- Latency: p50 3692 ms, p95 8484 ms
- Degraded prompts: 0 · judge failures: 0
- Failures: and-01 [concise, clarify]; and-02 [concise, clarify]; and-03 [concise, clarify]; and-04 [concise]; web-01 [concise, clarify]; web-02 [concise, assumptions]; web-03 [concise]; data-01 [concise]; data-02 [concise, clarify, assumptions]; data-03 [concise]; wr-01 [concise, clarify, assumptions]; wr-02 [concise]; wr-03 [concise, assumptions]; wr-04 [concise]; gen-01 [concise]; gen-02 [concise]; gen-03 [concise, clarify, assumptions]; gen-04 [concise, clarify, assumptions]; gen-05 [concise, assumptions]; math-01 [concise, clarify]; math-02 [concise]; corr-01 [retractions, concise, clarify]; corr-02 [retractions, concise]; corr-03 [concise, clarify, assumptions]; filler-01 [concise, clarify]; filler-02 [clarify]; ramble-01 [concise, assumptions]; ramble-02 [no_invention, concise]; vague-01 [concise, assumptions]; vague-02 [no_invention, concise]; att-01 [concise, clarify, assumptions]; att-02 [concise, clarify]; tech-01 [concise]; tech-02 [concise, clarify, assumptions]; tech-03 [concise, clarify, assumptions]; ml-01 [no_invention, concise, assumptions]; fmt-01 [concise, clarify]; fmt-02 [concise, assumptions]; good-01 [concise, clarify, assumptions]; sens-01 [no_invention, concise, assumptions]; multi-01 [concise, assumptions]; lang-01 [concise]
## 2026-11-24 · llama3.2:latest
> RUNNER VALIDATION run 2 of 2 (same model and judge, stability check; not a Task 13 candidate).

- Judge: `gemma3:latest`
- Cases: 42
- **Mean score: 0.704** · hold-out 0.743 · tuning set 0.692
- Per check: faithful 1.000, no_invention 0.881, retractions 0.952, template 0.976, concise 0.024, clarify 0.548, assumptions 0.548
- Per category: already-good 0.571 (1), asr-errors 0.714 (4), attachment 0.643 (2), coding-android 0.714 (3), coding-backend 0.571 (1), coding-web 0.714 (2), constraints 0.857 (1), data 0.762 (3), data-ml 0.571 (1), filler-heavy 0.714 (2), format-request 0.714 (2), general 0.686 (5), long-ramble 0.786 (2), math 0.714 (2), multi-task 0.714 (1), self-correction 0.571 (3), sensitive 0.714 (1), vague 0.714 (2), writing 0.786 (2), writing-email 0.786 (2)
- Mean token ratio (out/in): 4.272 (approximate tokens)
- Latency: p50 3362 ms, p95 5642 ms
- Degraded prompts: 0 · judge failures: 0
- Failures: and-01 [concise, clarify]; and-02 [concise, clarify, assumptions]; and-03 [concise, clarify]; and-04 [concise]; web-01 [concise, clarify]; web-02 [concise, assumptions]; web-03 [template, concise, assumptions]; data-01 [concise]; data-02 [concise, clarify, assumptions]; data-03 [concise]; wr-01 [concise, clarify]; wr-02 [concise]; wr-03 [concise, assumptions]; wr-04 [concise]; gen-01 [no_invention, concise]; gen-02 [concise]; gen-03 [concise, clarify, assumptions]; gen-04 [concise, clarify, assumptions]; gen-05 [concise, assumptions]; math-01 [concise, clarify]; math-02 [concise, assumptions]; corr-01 [retractions, concise, clarify]; corr-02 [concise, assumptions]; corr-03 [retractions, concise, clarify, assumptions]; filler-01 [concise, clarify]; filler-02 [no_invention, clarify]; ramble-01 [concise, assumptions]; ramble-02 [concise]; vague-01 [concise, assumptions]; vague-02 [no_invention, concise]; att-01 [concise, clarify, assumptions]; att-02 [concise, clarify]; tech-01 [concise]; tech-02 [concise, clarify]; tech-03 [concise, clarify, assumptions]; ml-01 [no_invention, concise, assumptions]; fmt-01 [concise, clarify]; fmt-02 [concise, assumptions]; good-01 [concise, clarify, assumptions]; sens-01 [no_invention, concise]; multi-01 [concise, assumptions]; lang-01 [concise]
