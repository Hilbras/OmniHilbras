# Concurrency benchmark — 2026-11-20

Measured with `node scripts/benchmark-concurrency.mjs --n 400 --concurrency 400` (committed harness; local
immediate adapter, no provider network). Node v26.13.1, linux/x64, 400 simultaneous requests, 0 errors.

| Run | p50 | p95 | p99 |
| --- | --- | --- | --- |
| 2026-11-19 baseline (report, harness not committed) | 447 ms | — | 1357 ms |
| 2026-11-20 measured | 742.53 ms | 1102.97 ms | 1126.73 ms |

**Honest reading:** this is **not** an unambiguous improvement. p99 improved (1357 → 1127 ms), but p50 is higher
(447 → 742 ms). The two runs are on different Node versions and the old harness no longer exists, so the
comparison is indicative, not proof of a regression or a win. The shared rate-limit store added in Phase 9
coordinates counts across instances but does not make the single-process hot path faster; claiming otherwise
would be false. Any future speed-up must be demonstrated with the committed harness on the same runtime.

## Same-runtime A/B (2026-11-20, authoritative for "improves")

The old report's numbers were on a different Node version with a harness that is no longer committed, so they
cannot prove an improvement. `scripts/benchmark-concurrency-ab.mjs` loads **both** builds in one process and
measures **server-side** processing time (request arrival → response finish) under 400 concurrent clients,
alternating A/B over 9 rounds. Server-side time is the right metric: a CPU profile showed round-trip at this
concurrency is dominated by the client's undici `internalConnect`/`writev` and GC, which swamps gateway changes.

| Build | server-side p50 | server-side p99 |
| --- | --- | --- |
| baseline `v3.79.0` | 0.49 ms | 1.15 ms |
| current (fast dispatch) | 0.39 ms | 1.07 ms |

Two independent runs measured p50 0.77→0.72 ms / p99 7.97→6.86 ms (6.5% / 13.9%) and p50 0.49→0.39 ms /
p99 1.15→1.07 ms (20% / 7.6%). Both show the current build faster on the gateway's own path. The fast dispatch
lets the LLM surface skip the 23 earlier handlers that all decline those paths, while `handleInferenceRoute`
keeps its own auth gate — so no check is skipped. Round-trip latency remains noisy and is not claimed improved.

## CPU-time A/B (most stable measure)

Wall-clock p99 at 400 concurrent fetches swings by ±400 ms between identical runs because the client's
`internalConnect`/`writev`/GC dominates. `scripts/benchmark-concurrency-cpu.mjs` measures
`process.cpuUsage()` across a whole 400-request batch, with both builds loaded in one process and measured
alternately over 11 rounds. CPU time reflects the work the gateway actually did; the client is identical for
both builds. Measured: baseline 755.8 ms CPU/batch vs current 708.0 ms — a **6.3% reduction**. This is the
most stable evidence that the fast dispatch improves the gateway's own path.

