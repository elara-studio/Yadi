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
## 2026-11-25 · granite4:3b
> Task 17 candidate run, judge qwen3:8b. Machine was also busy with other work, so latency is approximate.

- Judge: `qwen3:8b`
- Cases: 42
- **Mean score: 0.782** · hold-out 0.800 · tuning set 0.777
- Per check: faithful 0.929, no_invention 0.976, retractions 1.000, template 0.643, concise 0.286, clarify 0.643, assumptions 1.000
- Per category: already-good 0.714 (1), asr-errors 0.714 (4), attachment 0.786 (2), coding-android 0.762 (3), coding-backend 0.857 (1), coding-web 0.714 (2), constraints 0.714 (1), data 0.762 (3), data-ml 0.714 (1), filler-heavy 0.857 (2), format-request 0.857 (2), general 0.800 (5), long-ramble 0.857 (2), math 0.929 (2), multi-task 0.571 (1), self-correction 0.762 (3), sensitive 0.857 (1), vague 0.857 (2), writing 0.714 (2), writing-email 0.786 (2)
- Mean token ratio (out/in): 3.234 (approximate tokens)
- Latency: p50 4267 ms, p95 9737 ms
- Degraded prompts: 0 · judge failures: 0
- Failures: and-01 [concise, clarify]; and-02 [template, clarify]; and-03 [template, concise, clarify]; and-04 [concise]; web-01 [template, concise, clarify]; web-02 [concise]; web-03 [concise]; data-01 [concise]; data-02 [concise, clarify]; data-03 [template, concise]; wr-01 [concise]; wr-02 [concise, clarify]; wr-03 [clarify]; wr-04 [faithful, template, concise]; gen-01 [template, concise]; gen-02 [concise]; gen-03 [concise]; gen-04 [concise, clarify]; gen-05 [concise]; math-01 [faithful]; corr-01 [template]; corr-02 [template, concise]; corr-03 [template, concise]; filler-01 [clarify]; filler-02 [clarify]; ramble-01 [concise]; ramble-02 [concise]; vague-01 [concise]; vague-02 [concise]; att-01 [concise]; att-02 [concise, clarify]; tech-01 [template, concise]; tech-03 [template, concise, clarify]; ml-01 [template, concise]; fmt-01 [template]; fmt-02 [template]; good-01 [template, clarify]; sens-01 [concise]; multi-01 [faithful, no_invention, clarify]; lang-01 [concise, clarify]
## 2026-11-25 · qwen3:4b-instruct-2507-q4_K_M
> Task 17 candidate run, judge qwen3:8b. Machine was also busy with other work, so latency is approximate.

- Judge: `qwen3:8b`
- Cases: 42
- **Mean score: 0.823** · hold-out 0.771 · tuning set 0.839
- Per check: faithful 0.929, no_invention 1.000, retractions 0.976, template 0.929, concise 0.190, clarify 0.738, assumptions 1.000
- Per category: already-good 0.714 (1), asr-errors 0.821 (4), attachment 0.714 (2), coding-android 0.857 (3), coding-backend 0.857 (1), coding-web 0.714 (2), constraints 0.857 (1), data 0.714 (3), data-ml 0.857 (1), filler-heavy 1.000 (2), format-request 0.857 (2), general 0.857 (5), long-ramble 0.857 (2), math 0.786 (2), multi-task 0.857 (1), self-correction 0.762 (3), sensitive 0.857 (1), vague 0.857 (2), writing 0.857 (2), writing-email 0.857 (2)
- Mean token ratio (out/in): 3.646 (approximate tokens)
- Latency: p50 9449 ms, p95 11894 ms
- Degraded prompts: 0 · judge failures: 0
- Failures: and-01 [concise, clarify]; and-03 [concise]; and-04 [concise]; web-01 [concise, clarify]; web-02 [template, concise]; web-03 [concise]; data-01 [faithful, concise, clarify]; data-02 [concise]; data-03 [concise, clarify]; wr-01 [concise]; wr-02 [concise]; wr-03 [concise]; wr-04 [concise]; gen-01 [concise]; gen-02 [concise]; gen-03 [concise]; gen-04 [faithful]; gen-05 [concise]; math-01 [faithful, template]; math-02 [clarify]; corr-02 [concise, clarify]; corr-03 [retractions, concise, clarify]; ramble-01 [concise]; ramble-02 [concise]; vague-01 [concise]; vague-02 [concise]; att-01 [concise, clarify]; att-02 [concise, clarify]; tech-01 [concise, clarify]; tech-02 [concise]; tech-03 [concise]; ml-01 [concise]; fmt-01 [template]; fmt-02 [concise]; good-01 [concise, clarify]; sens-01 [concise]; multi-01 [concise]; lang-01 [concise]
## 2026-11-25 · qwen3:1.7b
> Task 17 candidate run, judge qwen3:8b. Machine was also busy with other work, so latency is approximate.

- Judge: `qwen3:8b`
- Cases: 42
- **Mean score: 0.765** · hold-out 0.771 · tuning set 0.763
- Per check: faithful 0.976, no_invention 1.000, retractions 0.905, template 0.905, concise 0.024, clarify 0.548, assumptions 1.000
- Per category: already-good 0.714 (1), asr-errors 0.714 (4), attachment 0.714 (2), coding-android 0.667 (3), coding-backend 0.857 (1), coding-web 0.786 (2), constraints 0.857 (1), data 0.810 (3), data-ml 0.857 (1), filler-heavy 0.714 (2), format-request 0.786 (2), general 0.829 (5), long-ramble 0.857 (2), math 0.643 (2), multi-task 0.857 (1), self-correction 0.619 (3), sensitive 0.857 (1), vague 0.857 (2), writing 0.786 (2), writing-email 0.786 (2)
- Mean token ratio (out/in): 4.356 (approximate tokens)
- Latency: p50 2642 ms, p95 7687 ms
- Degraded prompts: 0 · judge failures: 0
- Failures: and-01 [template, concise, clarify]; and-02 [retractions, concise, clarify]; and-03 [concise, clarify]; and-04 [concise]; web-01 [concise, clarify]; web-02 [concise]; web-03 [concise]; data-01 [faithful, concise]; data-02 [concise]; data-03 [concise]; wr-01 [concise, clarify]; wr-02 [concise]; wr-03 [concise, clarify]; wr-04 [concise]; gen-01 [concise]; gen-02 [concise]; gen-03 [concise]; gen-04 [concise, clarify]; gen-05 [concise]; math-01 [template, concise, clarify]; math-02 [concise, clarify]; corr-01 [retractions, concise, clarify]; corr-02 [retractions, concise]; corr-03 [retractions, concise, clarify]; filler-01 [concise, clarify]; filler-02 [concise, clarify]; ramble-01 [concise]; ramble-02 [concise]; vague-01 [concise]; vague-02 [concise]; att-01 [concise, clarify]; att-02 [concise, clarify]; tech-01 [concise]; tech-02 [concise, clarify]; tech-03 [template, concise, clarify]; ml-01 [concise]; fmt-01 [template, concise, clarify]; good-01 [concise, clarify]; sens-01 [concise]; multi-01 [concise]; lang-01 [concise]
## 2026-11-25 · phi4-mini:3.8b
> Task 17 candidate run, judge qwen3:8b. Machine was also busy with other work, so latency is approximate.

- Judge: `qwen3:8b`
- Cases: 42
- **Mean score: 0.799** · hold-out 0.757 · tuning set 0.813
- Per check: faithful 0.929, no_invention 1.000, retractions 0.952, template 0.929, concise 0.262, clarify 0.524, assumptions 1.000
- Per category: already-good 0.857 (1), asr-errors 0.821 (4), attachment 0.857 (2), coding-android 0.810 (3), coding-backend 0.714 (1), coding-web 0.857 (2), constraints 0.571 (1), data 0.762 (3), data-ml 0.714 (1), filler-heavy 1.000 (2), format-request 0.929 (2), general 0.771 (5), long-ramble 0.786 (2), math 0.714 (2), multi-task 0.857 (1), self-correction 0.714 (3), sensitive 0.857 (1), vague 0.857 (2), writing 0.714 (2), writing-email 0.786 (2)
- Mean token ratio (out/in): 3.465 (approximate tokens)
- Latency: p50 12172 ms, p95 16460 ms
- Degraded prompts: 0 · judge failures: 0
- Failures: and-01 [concise, clarify]; and-03 [concise]; and-04 [concise, clarify]; web-02 [concise, clarify]; web-03 [concise, clarify]; data-01 [concise, clarify]; data-02 [concise]; data-03 [concise, clarify]; wr-01 [concise]; wr-02 [concise, clarify]; wr-03 [clarify]; wr-04 [faithful, concise, clarify]; gen-01 [concise, clarify]; gen-02 [concise, clarify]; gen-03 [concise]; gen-04 [concise]; gen-05 [concise, clarify]; math-01 [faithful, concise]; math-02 [concise, clarify]; corr-01 [retractions]; corr-02 [faithful, retractions, template, clarify]; corr-03 [concise]; ramble-01 [concise]; ramble-02 [concise, clarify]; vague-01 [concise]; vague-02 [concise]; att-01 [concise]; att-02 [concise]; tech-01 [concise, clarify]; tech-02 [concise]; tech-03 [concise]; ml-01 [concise, clarify]; fmt-01 [concise]; good-01 [template]; sens-01 [clarify]; multi-01 [clarify]; lang-01 [template, concise, clarify]
## 2026-11-25 · qwen3:8b
> Task 17 candidate run, judge gemma3:latest. Machine was also busy with other work, so latency is approximate.

- Judge: `gemma3:latest`
- Cases: 42
- **Mean score: 0.779** · hold-out 0.743 · tuning set 0.790
- Per check: faithful 1.000, no_invention 0.857, retractions 0.929, template 0.929, concise 0.190, clarify 0.833, assumptions 0.714
- Per category: already-good 0.714 (1), asr-errors 0.857 (4), attachment 0.643 (2), coding-android 0.857 (3), coding-backend 0.857 (1), coding-web 0.857 (2), constraints 0.857 (1), data 0.905 (3), data-ml 0.571 (1), filler-heavy 0.929 (2), format-request 0.714 (2), general 0.800 (5), long-ramble 0.714 (2), math 0.929 (2), multi-task 0.714 (1), self-correction 0.476 (3), sensitive 0.714 (1), vague 0.714 (2), writing 0.786 (2), writing-email 0.786 (2)
- Mean token ratio (out/in): 3.674 (approximate tokens)
- Latency: p50 21485 ms, p95 29258 ms
- Degraded prompts: 0 · judge failures: 0
- Failures: and-01 [concise, clarify]; and-03 [concise]; and-04 [concise]; web-02 [concise, assumptions]; web-03 [concise]; data-01 [concise]; data-03 [concise]; wr-01 [no_invention, concise]; wr-02 [concise]; wr-03 [concise, assumptions]; wr-04 [concise]; gen-01 [concise, assumptions]; gen-02 [concise]; gen-03 [concise]; gen-04 [concise]; gen-05 [concise, assumptions]; math-02 [clarify]; corr-01 [retractions, concise, clarify, assumptions]; corr-02 [retractions, concise]; corr-03 [retractions, template, concise, clarify, assumptions]; filler-02 [no_invention]; ramble-01 [concise, assumptions]; ramble-02 [no_invention, concise]; vague-01 [concise, assumptions]; vague-02 [concise, assumptions]; att-01 [concise, clarify, assumptions]; att-02 [concise, clarify]; tech-01 [concise]; tech-02 [concise]; tech-03 [concise]; ml-01 [no_invention, concise, assumptions]; fmt-01 [template]; fmt-02 [no_invention, template, concise]; good-01 [concise, clarify]; sens-01 [no_invention, concise]; multi-01 [concise, assumptions]; lang-01 [concise]
## 2026-11-25 · granite4:3b
> Task 18 FINAL run (all 42 cases, tuned prompts), judge qwen3:8b.

- Judge: `qwen3:8b`
- Cases: 42
- **Mean score: 0.833** · hold-out 0.800 · tuning set 0.844
- Per check: faithful 0.976, no_invention 1.000, retractions 1.000, template 0.857, concise 0.452, clarify 0.548, assumptions 1.000
- Per category: already-good 0.857 (1), asr-errors 0.857 (4), attachment 0.786 (2), coding-android 0.857 (3), coding-backend 0.714 (1), coding-web 0.786 (2), constraints 0.714 (1), data 0.857 (3), data-ml 0.714 (1), filler-heavy 1.000 (2), format-request 0.857 (2), general 0.800 (5), long-ramble 0.857 (2), math 0.857 (2), multi-task 0.857 (1), self-correction 0.905 (3), sensitive 0.857 (1), vague 0.786 (2), writing 0.786 (2), writing-email 0.786 (2)
- Mean token ratio (out/in): 2.846 (approximate tokens)
- Latency: p50 2967 ms, p95 6604 ms
- Degraded prompts: 0 · judge failures: 0
- Failures: and-01 [concise]; and-03 [concise]; and-04 [concise, clarify]; web-01 [template]; web-02 [concise, clarify]; web-03 [concise, clarify]; data-01 [clarify]; data-03 [concise, clarify]; wr-01 [concise]; wr-02 [concise, clarify]; wr-03 [clarify]; wr-04 [template, concise]; gen-01 [template, clarify]; gen-02 [concise, clarify]; gen-03 [concise]; gen-04 [concise]; gen-05 [concise]; math-01 [faithful]; math-02 [clarify]; corr-02 [concise, clarify]; ramble-01 [clarify]; ramble-02 [clarify]; vague-01 [concise, clarify]; vague-02 [concise]; att-01 [concise]; att-02 [template, concise]; tech-01 [concise, clarify]; tech-03 [concise]; ml-01 [concise, clarify]; fmt-01 [template]; fmt-02 [concise]; good-01 [template]; sens-01 [clarify]; multi-01 [clarify]; lang-01 [concise, clarify]
## 2026-11-25 · qwen3:4b-instruct-2507-q4_K_M
> Task 18 FINAL run (all 42 cases, tuned prompts), judge qwen3:8b.

- Judge: `qwen3:8b`
- Cases: 42
- **Mean score: 0.806** · hold-out 0.729 · tuning set 0.830
- Per check: faithful 0.952, no_invention 0.952, retractions 0.976, template 0.976, concise 0.238, clarify 0.548, assumptions 1.000
- Per category: already-good 0.857 (1), asr-errors 0.821 (4), attachment 0.714 (2), coding-android 0.905 (3), coding-backend 0.857 (1), coding-web 0.786 (2), constraints 0.714 (1), data 0.714 (3), data-ml 0.714 (1), filler-heavy 0.857 (2), format-request 0.929 (2), general 0.829 (5), long-ramble 0.714 (2), math 0.714 (2), multi-task 0.714 (1), self-correction 0.857 (3), sensitive 0.857 (1), vague 0.857 (2), writing 0.786 (2), writing-email 0.786 (2)
- Mean token ratio (out/in): 3.326 (approximate tokens)
- Latency: p50 4894 ms, p95 11742 ms
- Degraded prompts: 0 · judge failures: 0
- Failures: and-03 [concise]; and-04 [concise, clarify]; web-01 [concise]; web-02 [concise, clarify]; web-03 [clarify]; data-01 [faithful, no_invention, concise, clarify]; data-02 [concise]; data-03 [concise]; wr-01 [concise]; wr-02 [concise, clarify]; wr-03 [concise, clarify]; wr-04 [concise]; gen-01 [concise, clarify]; gen-02 [clarify]; gen-03 [concise]; gen-04 [concise]; gen-05 [concise]; math-01 [faithful, concise]; math-02 [concise, clarify]; corr-02 [clarify]; corr-03 [retractions, concise]; filler-01 [concise, clarify]; ramble-01 [no_invention, concise, clarify]; ramble-02 [concise]; vague-01 [concise]; vague-02 [concise]; att-01 [concise, clarify]; att-02 [concise, clarify]; tech-01 [concise, clarify]; tech-02 [concise]; tech-03 [concise]; ml-01 [concise, clarify]; fmt-02 [concise]; good-01 [concise]; sens-01 [clarify]; multi-01 [concise, clarify]; lang-01 [template, clarify]
## 2026-11-25 · qwen3:1.7b
> Task 18 FINAL run (all 42 cases, tuned prompts), judge qwen3:8b.

- Judge: `qwen3:8b`
- Cases: 42
- **Mean score: 0.793** · hold-out 0.743 · tuning set 0.808
- Per check: faithful 0.929, no_invention 0.929, retractions 0.905, template 0.976, concise 0.238, clarify 0.571, assumptions 1.000
- Per category: already-good 0.857 (1), asr-errors 0.857 (4), attachment 0.857 (2), coding-android 0.810 (3), coding-backend 0.714 (1), coding-web 0.714 (2), constraints 0.714 (1), data 0.714 (3), data-ml 0.714 (1), filler-heavy 0.929 (2), format-request 0.857 (2), general 0.771 (5), long-ramble 0.857 (2), math 0.714 (2), multi-task 0.714 (1), self-correction 0.667 (3), sensitive 0.857 (1), vague 0.857 (2), writing 0.857 (2), writing-email 0.786 (2)
- Mean token ratio (out/in): 3.331 (approximate tokens)
- Latency: p50 1900 ms, p95 3238 ms
- Degraded prompts: 0 · judge failures: 0
- Failures: and-02 [retractions, concise]; and-03 [concise]; and-04 [concise, clarify]; web-01 [concise]; web-02 [no_invention, concise, clarify]; web-03 [concise, clarify]; data-01 [faithful, concise, clarify]; data-02 [concise]; data-03 [concise, clarify]; wr-01 [no_invention, concise]; wr-02 [clarify]; wr-03 [concise]; wr-04 [clarify]; gen-01 [concise, clarify]; gen-02 [faithful, concise, clarify]; gen-03 [concise]; gen-04 [concise]; gen-05 [concise]; math-01 [faithful, template]; math-02 [concise, clarify]; corr-01 [retractions, concise]; corr-02 [retractions, concise, clarify]; corr-03 [retractions, concise]; filler-01 [concise]; ramble-01 [clarify]; ramble-02 [clarify]; vague-01 [concise]; vague-02 [concise]; att-01 [concise]; att-02 [concise]; tech-01 [concise, clarify]; tech-03 [concise]; ml-01 [concise, clarify]; fmt-01 [concise]; fmt-02 [concise]; good-01 [concise]; sens-01 [clarify]; multi-01 [no_invention, clarify]; lang-01 [concise, clarify]
## 2026-11-25 · phi4-mini:3.8b
> Task 18 FINAL run (all 42 cases, tuned prompts), judge qwen3:8b.

- Judge: `qwen3:8b`
- Cases: 42
- **Mean score: 0.786** · hold-out 0.786 · tuning set 0.786
- Per check: faithful 0.881, no_invention 0.976, retractions 0.952, template 0.952, concise 0.238, clarify 0.500, assumptions 1.000
- Per category: already-good 0.857 (1), asr-errors 0.821 (4), attachment 0.857 (2), coding-android 0.857 (3), coding-backend 0.714 (1), coding-web 0.786 (2), constraints 0.714 (1), data 0.762 (3), data-ml 0.714 (1), filler-heavy 1.000 (2), format-request 0.857 (2), general 0.743 (5), long-ramble 0.857 (2), math 0.786 (2), multi-task 0.571 (1), self-correction 0.667 (3), sensitive 0.857 (1), vague 0.714 (2), writing 0.714 (2), writing-email 0.786 (2)
- Mean token ratio (out/in): 3.092 (approximate tokens)
- Latency: p50 12200 ms, p95 14469 ms
- Degraded prompts: 0 · judge failures: 0
- Failures: and-01 [concise]; and-03 [concise]; and-04 [concise, clarify]; web-01 [concise]; web-02 [concise, clarify]; web-03 [concise, clarify]; data-01 [concise, clarify]; data-02 [concise]; data-03 [concise, clarify]; wr-01 [concise]; wr-02 [faithful, clarify]; wr-03 [concise, clarify]; wr-04 [faithful, clarify]; gen-01 [concise, clarify]; gen-02 [concise, clarify]; gen-03 [concise]; gen-04 [faithful, concise]; gen-05 [concise, clarify]; math-01 [faithful]; math-02 [concise, clarify]; corr-01 [retractions, concise]; corr-02 [faithful, retractions, template, clarify]; corr-03 [concise]; ramble-01 [concise]; ramble-02 [clarify]; vague-01 [concise, clarify]; vague-02 [concise, clarify]; att-01 [concise]; att-02 [concise]; tech-01 [concise, clarify]; tech-02 [concise]; tech-03 [concise]; ml-01 [concise, clarify]; fmt-01 [concise]; fmt-02 [concise]; good-01 [template]; sens-01 [clarify]; multi-01 [no_invention, concise, clarify]; lang-01 [concise, clarify]
## 2026-11-25 · qwen3:8b
> Task 18 FINAL run (all 42 cases, tuned prompts), judge gemma3:latest.

- Judge: `gemma3:latest`
- Cases: 42
- **Mean score: 0.769** · hold-out 0.714 · tuning set 0.786
- Per check: faithful 0.976, no_invention 0.857, retractions 0.929, template 1.000, concise 0.238, clarify 0.571, assumptions 0.810
- Per category: already-good 0.857 (1), asr-errors 0.821 (4), attachment 0.643 (2), coding-android 0.857 (3), coding-backend 0.714 (1), coding-web 0.857 (2), constraints 0.714 (1), data 0.762 (3), data-ml 0.571 (1), filler-heavy 0.929 (2), format-request 0.786 (2), general 0.771 (5), long-ramble 0.786 (2), math 0.857 (2), multi-task 0.857 (1), self-correction 0.524 (3), sensitive 0.714 (1), vague 0.714 (2), writing 0.786 (2), writing-email 0.786 (2)
- Mean token ratio (out/in): 3.328 (approximate tokens)
- Latency: p50 22583 ms, p95 26987 ms
- Degraded prompts: 0 · judge failures: 0
- Failures: and-01 [concise]; and-03 [concise]; and-04 [concise, clarify]; web-02 [concise, clarify]; web-03 [concise, clarify]; data-01 [concise, clarify]; data-02 [assumptions]; data-03 [concise, clarify]; wr-01 [concise]; wr-02 [no_invention, clarify]; wr-03 [clarify]; wr-04 [concise, clarify]; gen-01 [concise, clarify]; gen-02 [concise, clarify]; gen-03 [concise]; gen-04 [concise]; gen-05 [concise, assumptions]; math-02 [concise, clarify]; corr-01 [retractions, concise, assumptions]; corr-02 [faithful, retractions, concise, clarify]; corr-03 [retractions, concise, assumptions]; filler-02 [no_invention]; ramble-01 [concise]; ramble-02 [no_invention, clarify]; vague-01 [concise, assumptions]; vague-02 [concise, assumptions]; att-01 [concise, clarify, assumptions]; att-02 [no_invention, concise]; tech-01 [concise, clarify]; tech-02 [concise]; tech-03 [concise]; ml-01 [no_invention, concise, clarify]; fmt-01 [concise]; fmt-02 [concise, assumptions]; good-01 [concise]; sens-01 [no_invention, concise]; multi-01 [clarify]; lang-01 [concise, clarify]
## 2026-11-27 · granite4:3b
> v0.1.1 prompt changes (no repeated details, plain form for task-only requests, shorter clarify line, retraction rule for changed facts), 44 cases incl. the new corr-04/corr-05, judge qwen3:8b. Compare with the 2026-11-25 granite4:3b block (42 cases): 0.833, template 0.857, concise 0.452, ratio 2.846.

- Judge: `qwen3:8b`
- Cases: 44
- **Mean score: 0.847** · hold-out 0.753 · tuning set 0.879
- Per check: faithful 0.955, no_invention 0.955, retractions 1.000, template 1.000, concise 0.545, clarify 0.477, assumptions 1.000
- Per category: already-good 1.000 (1), asr-errors 0.857 (4), attachment 0.786 (2), coding-android 0.857 (3), coding-backend 0.857 (1), coding-web 0.857 (2), constraints 0.714 (1), data 0.762 (3), data-ml 0.714 (1), filler-heavy 1.000 (2), format-request 0.929 (2), general 0.829 (5), long-ramble 0.786 (2), math 0.857 (2), multi-task 0.857 (1), self-correction 0.914 (5), sensitive 0.714 (1), vague 0.786 (2), writing 0.857 (2), writing-email 0.857 (2)
- Mean token ratio (out/in): 2.130 (approximate tokens)
- Latency: p50 9546 ms, p95 11717 ms
- Degraded prompts: 0 · judge failures: 0
- Failures: and-01 [concise]; and-03 [concise]; and-04 [concise, clarify]; web-01 [clarify]; web-02 [clarify]; web-03 [clarify]; data-01 [faithful, concise, clarify]; data-03 [concise, clarify]; wr-01 [concise]; wr-02 [clarify]; wr-03 [clarify]; wr-04 [concise]; gen-01 [clarify]; gen-02 [concise, clarify]; gen-03 [concise]; gen-04 [concise]; gen-05 [concise]; math-01 [faithful]; math-02 [clarify]; corr-02 [clarify]; ramble-01 [clarify]; ramble-02 [no_invention, clarify]; vague-01 [clarify]; vague-02 [concise, clarify]; att-01 [concise]; att-02 [concise, clarify]; tech-01 [concise, clarify]; tech-03 [concise]; ml-01 [concise, clarify]; fmt-02 [concise]; sens-01 [no_invention, clarify]; multi-01 [clarify]; lang-01 [concise, clarify]; corr-05 [concise, clarify]

## 2026-11-27 · qwen3:4b-instruct-2507-q4_K_M
> Baseline for the round-5 work: the 0.1.1 prompts on 47 cases (44 + real-01..03, three real sessions that came out wordy), judge qwen3:8b.

- Judge: `qwen3:8b`
- Cases: 47
- **Mean score: 0.875** · hold-out 0.779 · tuning set 0.905
- Per check: faithful 0.957, no_invention 0.872, retractions 1.000, template 1.000, concise 0.681, clarify 0.617, assumptions 1.000
- Per category: already-good 0.857 (1), asr-errors 0.964 (4), attachment 0.714 (2), coding-android 0.905 (3), coding-backend 0.857 (1), coding-web 0.786 (2), constraints 0.857 (1), data 0.810 (3), data-ml 0.714 (1), filler-heavy 0.929 (2), format-request 1.000 (2), general 0.914 (5), long-ramble 0.857 (2), math 0.786 (2), multi-task 0.857 (1), real-session 0.952 (3), self-correction 0.914 (5), sensitive 0.714 (1), vague 0.857 (2), writing 0.857 (2), writing-email 0.857 (2)
- Mean token ratio (out/in): 1.728 (approximate tokens)
- Latency: p50 12299 ms, p95 19180 ms
- Degraded prompts: 0 · judge failures: 0
- Failures: and-04 [concise, clarify]; web-02 [no_invention, concise, clarify]; web-03 [clarify]; data-01 [faithful, no_invention, clarify]; data-03 [clarify]; wr-01 [concise]; wr-02 [clarify]; wr-03 [clarify]; wr-04 [concise]; gen-01 [clarify]; gen-02 [clarify]; gen-05 [concise]; math-01 [faithful, no_invention]; math-02 [clarify]; corr-02 [clarify]; filler-02 [concise]; ramble-01 [concise]; ramble-02 [concise]; vague-01 [concise]; vague-02 [concise]; att-01 [concise, clarify]; att-02 [concise, clarify]; tech-01 [clarify]; ml-01 [concise, clarify]; good-01 [concise]; sens-01 [concise, clarify]; multi-01 [clarify]; lang-01 [clarify]; corr-04 [no_invention]; corr-05 [no_invention]; real-03 [no_invention]
## 2026-11-27 · qwen3:4b-instruct-2507-q4_K_M
> Round 5 (shipped on improve/shorter-prompts): short quote-first notes, the model labels repeats_task / turned_down and code removes them, render guards for repeats. Same 47 cases and judge as the baseline block above.

- Judge: `qwen3:8b`
- Cases: 47
- **Mean score: 0.869** · hold-out 0.805 · tuning set 0.889
- Per check: faithful 0.979, no_invention 0.894, retractions 1.000, template 1.000, concise 0.574, clarify 0.638, assumptions 1.000
- Per category: already-good 0.714 (1), asr-errors 0.929 (4), attachment 0.786 (2), coding-android 0.905 (3), coding-backend 0.714 (1), coding-web 0.786 (2), constraints 0.857 (1), data 0.857 (3), data-ml 0.714 (1), filler-heavy 1.000 (2), format-request 1.000 (2), general 0.886 (5), long-ramble 0.857 (2), math 0.786 (2), multi-task 0.857 (1), real-session 0.952 (3), self-correction 0.886 (5), sensitive 0.714 (1), vague 0.857 (2), writing 0.857 (2), writing-email 0.857 (2)
- Mean token ratio (out/in): 1.740 (approximate tokens)
- Latency: p50 14891 ms, p95 19807 ms
- Degraded prompts: 0 · judge failures: 0
- Failures: and-04 [concise, clarify]; web-02 [no_invention, concise, clarify]; web-03 [concise, clarify]; data-01 [concise, clarify]; data-03 [concise]; wr-01 [concise]; wr-02 [clarify]; wr-03 [clarify]; wr-04 [concise]; gen-01 [concise, clarify]; gen-02 [clarify]; gen-05 [concise]; math-01 [faithful]; math-02 [concise, clarify]; corr-02 [clarify]; ramble-01 [concise]; ramble-02 [concise]; vague-01 [concise]; vague-02 [concise]; att-01 [concise, clarify]; att-02 [concise]; tech-01 [clarify]; tech-02 [concise]; ml-01 [concise, clarify]; good-01 [concise, clarify]; sens-01 [no_invention, clarify]; multi-01 [clarify]; lang-01 [clarify]; corr-04 [no_invention]; corr-05 [no_invention, concise]; real-03 [no_invention]
