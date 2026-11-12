# Provider Stability & Performance Plan

Goal: make provider connections more stable and faster, building on the existing
failover loop, health checks, combos, and concurrency limiter.

## Phases

1. Health-check backoff + circuit breaker
2. Sticky routing with failover memory
3. Request-level retry with jitter
4. Streaming TTFB timeout
5. Per-connection latency EMA into routing
6. Concurrency cap per provider (configurable)
7. Response cache for deterministic calls
8. Parallel race for auto model
9. DNS + connection pooling
10. Failure attribution

## Verification

Each phase: implement -> pnpm verify -> commit -> tag -> release.
