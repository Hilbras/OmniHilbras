# Performance baseline and resource limits

Phase 9 evidence. Measured with `apps/gateway/bench/gateway-baseline.mjs`: the real HTTP route, a deterministic
in-process provider with a fixed 5 ms delay, and streams of 20 chunks. These numbers measure the gateway's own
cost plus queuing under load. They do not measure a live provider, a real network, or a remote client.

## Environment

Node v24.21.0, linux-x64, 4 CPUs. No target was set. The roadmap asks for a baseline before any target.

## Baseline (concurrency 25, 400 non-streaming and 100 streaming requests)

| Run | Non-stream p50 | p95 | throughput | First chunk p50 |
| --- | --- | --- | --- | --- |
| 1 (cold) | 43.49 ms | 198.72 ms | 408 req/s | 21.64 ms |
| 2 | 30.71 ms | 144.54 ms | 588 req/s | 19.85 ms |
| 3 | 30.62 ms | 132.34 ms | 602 req/s | 19.81 ms |

Runs 2 and 3 are the steady state. Run 1 includes a cold start, so it is recorded but not used as the baseline.

## Concurrency sensitivity (800 non-streaming requests)

| Concurrency | p50 | p99 | throughput | Errors |
| --- | --- | --- | --- | --- |
| 100 | 41.13 ms | 1135.2 ms | 664 req/s | 0 |
| 400 | 447.67 ms | 1356.8 ms | 531 req/s | 0 |

Latency rises sharply between 100 and 400 concurrent requests, and throughput falls. The gateway does not fail
under that load, but it degrades. RSS stayed at about 42 MB across these runs.

## Resource limits, as found

- **Chat request body:** capped at 1 MB by default, checked against `content-length` and as bytes arrive. Verified:
  a 1.1 MB body is refused with `400 INVALID_REQUEST` through the real route.
- **Connection and key bodies:** capped at 16 KB and 4 KB respectively (`http.ts`).
- **Concurrent inference requests:** **not capped.** The only in-flight guard is the health-sweep deduplication. The
  measurement above shows what that means under load.

## Not done

- **A concurrency cap** is the finding the measurement supports, but choosing its default is a product decision.
  Adding it without that decision would change behaviour for every deployment, so it is left for the maintainer.
- **Load on a real network**, with real connections and a remote client, is not measured.
- **Soak behaviour** (memory over hours) is not measured. The 42 MB figure is from short runs only.
- **Event-loop delay** and **cancellation latency** are not measured by this benchmark.
- **Cleanup of temporary timers and readers after failures** is covered by the existing load tests, not re-measured here.
