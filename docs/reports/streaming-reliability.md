# Streaming reliability

Phase 5 evidence. Each row is measured against a test, or marked as not measured.

| Roadmap item | Status | Evidence |
| --- | --- | --- |
| 5.1 Failover only before output is committed | covered | `request-executor.ts`: a stream walks its route chain once and never retries after bytes are sent; `execution-correctness.test.js` |
| 5.2 Failure after the first chunk is a failure | covered | `execution-correctness.test.js`: a stream that throws after its first chunk is recorded as a failure |
| 5.2 Stream ends without a terminal event | covered | `gemini.test.js` rejects a stream with no finish reason; `openai-stream-truncation.test.js` (4) refuses a stream cut before `[DONE]`, one with no meaningful content, and one with no payload |
| 5.2 Malformed event JSON | covered | `gemini.test.js` ("rejects malformed stream payloads"); malformed frames are asserted in the other stream adapters' tests |
| 5.2 Stalled and slow streams | covered | `stream-bounds.test.js`: an idle stream ends at the idle budget; the budget is measured between chunks; a never-idle stream hits the maximum duration |
| 5.3 Client disconnect and cancellation | covered | `load.test.js`: client aborts record no failure and do not eject a working provider |
| 5.3 Release of timers and readers | covered in part | the duration and idle timers are cleared on completion (`stream-bounds.test.js`); reader release is not separately asserted |
| 5.4 Partial usage recorded honestly | partial | usage is read only from the provider's own final metadata; a stream cut before it is refused, so no partial usage is invented |
| Backpressure and slow consumers | **not measured** | no test drives a slow consumer against the byte cap |

## What the rows say

The core invariants already have tests: no retry after output is committed, failure after the first chunk is a
failure, a truncated stream is refused rather than shown as complete, and a stalled stream is bounded.

The one gap I could not close is backpressure. The byte cap (`maxStreamBytes`) is asserted to exist, but nothing
measures a slow consumer against it. That needs a benchmark with a real consumer, which belongs with Phase 9.

## Still open

- Backpressure and slow-consumer behaviour: not measured.
- Reader-release assertions: the timers are covered, the stream reader is not asserted released.
