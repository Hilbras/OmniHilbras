# Scoped failure classification and `Retry-After` — phase 4 (3.92.2)

## Why

Two pieces of provider-hostile behaviour survived the earlier reliability work.

- `Retry-After` was parsed from the upstream response into `details.retryAfterMs` and used for the
  model cooldown, but the retry itself fired immediately. The second request got the same refusal and
  cost money for nothing.
- A 404/400 that says "this model id is not on the plan" arrived as `PROVIDER_REQUEST_FAILED` and was
  counted against the connection. One caller's stale id could eject a healthy account for everyone
  else — the same harm as counting a caller fault, hidden behind a different code.

Terminal-truth recording was already in place from 3.90.6: chat, Responses and Messages lanes mark a
record `incomplete` when no terminal finish reason arrives, and a stream that dies mid-answer is a
failure, not a success. This phase did not duplicate that work.

## What changed

- `RequestExecutor.waitForRetryAfter()` waits the stated interval before a same-route retry, capped
  at five seconds and ended by caller cancellation. A longer wait belongs to the routing cooldown.
- `isConnectionFailure()` treats an unmatched 4xx as request-scoped. 401/402/403/429 keep their
  account-level rules, so quota and auth refusals are not reclassified as caller mistakes.

## Verification

`pnpm verify`, plus two new cases in `Kernel/API/test/request-executor.test.js`: the 4xx does not
record a connection failure, and a 40 ms `Retry-After` is actually waited before the second attempt.
No live provider calls.

## Program complete

Phases 1–4 close the structural provider gaps identified in the 9router comparison: declared
validation and transport injection, upstream ids and per-model capability lookup, one canonical tool
name map, and scoped failure classification with an honoured `Retry-After`.
