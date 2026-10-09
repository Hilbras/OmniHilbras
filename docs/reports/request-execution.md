# Request execution, retries, hedging and rate limits

Phase 4 evidence. Each item is measured against existing or new tests.

| Roadmap item | Status | Evidence |
| --- | --- | --- |
| 4.1 Request states | covered by the attempt ledger | `execution-correctness.test.js`: every attempt has exactly one outcome |
| 4.2 Rate-limit correctness | covered | `rate-limit-policy.test.js` (sliding window, refusal spends no budget, zero means unlimited, waits per connection); `execution-correctness.test.js` races two requests against a limit of one and gets one 200 and one 429 |
| 4.3 Retry policy | covered | `retry-policy.test.js` (14 tests): every branch of the decision, the rate-limit hand-off, the terminal codes, stream never retries |
| 4.3 `Retry-After` | **added** | `packages/omnihilbras-sdk/test/retry-after.test.js` (6): seconds, HTTP dates, past, negative and malformed values; a 429 carries the wait in `details.retryAfterMs`; a 503 does not |
| 4.4 Hedging | covered | `hedge-policy.test.js` (13): no hedge after a win, a settle or a cancel; abandoned hedges do not record health (`execution-correctness.test.js`) |
| 4.5 Provider health | covered | `execution-correctness.test.js`: a stream that throws after its first chunk is a failure; a cancellation is neither a success nor a failure |

## What changed

`Retry-After` was read by nothing. The transport mapped a 429 to `RATE_LIMITED` and marked it retryable, but a
client could not learn how long to wait. The wait is now attached to the error as `details.retryAfterMs` for a
429 only. The status mapping and every existing error field are unchanged, so no caller breaks.

**Not wired yet:** the gateway does not yet use `retryAfterMs` to choose its own retry delay, and the retry policy
does not yet wait for it. Honouring it in the executor is a behaviour change to the request path, so it is a
separate decision for the maintainer.

## Still open

- Concurrency under real provider latency has not been measured. The tests use in-process fakes.
- Retry and hedge budgets are process-local. The gateway does not coordinate them across processes, and the docs
  must not claim it does.
