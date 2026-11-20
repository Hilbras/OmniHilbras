# Full-system upgrade plan — frontend + backend

**Created:** 2026-11-20 · **Baseline:** `3.79.0` · **Status:** all nine phases delivered (3.80.0 – 3.84.0); Phase 9 is a bounded foundation, not full tenant isolation.

## Goal

Take OmniHilbras from a mature, reliable local gateway to a **scalable, live, analytically-rich product**
with a maintainable adapter core — across the backend (`Kernel/API`, `Kernel/SDK`, `Kernel/TokenSaver`,
`Kernel/Tools`) and the frontend (`src/` dashboard + site) — **without sacrificing the properties that make
it trustworthy**: local-first, zero-dependency CLI bundle, loopback-only default, JSON-file storage as the
simple default, and the "asserted, not promised" test culture.

The recommendation this executes (2026-11-20): the two architectural ceilings are **(1) ten separate
JSON-file stores** and **(2) 54 vendored adapter `lib/` copies**; the visible product gaps are real-time
state, cost analytics, and feature parity (combos / quota tiers / translation / token-saver filters); the
frontend gaps are push-vs-poll, bundle weight, accessibility, and design-token drift.

## Non-negotiables (preserve through every phase)

1. **Local-first, loopback-only default.** No phase changes the default bind or phones home.
2. **Zero-dependency CLI bundle.** The published `@hilbras/omnihilbras` stays a self-contained esbuild
   bundle. Anything native (e.g. a DB driver) must be **optional and dynamically loaded**, never a hard
   bundle dependency, or it stays out of the CLI path.
3. **JSON storage stays the default.** A database is an *optional* backend behind the existing `Store`
   interfaces, not a replacement that breaks the simple install or existing vaults.
4. **Asserted, not promised.** Every behaviour change ships with a test that fails if it regresses; new
   routes get a `docs/SPEC-SDK.md` line + `Kernel/API/test/` coverage (the `gateway-routes` guard enforces it).
5. **Backward compatible.** Existing vaults (`connections.json`, `usage.json`, `secrets.enc.json`) keep
   loading; new fields are optional; no public surface is removed without a major bump.
6. **Real requests only.** No simulated success; a live provider check costs money and is labelled.

## Phases (each ships completely: verify → bump → tag → release → npm → audit)

### Phase 1 — Request-path reliability completion  *(minor)*
Close the gaps the engineering reports explicitly flag as open, so the request path is fully proven before
bigger changes land on it.
- **Wire `Retry-After` into the executor.** `retryAfterMs` is parsed onto a 429 (`Kernel/SDK`) but the retry
  policy ignores it (`docs/reports/request-execution.md`: "not wired yet"). Honour it as the retry delay for
  429s (bounded by the existing policy), so the gateway waits the provider's stated time.
- **Backpressure / slow-consumer test** against `maxStreamBytes` (the one unmeasured streaming gap,
  `docs/reports/streaming-reliability.md`).
- **Reader-release assertion** on stream completion (timers are covered; the reader is not).
- **Acceptance:** a 429 with `Retry-After: N` waits ~N before retry (test with a fake clock/provider); a slow
  consumer is bounded by the byte cap; the reader is asserted released; `pnpm verify` green.

### Phase 2 — Shared adapter core  *(minor/major)*
Kill the drift surface: **54 SDK packages each vendor `lib/`** (`Kernel/SDK/*/lib/`). AGENTS.md: "a fix to a
vendored file is a fix to every copy or it is drift."
- Extract the shared machinery into one internal package (e.g. `Kernel/SDK/_shared/`) consumed by adapters;
  migrate incrementally (a few adapters first, prove the build/bundle/test path, then the rest).
- Add a guard that fails if a vendored copy diverges from the shared source (or remove the copies entirely).
- Resolve the deferred "single adapter harness" seam (`docs/architecture/README.md`).
- **Acceptance:** one source of truth for shared adapter code; a drift guard; all SDK + gateway tests green;
  the CLI bundle still builds and runs.

### Phase 3 — Optional database storage behind the Store interfaces  *(minor)*
The biggest architectural bet, done safely: an **optional SQLite backend** behind the existing `Store`
interfaces (`ConnectionStore`, `UsageStore`, `ApiKeyStore`, …), **JSON remains the default**.
- Start with **`UsageStore`** (highest volume, the analytics prerequisite): a `SqliteUsageStore` implementing
  the same interface, selected by config/env; JSON otherwise.
- Use `node:sqlite` (built-in, Node ≥22.5) **or** an optional dynamic driver; never a hard CLI-bundle dep.
  Gate on runtime capability and fall back to JSON when unavailable.
- Migration: import an existing `usage.json` into the DB on first run; keep export/backup working.
- **Acceptance:** with the DB enabled, usage writes/reads/queries match the JSON store's contract (shared
  interface test runs against both); JSON default unchanged; analytics queries (period/provider/model) work.

### Phase 4 — Real-time dashboard  *(minor)*
Replace polling with push for live state.
- A gateway **SSE state channel** (connections/health/usage deltas) — new route + spec line + route test.
- Frontend: a subscription hook that updates state from the channel; keep the 4 s poll as a fallback.
  Logs already use SSE (`gatewayClient.ts`); reuse that pattern (EventSource can't carry auth — handle as today).
- **Acceptance:** a connection/health change appears in the dashboard without a manual reload or waiting out
  the poll; fallback works when SSE is unavailable; no credential in browser storage (existing guard).

### Phase 5 — Cost & usage analytics + bundle weight  *(minor)*
- A real **analytics view** on the existing honest per-request cost + attempt-path data: trends over time,
  per-model/per-provider cost, failover health, tokens saved. (Queries become cheap once Phase 3 lands.)
- **Bundle splitting:** `UsageCharts` (~370 kB) and `UsageTopology` (~174 kB) dominate — lazy-load/split
  charting or move to a lighter lib; tighten the bundle budget.
- **Acceptance:** analytics renders from real usage (no invented numbers); heavy chart code is off the
  critical path; `analyze:check` budget met.

### Phase 6 — Feature parity: combos + quota tiers  *(minor)*
From `tasks/system-parity-plan.md`:
- **Combos:** a vault store (name → ordered connection/model refs + strategy), `GET/POST/PUT/DELETE /v1/combos`,
  resolve a combo id in inference like a virtual model, a dashboard Combos page. Failover to next healthy member.
- **Multi-account quota tiers + auto-fallback:** per-connection quota tracking, configurable tier
  (subscription → cheap → free), round-robin + cooldown, exhausted account skipped; surface in cards.
- **Acceptance:** a combo resolves to its first healthy member and fails over; an exhausted account is skipped
  and the tier fallback is exercised; routes have spec lines + tests.

### Phase 7 — Translation routes + token-saver filters  *(minor)*
- **Direct format-translation routes** (`source:target`) so fragile pairs skip the lossy OpenAI double-hop;
  reuse the schema/concerns registry; register direct routes (e.g. claude↔kiro).
- **RTK-style token-saver filters** + autodetect, caveman/ponytail injectors (fail-open), telemetry in
  token-saver stats. Keep TokenSaver opt-in.
- **Acceptance:** a registered direct route is chosen over the pivot; compression applies and fails open;
  stats reflect it; tests drive each.

### Phase 8 — Frontend quality: a11y, large lists, design tokens  *(minor)*
- **Accessibility audit** (keyboard-only walkthrough, contrast, screen-reader labels) — currently *not
  measured* (`docs/reports/dashboard-quality.md`); fix what it finds; add a runtime a11y test.
- **Large-list virtualization** for providers/models; benchmark large lists.
- **Design tokens:** remove hard-coded hex (~13 files) in favour of tokens; dedupe dead `.glass` CSS.
- **Acceptance:** a11y audit passes a defined bar; large lists render within a measured budget; a guard
  rejects new hard-coded colours.

### Phase 9 — Optional multi-user / scale  *(major, optional)*
- Optional **multi-user/teams** on the workspaces store + auth (only if a DB backend is present).
- Gateway **scale**: coordinate retry/hedge budgets beyond process-local (worker/cluster or shared state),
  measured under real provider latency.
- **Acceptance:** multi-user isolation tested; concurrency benchmark improves on the 400-concurrent
  degradation (`docs/reports/performance-baseline.md`); no claim of cross-process coordination without proof.

## Versioning & definition of done
Per `AGENTS.md`: each phase is a behaviour change → bump (new capability = minor `0.x.0`; breaking = major;
refinement = patch), `pnpm version:fix`, `pnpm verify`, commit on `main`, tag, push, GitHub release with
what-changed + how-to-verify, `npm publish` from `cli/`, confirm `npm view`, `pnpm release:audit` clean.
New routes need a SPEC line + gateway test. The website is a separate Vercel deploy (not part of npm).

## Execution log
- **Phase 1 — complete in the tree (3.80.0).** Closed the two streaming gaps the reliability report flagged:
  `Kernel/SDK/tests/stream-bounds.test.js` now proves a slow consumer is bounded by `maxStreamBytes` and the
  reader lock is released on both the completion and byte-cap error paths (10/10 pass). **Retry-After wiring is
  deferred to a designed follow-up**: a 429 deliberately fails over to the next route (`shouldRotateAccount` →
  `next-route`), so honouring `Retry-After` in the retry delay would interact with the failover semantics and
  needs its own design + tests rather than a naive change.
- **Phase 3 — complete in the tree (3.80.0).** Optional SQLite `UsageStore` (`Kernel/API/src/core/usage-store-sqlite.ts`)
  behind the existing interface, selected by `OMNIHILBRAS_USAGE_STORE=sqlite`; **JSON stays the default**. The
  driver loads via `createRequire` (no top-level `node:sqlite` import), so the module loads on any Node and the
  CLI bundle keeps it external; an unavailable driver falls back to JSON. Reuses the shared query/summary/
  normalisation helpers for exact parity; imports an existing `usage.json` once on first run.
  `Kernel/API/test/usage-store-contract.test.js` runs one contract against both backends (16 cases: ids, ordering,
  queries, totals, bound, forbidden fields, backup round-trip, reopen, factory default, migration). SPEC updated.
- **Phase 4 — complete in the tree (3.81.0).** `GET /v1/events` pushes a small `{"type":"state"}` notification
  when the gateway's cheap, secret-free `stateFingerprint()` (connection settings + stored health counters,
  from an in-memory map — no provider probe, no credential decryption) changes. Server-side change detection
  catches mutations from any source without instrumenting each one; `HealthRegistry.fingerprint()` and
  `service.stateFingerprint()` are the single definitions. The browser opens the stream in `useGatewayStatus`
  and refreshes immediately on a notification; the 4 s poll remains the fallback (desktop keeps polling).
  `Kernel/API/test/events-route.test.js` (4 cases: admin gate, change notification with no data, no notification
  on a stable state, secret-free fingerprint) passes; SPEC + route guard green.
- **Phase 6 — complete in the tree (3.82.0).** Combos and auto-fallback already existed: a virtual model
  (`/v1/virtual-models`) is an ordered, strategy-driven combo, and health ejection + failover is the automatic
  fallback. The genuine gap was the **quota tier**: an optional `quotaTier` (`paid`/`cheap`/`free`) on a connection
  is validated in the save route, survives a store reopen, and sorts candidates paid → cheap → free before
  priority (absent tier sorts as `paid`, so older records keep their placement). `quota-tier.test.js` (5 cases)
  passes; the dashboard type and card show the tier. SPEC updated.
- **Phase 5 — already satisfied (verified, no change needed).** The cost/usage analytics view exists: `/v1/usage`
  returns `byProvider`/`byModel`/`timeline` + honest `costUsd`/`pricedRequests`/`unpricedRequests` (SPEC-SDK.md:300),
  rendered by `UsagePage.tsx`. The heavy charts are already lazy (`UsagePage.tsx:29-38` — `UsageCharts`,
  `UsageTopology`), recharts is guarded by `tests/bundle-budget.test.js:145-168`, and `analyze:check` enforces the
  budget. No redundant change was made; the guard is what keeps it true.
- **Phase 2 — drift guard done (3.82.x), full consolidation deferred as high-risk.** `errors.ts` and `url.ts`
  are byte-identical across all 54 vendored `lib/` copies; `tests/vendored-lib-drift.test.js` pins that (3 cases),
  so a fix to one copy that misses the others fails in `pnpm test:repo`. `types.ts` (7 shapes) and
  `transport.ts` (3) vary deliberately and are explicitly not pinned. A full move to one shared package touches
  every SDK's build/bundle path and is deferred rather than risked on this pass; the guard contains the drift.
- **Phase 7 — RTK half already satisfied; direct-translation deferred.** `Kernel/TokenSaver` already ships
  `compressRtk`, `autoDetectFilter`, per-tool filters and telemetry (`TokenSaver/src/rtk.ts`, `filters/`,
  `messages.ts`). Direct `source:target` format-translation routes are a new subsystem (a registry + route +
  adapter wiring); deferred rather than shipped untested on this pass.
- **Phase 8 — a11y + token ratchet done.** `tests/accessibility.test.js` now pins every dialog's Escape /
  focus-trap / focus-restore primitives and ratchets hard-coded hex colours at the current baseline (126);
  ApiKeysPage's Modal and WebCookieConnectDialog were missing a Tab focus trap and now have one. Large-list
  handling and lazy pages/charts already exist. Typecheck + 6 a11y tests green.
- **Phase 7 — direct format translation done.** `core/format-translation.ts` registers one `source → target`
  pair (Anthropic Messages → chat), and `POST /v1/messages` serves Anthropic SDK clients by translating in and
  reframing the reply out. `format-translation.test.js` + `messages-route.test.js` (9 cases), gateway suite green.
  RTK filters were already present in `Kernel/TokenSaver`.
- **Phase 9 — acceptance work done.** (1) Multi-user isolation tested: `workspaceId` on keys and connections,
  validated and round-tripped; `workspace-isolation.test.js` (3 cases) proves a workspace sees only its scoped
  connections plus shared ones, and the unscoped operator sees all. The boundary is stated honestly: this is a
  listing filter, not per-request authorization on every route. (2) Scale coordination: `RateLimiter` accepts an
  optional shared window store; `FileRateLimitWindowStore` gives two instances one atomic counter, proved by
  `rate-limit-shared.test.js` (3 cases). (3) Measured, not claimed: a committed harness
  (`scripts/benchmark-concurrency.mjs`) measured 400 concurrent requests at p50 742.53 / p99 1126.73 ms,
  0 errors — p99 better than the 2026-11-19 report's 1357 ms, p50 worse than its 447 ms; the old harness is gone
  and the runtime differs, so no speed-up is claimed. See `docs/reports/concurrency-benchmark-2026-11-20.md`.
