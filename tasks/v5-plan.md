# V5 program plan — accountable spend, safe exposure, cheaper inference

**Baseline:** `4.0.1` (2026-11-26) · **Status:** planned, not started · **Research:**
[improvement-research-2026-11-26.md](../docs/reports/improvement-research-2026-11-26.md) ·
**Successor to:** [v4-platform-plan.md](./v4-platform-plan.md)

## Goal

Turn the capabilities the gateway market now treats as table stakes into local-first features that
use data this project already collects: **know who spent what**, **stop before a limit is crossed**,
**make an exposed gateway defensible**, and **spend less per request**. No cloud dependency, no
multi-tenant billing, no feature that reports success without measuring it.

## Success metrics

| Metric | Target | How it is checked |
| --- | --- | --- |
| Usage attribution | 100% of records written after 4.1.0 carry actor/key/workspace (or explicit `anonymous`) | attribution test over every billable route |
| Budget correctness | no overspend beyond one reservation in a 100-concurrent-request test | `budget-enforcement.test.js` |
| Budget check cost | p95 < 2 ms, no disk write on the hot path | benchmark in the ledger test |
| Cache honesty | a hit is only reported when the same canonical request was served | cache contract test |
| OTel privacy | 0 prompt/message bytes exported with content disabled | fake-collector test |
| Guardrails | dry-run reports without blocking; a block is a refusal, never a silent rewrite | policy matrix test |
| Accessibility | 0 serious/critical axe findings on every dashboard page | new e2e a11y gate |
| Compatibility | old keys, old usage records, old backups and JSON-default installs keep working | migration + round-trip tests |

## Architecture decisions (made once, up front)

1. **Money is integer micro-USD.** `usdMicros` everywhere; no floats in the ledger. A request's
   price is snapshotted when it is recorded, so a later price-table edit cannot rewrite history.
2. **The spend ledger is separate from the usage store.** Usage is bounded (it rolls off); budgets
   over a month or a lifetime cannot read a rolling window. `spend` is a small StateDocument of
   day buckets with its own retention (400 days), written by coalesced batches, not per request.
3. **Budgets are reservations, then settlements.** Before dispatch, reserve the worst-case cost
   (estimated input + `max_tokens` × output price); after completion, settle the actual and release
   the difference. A crash leaves a reservation that expires; the ledger reports it as held.
4. **Windows are UTC.** Day/week/month boundaries are UTC so two operators in two timezones cannot
   disagree about when a budget resets. The reset time is returned to the client.
5. **Every new restriction is opt-in.** A key with no budget, no allowlist and no token limit
   behaves exactly as it does in 4.0.1.
6. **Policy evaluation order is request → provider → response.** Request rules run before dispatch
   (cheap, can refuse), response rules run on the completed answer, and streaming rules are
   documented for what they can and cannot do: already-sent tokens cannot be unsent.
7. **OTLP/HTTP JSON, hand-written.** The published CLI is dependency-free and its bundle is
   measured; the exporter adds no package. The `gen_ai.*` subset is pinned and documented because
   the conventions are still Development status.
8. **Cache keys are canonical and complete.** Model, messages, tools, tool choice, response format,
   temperature, seed and provider constraints are all in the key. Anything omitted is a stale-answer
   bug waiting to happen.
9. **Batch rides the job store.** It is a record of work with an owner and a budget, not a second
   scheduler.
10. **Webhooks are signed and allowlisted.** HMAC-SHA256, timestamped, retried with backoff, and
    refused for private/loopback destinations unless explicitly allowlisted.

## Phase 1 — Accountable spend (`4.1.0`)

Uses what already exists: billable-route classification (`route-policy.ts`), per-request pricing
(`usage-pricing.ts`), token estimates (`token-estimate.ts`), keys with `rpm`/`expiry`/`workspace`.

### 1.1 Attribution (prerequisite)

- `UsageRecord`: add `apiKeyId?`, `apiKeyPrefix?`, `workspaceId?`, `actor: 'key' | 'dashboard' | 'anonymous'`.
- `UsageQuery`: add `apiKeyId`, `workspaceId`, `actor`; `UsageSummary`: add `byKey` totals.
- Thread the authenticated principal from the server gate through `RequestContext` into the service
  and the record. Unauthenticated dashboard traffic records `dashboard`; nothing records a key it did
  not see.
- Old records parse as unattributed; the usage page says "unattributed" rather than zero.

### 1.2 Spend ledger (`Kernel/API/src/core/spend-ledger.ts`, new)

- StateDocument `spend`: buckets keyed `(scope, id, utcDay)` holding `usdMicros`, `inputTokens`,
  `outputTokens`, `requests`, `unpricedRequests`, `heldUsdMicros`.
- Coalesced writes (≤ 1 flush per second or per 100 entries), snapshot read from memory, restart
  rebuild from the persisted document; a rebuild command can replay retained usage records.
- Retention 400 days; a bucket older than retention is ignored, not deleted on the hot path.

### 1.3 Budgets and quotas

- `Budget = { usd?, tokens?, period: 'day' | 'week' | 'month' | 'total' }` on the key; a workspace
  default the key may override. Validation: positive values, known period, at most one of
  `usd`/`tokens` may be zero.
- Enforcement before dispatch on every route `isBillableRoute()` names: video polls and token
  counting stay free, as documented.
- Refusal: `402 BUDGET_EXCEEDED` for dollars, `429 QUOTA_EXCEEDED` for tokens, with
  `Retry-After` and `x-omnihilbras-budget-remaining-usd` / `-tokens` / `-reset` headers. An
  unpriced model against a dollar budget is refused only if a token quota is also exhausted; it is
  counted as `unpricedRequests` and surfaced, never as $0.
- Reservations expire after the request timeout + 60 s; an expired hold is reported, not silently
  forgotten.

### 1.4 Token-per-minute limits

- `tpm` on the key and on the connection, next to `rpm`. Token bucket over estimated input +
  `max_tokens`; spend on dispatch, reconcile with actual usage. Same policy split as
  `rate-limit-policy.ts`: `check` queries, `spend` commits.

### 1.5 Key allowlists

- `allowedProviders?: string[]`, `allowedModels?: string[]` (glob), `allowedRoutes?: string[]`.
- Enforced before candidate selection; empty/absent means allow all. Refusal is
  `403 POLICY_DENIED` naming the rule, not the full list of what exists.
- Validation at save time: provider ids must exist in `PROVIDER_MANIFESTS`; route paths must be
  served (checked against the route contract).

### 1.6 Clock and reset semantics

- One `budgetWindow(period, now)` function, tested at UTC month/year boundaries and leap day.
  `Retry-After` is the seconds until the next boundary, never a guess.

### 1.7 Surfaces

- Routes: `GET /v1/spend` (owner-only summary, filters `scope`/`id`/`period`), extend
  `GET /v1/usage` with the new filters. New routes need `Kernel/API/test/` coverage and a
  `docs/SPEC-SDK.md` line.
- Dashboard: Keys page — budget editor, spend progress, remaining, reset time, "unpriced" badge;
  Usage page — key/workspace filter and spend column; Settings — ledger retention.
- Metrics: `omnihilbras_budget_refusals_total{kind}`, `omnihilbras_budget_checks_total`,
  `omnihilbras_spend_usd_micros` (no per-key labels: cardinality is unbounded), plus the existing
  request metrics.
- Audit: every budget/allowlist change is a management write (already audited) with before/after
  values that contain no credentials.

### 1.8 Tests

`spend-ledger.test.js` (UTC rollover, month/year boundary, leap day, restart, coalescing,
corruption, retention), `budget-enforcement.test.js` (refusal shape, headers, settle, abort,
concurrent 100 requests, unpriced, expired hold, restart), `usage-attribution.test.js` (key,
workspace, dashboard, old record), `api-key-policy.test.js` (allowlist exact/glob/segment,
unknown provider, route not served), backup round-trip including the new key fields and ledger.

**Acceptance:** a key with a $1/day budget is refused once spent, survives a restart, shows the
remaining budget and reset time in the dashboard, and no concurrent run exceeds the reservation.

## Phase 2 — Safe to expose (`4.2.0`)

### 2.1 Guardrail engine (`Kernel/API/src/core/guardrails.ts`, new)

- One policy document, scopes `global` → `workspace` → `key` → `connection`; rules are data:
  `redact`, `block`, `limit`, `tool`, `injection`.
- `redact`: extract the existing secret patterns from `request-details.ts` into a shared
  `redact.ts` and reuse them; add email/phone/card-with-Luhn/IBAN. Applied to request details,
  audit and logs always; to outbound prompts only when a rule says so.
- `block`: literal/regex terms on request and response; action `block` (422 `GUARDRAIL_BLOCKED`
  with the rule id) or `flag` (header + audit).
- `limit`: max input tokens, max output tokens, max messages, max tools; reuse `token-estimate.ts`.
- `tool`: allow/deny tool names declared by the caller and tool calls returned by the model;
  `shell`-class names are denied by default where the gateway itself would execute anything.
- `injection`: heuristic flags on untrusted content (tool results, fetched pages): instruction
  override phrases, role impersonation, encoded payloads. Flag, never rewrite.
- Dry-run mode returns findings with `x-omnihilbras-guardrail: dry-run` and does not block; a
  per-rule counter reports how often each would have fired.
- Streaming: request rules run before the stream; response rules scan accumulated text and can
  terminate with an error event and audit. Documentation states plainly that already-sent tokens
  cannot be recalled.

### 2.2 OpenTelemetry export (`Kernel/API/src/core/otel.ts`, new)

- OTLP/HTTP JSON, no dependency; config `OMNIHILBRAS_OTEL_ENDPOINT`, `_HEADERS`, `_SAMPLE_RATE`,
  `_SERVICE_NAME`.
- Spans: `gen_ai.chat` per attempt (provider, request/response model, input/output/cache tokens,
  TTFT, retries, connection id), `omnihilbras.route` for billable routes; MCP tool calls when the
  MCP surface is used.
- Pinned attribute subset documented in `docs/SPEC-SDK.md`; `OMNIHILBRAS_OTEL_CONTENT=1` is the
  only way prompts/messages are included, and the test asserts zero content bytes when it is off.
- Bounded queue (dropped spans are counted), batch export, failure open: a collector that is down
  never costs or delays a request.

### 2.3 MCP tool approvals

- `mcp-plugins.json` gains `tools: { allow?: string[], ask?: string[] }`; `ask` requires a
  short-lived approval token minted in the dashboard/CLI, one-shot, TTL-bounded, audited.
- The existing rules stay: operator-registered ids only, `shell: false`, argv array, `shell` refused
  by name, output bounded, child killed when the last subscriber leaves.
- Every plugin tool call records an audit event with plugin id and tool name (no arguments).

### 2.4 Tests

Rule matrix, dry-run, redaction on every new surface, guardrail bypass attempts, stream termination,
OTel fake collector (content off/on, sampling, failure open), MCP approval TTL/one-shot/audit, and
the existing audit/journal tests extended.

**Acceptance:** with guardrails on, a test secret never appears in logs/details/audit; a blocked
term refuses; dry-run blocks nothing; a collector receives spans with no prompt text; an
unapproved MCP tool refuses.

## Phase 3 — Cheaper and faster (`4.3.0`)

### 3.1 Cache v2

- Configurable `enabled`/`ttlMs`/`maxEntries`/`persist`; persisted through the state seam; key
  includes tools, tool choice, response format, seed, temperature and provider constraints.
- `x-omnihilbras-cache: bypass | refresh`; `Cache-Control: no-store` always wins; `x-cache:
  hit|miss|bypass`; hit/miss metrics; `DELETE /v1/cache` owner-only.
- Defaults preserve 4.0.1 behaviour (temperature-0 only, in-memory, 30 s) until an operator opts in.

### 3.2 Semantic cache (opt-in, evaluated)

- Embedding via a configured connection; cosine threshold; TTL; namespace per key/workspace; never
  across workspaces; off by default.
- Ships only with a fixture evaluation showing the chosen threshold's false-hit rate; docs warn
  that a wrong cached answer is worse than a slow right one.

### 3.3 Batch

- `/v1/batches` (create/list/get/cancel/output) plus a minimal bounded `/v1/files` store for the
  OpenAI-compatible flow. Native where a provider has a batch API (caps row `batch: true`),
  bounded-concurrency emulation elsewhere with the same per-request accounting and budget gate.
- Every batch reserves its budget up front; completion is a job record and a webhook.

### 3.4 Rerank

- `/v1/rerank` with providers that serve it (caps row `rerank: true`), normalized response, usage
  pricing per search unit. Providers without it are absent, not silently degraded.

### 3.5 Webhooks

- A `webhooks` document (`url`, `secret`, `events`), HMAC-SHA256 signature with timestamp, retries
  with backoff, dead-letter record, `POST /v1/webhooks/test`.
- Events: `batch.completed`, `video.completed`, `budget.threshold` (80% and 100%).
- SSRF guard: https only, DNS-resolved address checked against private/loopback/link-local ranges,
  explicit allowlist override for a local receiver.

### 3.6 Tests

Cache contract (canonical key, no-store, persistence, restart, mutation safety), semantic-cache
evaluation fixture, batch lifecycle + budget + restart, rerank adapters, webhook signature/retry/
dead-letter/SSRF, and the route/SPEC/caps guards.

**Acceptance:** an identical request is served from cache with `x-cache: hit` and survives restart;
a 3-request batch completes and downloads; rerank returns ranked documents; a webhook verifies and
retries; a webhook to `127.0.0.1` is refused unless allowlisted.

## Phase 4 — Product surface (`4.4.0`, `4.5.0`)

### 4.1 Eval harness (`4.4.0`)

- `Kernel/Eval/` private package: cases (JSON/YAML) with input, expectations (exact/regex/JSON
  schema/numeric tolerance, optional judge), provider/model matrix, `pnpm eval`, machine-readable
  report; no network in CI by default.
- Gate: a catalog or model change can run the suite before release; the report is the evidence a
  provider still works, not a table of vibes.

### 4.2 Prompt registry (`4.4.0`)

- Versioned prompts with `{{variables}}`, render route, usage attribution, dashboard page; prompts
  are content, not credentials, and are exportable in the backup envelope.

### 4.3 PWA, i18n, accessibility (`4.5.0`)

- Service worker with an offline shell and an explicit update flow (a web manifest already exists).
- i18n message catalogue with `en` plus one RTL language to prove layout; a missing-key test.
- axe run on every dashboard page in e2e; zero serious/critical is the gate. The wider design-system
  pass closes the documented E remainder.

### 4.4 Desktop packaging (`4.5.0`, decision gate)

- Measure unpacked size and startup first; decide between trimming Electron and a Tauri shell. A
  rewrite is its own decision and does not ride along with anything else.

### 4.5 A2A (watch)

- An agent card is a small discovery surface; do not build execution until the spec settles.

## Dependencies and sequencing

```
1.1 attribution ──► 1.2 ledger ──► 1.3 budgets ──► 1.5 allowlists ──► 4.1.0
                         │
                         ├──► 3.3 batch accounting
                         └──► 3.5 budget webhooks
1.x key model ──► 2.1 guardrails (per-key policies) ──► 2.3 MCP approvals ──► 4.2.0
2.2 OTel ──► 3.1 cache metrics / 3.3 batch traces
4.4.0 depends on nothing above; 4.5.0 depends on 4.4.0 only through the release cadence.
```

Each phase is a release. Do not start the next phase before the previous tag, GitHub release, npm
`latest` and `release:audit` are clean.

## Risks and controls

| Risk | Control |
| --- | --- |
| Usage is bounded, so a month budget reads a rolling window | separate spend ledger with its own retention |
| Concurrent requests overspend | worst-case reservation, settle, expiry, concurrency test |
| A price change rewrites history | price snapshot per record; ledger stores micro-USD, not recomputation |
| Unpriced models look free | `unpricedRequests` counted and shown; token quotas still apply |
| Guardrails block legitimate work | opt-in, dry-run first, per-rule counters, no silent rewrite |
| Streaming cannot unsend tokens | request rules before dispatch; response scan documented honestly |
| OTel conventions are unstable | pinned subset, documented version, content off by default |
| OTel/webhooks cost a request when the peer is down | bounded queues, failure open, no synchronous dependency |
| Semantic cache returns wrong answers | off by default, threshold chosen by fixture evaluation |
| Webhook SSRF | https, DNS-resolved private-range refusal, explicit allowlist |
| Batch emulation burns a budget | up-front reservation per batch, per-request accounting |
| Bundle growth breaks the CLI budget | no new dependency; `analyze:check` gate remains |
| Scope creep inside a phase | the phase's acceptance table is the stop rule |

## Definition of done per phase

1. Tests before behaviour: unit + integration in `Kernel/API/test/`, route tests, dashboard honesty
   tests, and the guards (`gateway-routes`, `provider-manifest` when a manifest changes).
2. `docs/SPEC-SDK.md` line for every new route and env var; a migration note for every new state
   field; README where a user-facing capability appears.
3. Dashboard surface for anything an operator must see; no feature that exists only in a route.
4. Metrics for anything that claims savings or refusals.
5. `pnpm verify`, `pnpm test:e2e`, CI green, version bump, tag, GitHub release, `npm publish` from
   `cli/`, registry confirmation, `pnpm release:audit`.
6. A short report of measured results (remaining budget accuracy, cache hit rate, span volume,
   guardrail dry-run counts) in the release notes.

## Non-goals

- Cloud multi-tenancy, hosted credits/billing, org administration.
- ZDR or “no training” claims the gateway cannot verify.
- Semantic caching on by default.
- A2A execution, an Electron/Tauri rewrite, or a framework change inside this program.
- Enabling any restriction by default that would change existing keys.

## Work breakdown summary

| Release | Theme | Size | Risk |
| --- | --- | --- | --- |
| `4.1.0` | Attribution, ledger, budgets, TPM, allowlists, spend UI | M | Medium — money and concurrency |
| `4.2.0` | Guardrails, OTel export, MCP approvals | M–L | Medium — privacy and stream semantics |
| `4.3.0` | Cache v2, semantic (opt-in), batch, rerank, webhooks | L | High — new surfaces and SSRF |
| `4.4.0` | Eval harness, prompt registry | M | Low |
| `4.5.0` | PWA, i18n, axe gate, design system, desktop decision | M | Low–Medium |

Versions are per AGENTS.md: a new capability is a minor bump; `5.0.0` is reserved for a breaking
change, and nothing in this plan requires one.
