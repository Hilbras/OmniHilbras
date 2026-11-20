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
