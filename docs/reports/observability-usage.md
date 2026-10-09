# Observability and usage accounting

Phase 7 evidence. Measured against tests at the commit that adds this file.

| Roadmap item | Status | Evidence |
| --- | --- | --- |
| 7.1 Request correlation | **added** | each usage record carries `requestId`, the logical request's id from its scope (`request-context.ts`); a failover writes one record under one id |
| 7.1 Attempt-level record | **added** | each record carries `path`: the connections tried, in order, each with its outcome and error code |
| 7.2 Attempts vs logical requests | **added** | `dispatched` on each path entry, so a planned attempt that never started is not counted as a provider call |
| 7.2 Usage from the provider's response | covered | tokens come only from the provider's own usage metadata; `tokensUnmeasured` marks absence (existing) |
| 7.3 Cost labelled honestly | covered | `priceUsage` separates priced, unpriced and caveated cost (existing `usage-pricing.ts`) |
| 7.4 Secret-free diagnostics | covered | the record has no prompt, response, header or credential field (existing test in `usage-route.test.js`); the new fields hold ids and outcomes only |
| 7.4 Stable metric names and low-cardinality labels | **not done** | no metrics export exists; the usage store is the only telemetry |

## Tests

- `apps/gateway/test/usage-attempt-path.test.js` (4): an old record loads with no invented path; a request id and
  ordered path survive a read; an abandoned or never-dispatched attempt is recorded as not dispatched; a malformed
  path drops the record.
- `apps/gateway/test/usage-failover-path.test.js` (1): an end-to-end failover through the real route writes one record
  with both attempts in order, under the request id, and marks both as dispatched.

## Compatibility

Both new fields are optional. A `usage.json` written before this change still loads, and its records show only the
total. The validator rejects a malformed path rather than showing a partial failover. `docs/SPEC-SDK.md` describes both fields.

## Not done

- 7.4 metrics: there is no metrics export, and adding one is a new surface with its own label and cardinality design.
  The roadmap asks that high-cardinality labels be avoided, so it should not be added without that design.
- Token and cost totals still come only from provider-reported usage. No cost is estimated for a path.
