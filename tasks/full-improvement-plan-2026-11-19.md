# Full improvement plan — 2026-11-19

**Status:** in progress. The first implementation pass is committed at `9a5d6ae8`; see “Execution status” below.
**Baseline:** `3.69.0`, `pnpm verify` green in CI, 2,477 tests passing locally.
**Inputs:** the deep-look review (findings **D1–D8**) and the user feedback items (**U1–U14**).

## Execution status (2026-11-19)

- **Phase 1 — complete** in the tree: virtual-model override on stream/hedge, stream failover/breaker/cooldown/sticky,
  cooldown cleared by connection id, half-open breaker settlement, disabled virtual model 400, MCP version from
  build info, human `lastUsed`, documentation corrections. New tests: `stream-parity`, `virtual-models-routing`,
  `model-cooldowns`, `circuit-breaker`, `mcp-route`.
- **Phase 2 — complete except Docker runtime proof**: usage and connection counters coalesced with a flush on
  close, container bind opt-in (`OMNIHILBRAS_CONTAINER=1`), `EXPOSE 20138`, docs/version drift fixed. Docker could not
  be started here (no Docker binary); CI workflow is the remaining proof.
- **Phase 3 — substantially implemented, live checks outstanding**: Cline/ClinePass now have separate connection
  records, model lists and usage attribution; both advertise API key + OAuth; a `credentialConnectionId` link replaces
  the global alias, with API-key ClinePass independent. MiniMax refresh de-duplication, forced renewal, expiry
  normalisation, save tolerance and CN verification URL fixed; Aion has a real one-token credential check;
  100milionseek has a package, card, registry row, caps row, slug, logo and tests. Live Cline/MiniMax/Aion/100m
  checks need credentials.
- **Phase 4 — implemented offline, live audit outstanding**: Codex sends the account/user-agent headers, has a
  current default version and wider catalog shapes; the registry URL is fixed. Ollama is keyless again and honours a
  saved endpoint. Generic OpenAI-shaped catalogs now keep context/modalities/pricing. `catalogRefreshedAt` is stored,
  parsed and shown; `pnpm audit:catalogs` refreshes every saved catalog and reports verified/unverified without
  inference. The live all-provider run needs credentials.
- **Phase 5 — complete in the tree**: token-saver shortener/cache/telemetry/no-store defects fixed; stats expose
  before/after bytes and skip reasons; `POST /v1/token-saver/analyze` runs the configured savers in memory without
  storing text; Logs is a real history + live page with search, outcome filter, pause, export and detail; backup has
  a dry-run verify endpoint and a preview in the import flow.
- **Phase 6 — partially implemented**: the **Web Cookie Providers** and **V2 Web** sections are hidden and the rest of the
  group system is intact (OAuth, Free Tier, API Key, Hosted, Local, Custom), Settings has live reload, a section rail
  and a copy-URL action, Token Saver/Logs have skeletons, and the shared `Dialog` primitive now backs the
  connection-method chooser and the add-provider form (focus trap, scroll lock, Escape, focus restore, one close
  control). The remaining modal migrations and exit animations are still to do.
- **Phase 7 — baseline and first optimization done**: `pnpm benchmark:gateway` records the local gateway overhead
  floor (`docs/reports/gateway-overhead-2026-11-19.json`: p50 ~2 ms, p95 ~4.6 ms for non-streaming on this machine);
  the credential path no longer lists and clones the whole vault to read one record. The dry-run verify is in; the
  full UI wizard and the remaining transport measurements are still to do.
- **E2E**: not run locally — Playwright's Chromium is not installed on this machine (`browserType.launch`). CI carries it.


This plan covers everything from the review and the feedback. It is ordered by risk and by
dependency, not by how visible a change is. Every phase ships completely: version bump, tag,
GitHub release, npm publish where applicable, and `pnpm release:audit`.

---

## How to read this plan

- **D** items are defects or drifts found in the deep look. They are reproduced or evidenced.
- **U** items are user-requested improvements.
- **T** items are executable tasks. Each names the files it touches, the behaviour it must produce,
  and the test that proves it.
- “Revert-check” means the guard must be made to fail when the fix is reverted. That is the
  repository’s existing definition of a real guard, and it applies to every new test here.
- A task that needs a live provider account is marked **live**. Those tasks spend real quota and
  cannot be presented as complete from a fixture alone.

## Principles that constrain the plan

1. **The gateway stays the credential and routing boundary.** “Direct-provider speed” means less
   overhead, not a transparent proxy. Failover, the attempt ledger, account isolation, cooldowns
   and the loopback security model stay.
2. **No invented measurements.** Every new page, button and status either reads a real value, says
   it is unknown, or is disabled with the reason.
3. **Provider-neutral core.** Provider ids, wire formats and auth flows stay in
   `Kernel/SDK/<provider>/` and the registration block, never in routing/execution policy.
4. **No prompt content in stored logs.** A diagnostic that needs the prompt is an ad-hoc,
   non-stored analysis endpoint, not a new database.
5. **The browser never holds a provider credential or the dashboard token.** Any new preference
   stays on the two-entry browser-storage allowlist or the allowlist is deliberately widened.
6. **Each phase has a measurable exit gate.** “Looks better” is not an acceptance criterion.

---

## Release train

| Phase | Version | Theme | Main deliverables |
| --- | --- | --- | --- |
| 0 | (in 3.69.1) | Prove the defects and add baselines | parity tests, overhead benchmark, catalog audit script, UI foundations |
| 1 | **3.69.1** | Routing correctness | D1 virtual override in stream/hedge, D2 stream policy parity, D3 cooldown clear, D4 breaker settle, D8 small truth fixes |
| 2 | **3.69.2** | Operational honesty and performance floor | D5 write coalescing, D6 Docker reachability, D7 docs/version drift |
| 3 | **3.70.0** | Provider identity and auth | U1 Cline/ClinePass split + dual auth, U4 MiniMax, U5 Aion, U13 100milionseek |
| 4 | **3.71.0** | Model discovery truth | U2 Codex catalog fix, generic metadata, all-provider live audit, “last refreshed” |
| 5 | **3.72.0** | Token Saver and Logs | U8 token-saver audit + analysis, U7 real logs page |
| 6 | **3.73.0** | Settings and UI system | U6 settings, U3 groups, U9 dialogs, U10 visual polish, U11 motion/skeletons |
| 7 | **3.74.0** | Backup and connection speed | U14 backup verification/UI, U12 measured overhead work |

Phases 3–7 are independent enough to run in parallel after phase 1, but they ship in this order so
each release has one story.

### Newly confirmed while planning (must be in the plan, not discovered later)

- **Ollama is broken on its documented keyless path.** The generic OpenAI-compatible adapter requires
  an auth header, so `listModels({ credential: { type: 'none' } })` throws
  `AUTHENTICATION_FAILED`; saving an Ollama connection with `credential: 'none'` and
  `modelPolicy: 'all'` fails at discovery. The only test uses a stub adapter that ignores the
  credential. The saved Ollama endpoint is also ignored because the on-demand factory wins before
  the saved endpoint is read. This is a critical provider fix and belongs in phase 4.
- **Codex's catalog read omits the account header.** Chat and quota send `ChatGPT-Account-ID` and a
  `User-Agent`; `listModels` sends neither. A multi-seat account is asked for its catalog without
  naming the seat. The client version (`0.154.0`) is also behind a version this repository already
  recorded (`codex_cli_rs/0.159.2`), and the response parser accepts only four container keys.
- **The token saver has four concrete defects beyond “is it connected”.** A prompt saver
  (`caveman`/`ponytail`) disables the always-on tool-result shortener; the per-request compression
  cache replays round-0 messages during local-tool rounds; telemetry bytes are double-counted per
  saver route; external-saver time is charged to the provider's TTFB deadline and can produce a
  false `PROVIDER_TIMEOUT`. The retrieval and backup responses also lack `cache-control: no-store`.
- **Backup import is not atomic across stores.** Validation is total, but the write loop has no
  cross-store rollback; a failure on the sixth store leaves the first five replaced while the UI
  says nothing was written. An export can also exceed the importer's own 20 MiB envelope limit.
- **There are 22 vendored transport copies; two already differ.** Any keep-alive/DNS change must be
  replicated or moved behind an injected transport, and needs a parity test.
- **A keyless credential is not the only Ollama issue:** `provider-resolver.ts` returns the
  on-demand adapter before consulting a saved endpoint, so a remote Ollama can never be reached
  under that id.
- **Aion and MiniMax are not as complete as their adapters look.** Aion’s public catalog means a
  bad key saves and the health sweep reports “Credential check 100%”, and the Check button returns
  `NOT_SUPPORTED`; its transport is not injected. MiniMax has no `validateCredential`, its refresh
  is not de-duplicated even though the refresh token is single-use, and `renewCredential` can
  return the same credential without renewing.
- **ClinePass sharing has reachable side effects:** a refresh can be written to the alias record,
  deleting Cline leaves a routable orphan, the tier’s usage tab filters the wrong provider, and the
  model list can contain the same ids twice.

---

## Phase 0 — Prove the defects and establish baselines

This phase changes no production behaviour. It exists so every later fix has a failing test first
and a number to compare against.

### T0.1 — Routing parity harness (D1, D2)

- Add `Kernel/API/test/routing-parity.test.js` or extend `execution-correctness.test.js` with a
  table-driven set of cases that runs **both** `chat` and `stream` against the same executor:
  - two candidates, first refused by the local limiter;
  - open circuit breaker on the first candidate;
  - provider `429` on the first candidate;
  - virtual-model candidate with an upstream model override;
  - cancellation before first byte.
- The test must show the current divergence: chat walks to the next route, stream throws or does
  not receive the override.
- Add a virtual-model streaming case to `Kernel/API/test/virtual-models-routing.test.js` using an
  adapter with `streaming: true` and an assertion that the adapter saw `model-a`, not `oh/chat`.
- Add a virtual-model hedge case using `hedgeAfterMs > 0` and two targets.
- Revert-check: remove the model override and the new tests fail.

### T0.2 — Cooldown and breaker unit tests (D3, D4)

- `Kernel/API/test/model-cooldowns.test.js`: record a cooldown for `acct-1`, then clear it through
  the same path a success uses (`connectionId !== providerId`), and assert it is gone.
- `Kernel/API/test/circuit-breaker.test.js`: half-open probe granted, no verdict recorded, then
  assert the next `allows()` is not permanently false.
- Revert-check: both fail against the current code.

### T0.3 — Gateway overhead benchmark (U12)

- Add `scripts/benchmark-gateway.mjs` (not part of `verify`) that:
  - starts a loopback provider that answers a fixed non-streaming and a fixed streaming response;
  - sends N requests direct and N through the gateway;
  - records p50/p95 for connect, first byte, total, and gateway-only overhead;
  - writes a JSON report under `docs/reports/` with the machine, Node version and sample count.
- No provider keys and no cost. This is the baseline for phase 7.
- Acceptance: the script prints both distributions and fails if it cannot distinguish direct from
  gateway (a sanity check that it measured something).

### T0.4 — Live model-catalog audit script (U2)

- Add `scripts/audit-model-catalogs.mjs` (opt-in, never in `verify`):
  - reads the local vault via the gateway’s management routes;
  - calls `POST /v1/connections/:id/models/refresh` for each enabled connection;
  - writes provider, connection, before/after count, duration, error, and timestamp;
  - prints a warning that it spends provider quota and is therefore not run by CI.
- The script must not print a credential and must not store provider responses.
- Acceptance: a run with one local Ollama connection completes without network access; a run with
  real providers is recorded separately with the user’s approval.

### T0.5 — Documentation-drift guard (D7)

- Extend `scripts/check-version.mjs` to check the `**Status:** Current — release x.y.z` line in
  `docs/SPEC-SDK.md`.
- Add a small guard that the MCP `serverInfo.version` comes from build info rather than a literal.
- Acceptance: bumping `package.json` without the SPEC status line fails.

### T0.6 — UI primitives plan approved before phase 6

- Inventory every dialog/form from the frontend review (see Appendix A).
- Agree the `Dialog`, `ConfirmDialog`, `Skeleton` and `PageHeader` contracts with the user before
  implementing. This is a design decision, not a phase-0 code change.

**Phase 0 exit gate:** the new tests fail on the current tree exactly for the reasons above; the
benchmark and catalog audit scripts run; no production source is changed.

---

## Phase 1 — Routing correctness (`3.69.1`)

### T1.1 — Apply `candidate.model` in every dispatch path (D1)

- `Kernel/API/src/core/request-executor.ts`
  - `stream()`: pass `{ ...request, model: candidate.model }` to `streamChat`.
  - `tryHedgedRace()`: pass the same override to `chat`.
  - Keep `bareModelFor`/`resolvedModel` in `GatewayService` as the second, provider-side
    normalisation; the executor owns the virtual target override.
- `Kernel/API/src/core/service.ts` needs no change if the executor does this.
- Tests: T0.1 virtual streaming and hedged cases.
- Docs: `docs/architecture/README.md`, `docs/SPEC-SDK.md` (the override is now true for every
  dispatch path), and a line in the virtual-model section.
- Acceptance: adapter receives the target model for chat, stream, hedge, embed, image, audio and
  transcription.

### T1.2 — Make streaming obey the same routing policy as chat (D2)

The stream path is a separate loop. Either make `runSequential` generic over an async iterable, or
mirror the following rules in `stream()` and keep the comments honest:

- **Limiter refusal:** record the attempt, set `lastError`, and continue to the next candidate.
  Do not throw `RATE_LIMITED` while a sibling exists.
- **Concurrency limit:** keep the local “account is busy” stop, but use the same message as chat.
- **Circuit breaker:** call `breaker.allows(candidate.connectionId)` before dispatch; record
  `CIRCUIT_OPEN` when refused; record success on completed stream, failure on a provider fault.
- **Model cooldown:** on `RATE_LIMITED` or an account restriction, call
  `recordModelRateLimit(providerId, model, { retryAfterMs }, connectionId)`.
- **Sticky:** record the successful connection when the stream completes, if the request was not
  explicitly pinned.
- Keep the first-chunk-only failover semantics: after the first byte, a stream never re-plans.
- Tests: T0.1 cases; add a stream 429 case and a stream breaker case.
- Acceptance: a stream and a non-streaming request against the same two accounts make the same
  failover decision; the stream ledger names each attempt.

### T1.3 — Clear cooldowns with the key they were recorded under (D3)

- Change `RequestExecutorDeps.clearModelCooldown` to accept `(providerId, modelId, connectionId?)`.
- Pass `candidate.connectionId` from `runSequential`, the hedge path, and the stream path.
- Change `HealthManager.clearModelCooldown` to forward the connection id.
- Virtual models: clear using `candidate.model ?? input.model` (the upstream model), matching the
  record key.
- Tests: T0.2 cooldown test; add a virtual-model cooldown-then-success case.
- Acceptance: a success on a connection whose id differs from its provider id clears
  `<connectionId>:<modelId>`; the ladder resets to the base on the next refusal.

### T1.4 — Settle every half-open breaker probe (D4)

- Add a neutral `recordAbandoned(key)` or make `allows()` return a lease that must be settled.
- Call it in every path that obtained a probe but cannot record success or failure: limiter
  refusal, cancellation, allowance refusal, exception before dispatch.
- Prefer a `finally` around the dispatch so no future error path can skip settlement.
- Tests: T0.2 breaker test; add a 429 probe case and a `CANCELLED` probe case.
- Acceptance: a half-open breaker returns to closed on a success, re-opens on a failure, and
  returns to `open`/`half-open` on an abandoned probe; it never latches forever.

### T1.5 — Small truth fixes that belong with the same release (D8)

- Disabled virtual model: return a `400 INVALID_REQUEST` with “Virtual model … is disabled”, not a
  retryable `502`.
- MCP `serverInfo.version`: read from `gatewayBuild()`/`build-info`, not `'3.12.1'`.
- Provider card `lastUsed`: format the ISO timestamp through a shared relative-time helper.
- Stale comments in `providerCards.ts` and the routing docs: correct in the same change.
- Tests: disabled virtual model status; MCP version equals build version; a card merge with an
  ISO timestamp renders a human value.

### T1.6 — Documentation corrections for routing

- `README.md` routing table: `401` now hands off to a sibling; `5xx` rotates immediately (or
  change the code if the intended behaviour is retry-then-rotate, but make the two agree).
- `docs/SPEC-SDK.md` routing bullets: same two rules.
- `docs/architecture/README.md`: `x-omnihilbras-connection` is a preference, not a fence; 401 is
  not terminal when a sibling exists.
- Add the SPEC status line to `check-version` in T0.5.

**Phase 1 exit gate:** `pnpm verify` + `pnpm test:e2e`; the new tests fail on revert; release
`3.69.1`, tag, GitHub release, npm publish, `pnpm release:audit` clean.

---

## Phase 2 — Operational honesty and performance floor (`3.69.2`)

### T2.1 — Coalesce the per-request vault and usage writes (D5)

Current behaviour: every successful request writes the entire `connections.json` (up to 4 MiB) and
every request writes the entire `usage.json` (up to 1,000 records), each through `atomicWrite` with
`fsync`. This is a per-request disk write on the hot path.

- `Kernel/API/src/core/connections.ts`: keep `requestCount`/`lastUsed` in memory and flush on a
  short debounce (e.g. 250 ms) and on shutdown. Coalesce concurrent flushes.
- `Kernel/API/src/core/usage-store.ts`: same for usage records; a record may be accepted and
  returned before the file write, with the same documented lag the API-key counter already has.
- Add a `flush()` on both stores and call it from the gateway’s shutdown path.
- Add a guard that a crash between flushes loses at most the documented window, not the whole file
  (the atomic write already prevents a partial file).
- Test: 100 concurrent `recordUsage` calls produce bounded writes (counted through a fake writer),
  and `flush()` persists the final totals.
- Acceptance: no full-file write per request; counters still correct after restart; existing tests
  pass.

### T2.2 — Make the Docker image reachable (D6)

- `Dockerfile`: `EXPOSE 20138`, not `8787`.
- Either:
  - support an explicit container binding mode (`OMNIHILBRAS_HOST=0.0.0.0` allowed only when a
    deliberate `OMNIHILBRAS_CONTAINER=1` opt-in is set), with the security warning in the docs; or
  - document `network_mode: host` and remove the port mapping from `docker-compose.yml`.
- Add a smoke test in `docker.yml` that starts the image, waits for `/health`, and fails if it
  cannot reach it. This is the check that would have caught the current state.
- Update `docs/INSTALL.md` with the exact command and the security trade.
- Acceptance: `docker compose up` answers `/health` from the host in CI.

### T2.3 — Fix the doc/version drift that is not routing-specific (D7)

- SPEC status line.
- MCP version (already in T1.5; keep one owner).
- `providerCards.ts` comment: the gateway now keeps a per-connection request counter.
- `README.md` “Current state” and any stale route table entries.
- Add a small `tests/documentation-truthfulness.test.js` family where a claim can be checked
  mechanically (MCP version, SPEC status, card endpoint = registry base for registered providers).

**Phase 2 exit gate:** verify + e2e + docker; release `3.69.2`; no behavioural change beyond the
write schedule.

---

## Phase 3 — Provider identity and authentication (`3.70.0`)

### T3.1 — Cline and ClinePass become two providers (U1)

**Current state:** one `cline` connection owns the credential; `clinepass` is a global alias, a
`connectionProviderId` card link, a shared-catalog special case, and a separate adapter package
that subclasses the Cline adapter. Cline's card endpoint is the loopback gateway
(`http://127.0.0.1:20138/v1`), not Cline's API. `ClinePassAdapter` is the Cline wire plus an id/name
and a `cline-pass/` model filter; the vendored copies are guarded by `cline-twin-drift`.

**Known defects in the current sharing:**

- `ConnectionRecord.providers` is parsed and serialized but **nothing writes it**; sharing is
  actually done by `providerAlias` plus a `{ type: 'none' }` alias record.
- `clinepassAdapter` can write a refreshed token back to the **`clinepass`** alias record, while
  the documentation says it writes to `cline`. WorkOS rotation then invalidates Cline's stored
  refresh token.
- Deleting the Cline connection does not remove the ClinePass alias; the orphan keeps
  `hasCredential: true` and its models, so `/v1/models` advertises a tier that cannot serve.
- The tier is listed from the alias record's stored ids **and** merged live from the recommended
  feed, so `/v1/models` can contain duplicates.
- Requests routed to the tier carry `connectionId: 'clinepass'`, but the ClinePass usage tab filters
  `providerId = 'cline'`; the tier's own requests are not reachable from its page.
- Cline/ClinePass have **never been proven live** for a ClinePass request (recorded in
  `tasks/todo.md`). Every claim is unit-tested only.

**Target state:**

- Two independent cards, provider ids, connection records, model lists and failure attribution.
- Two auth modes per card: **API key** and **sign in**.
- OAuth is a real flow for each card, with its own route surface.
- No global `providerAlias` lookup for ClinePass. A credential may still be *linked* explicitly,
  because Cline's own client stores one WorkOS session for both products and refreshing two copies
  of one rotating token invalidates one of them.

**Design:**

1. **Connection identity.** `cline` and `clinepass` each save under their own id. Remove
   `connectionProviderId: 'cline'` from the catalog card and `clinepass: 'cline'` from
   `provider-alias.ts`. `clinepass` registers its own `.onDemand` factory with
   `validateOnSave: true` and default `connectionId = 'clinepass'`.
2. **Credential linking, not aliasing.** Add an optional `credentialConnectionId` (or
   `credentialSource`) to a connection record. A ClinePass OAuth connection may name the Cline
   connection whose token it uses. This is explicit on the record, visible in the UI, and does not
   make every ClinePass request follow a global map. An API-key ClinePass connection stores its own
   key and has no link.
3. **API key path.** `authModes: ['oauth', 'api-key']` for both cards. Cline's API key comes from
   `app.cline.bot` → Settings → API Keys and is sent as `Authorization: Bearer`; the adapter
   already sends a non-JWT token verbatim and validates against `GET /users/me`. ClinePass uses the
   same key page. `X-Response-Format: openai` is the vendor’s recommendation for non-streaming;
   `unwrapClineEnvelope` remains the fallback, so this is an explicit header plus the existing
   tolerance, not a replacement.
4. **OAuth path.** Add `/v1/oauth/clinepass/start`, `/session/:id`, `/callback/:id` and
   `/exchange` (or a provider parameter with a fixed, documented table). `connectCline` takes a
   target provider id; it no longer hardcodes `'cline'`. For a ClinePass OAuth connection, the
   session stores either its own token **or** a link to the Cline connection. Default to the link
   and let the user choose “sign in separately” only after a warning about refresh-token rotation.
5. **Model catalog.** ClinePass reads its tier from `recommendedModelsUrl` as it does today, but now
   through its own connection/adapter. Remove `sharedCatalogProviders` and
   `ensureSharedCatalogConnections` once migration is done; remove the duplicate-merge path.
6. **Endpoint correctness.** Change the Cline card and registry row to
   `https://api.cline.bot/api/v1`. Add a test that a registered provider's card endpoint equals its
   registry base and its adapter base, or is an explicitly documented custom endpoint.
7. **Usage and deletion.** Route tier requests to the `clinepass` connection; fix the provider usage
   tab to filter its own provider id; deleting an owner must not leave a routable orphan (cascade or
   clear the link).
8. **Migration.** On first load after upgrade:
   - keep the existing `cline` connection;
   - create a `clinepass` connection that links to it, so nothing breaks;
   - show “Linked to Cline — add a ClinePass API key for an independent account” on the card;
   - do not copy the token.
9. **Tests:** new `Kernel/API/test/clinepass-independence.test.js`; update
   `clinepass-catalog.test.js`, `new-provider-cards.test.js`, `provider-cards.test.js`,
   `provider-oauth-routes.test.js`, `provider-options.test.js`, `cline-twin-drift.test.js`,
   `provider-usage-tab.test.js`, and the docs.
10. **Live:** one Cline API key and one ClinePass API key (or a Cline subscription with ClinePass) to
    prove the API-key path, the ClinePass model list, one chat/stream, and the refresh write-back.
    Mark the result in the release notes.

**Open decision for the user:** whether a ClinePass OAuth connection may use its own token (separate
sign-in) or must always link to a Cline connection. The recommendation is API key for independence,
linked OAuth for convenience, with the rotation warning stated in the dialog.

### T3.2 — MiniMax Code auth completion (U4)

The adapter is a complete-looking device flow, but it has concrete defects that match “auth does not
finish”:

- **No `validateCredential`.** The save path does not prove the credential, and `POST
  /v1/connections/minimax-code/check` is `NOT_SUPPORTED`.
- **Refresh is not de-duplicated.** The refresh token is single-use, but two concurrent requests
  can both POST `refresh_token`; one gets `invalid_grant`, which is recorded as a refused login.
  Add the Cline-style in-flight registry keyed by refresh token.
- **`renewCredential` is a no-op when the credential is not locally expired.** The renewal pass
  uses a 30-minute window while the adapter only renews inside 10 minutes, so the pass can report
  success while nothing was renewed. Make `renewCredential` force a renewal, and keep due-ness in
  the pass.
- **`expiresAt` is only persisted when `expires_in` is a number.** A string lifetime or a missing
  field leaves the credential unmeasurable and the session dies silently later. Normalise it and
  refuse honestly when it cannot be read.
- **A catalog failure throws away an approved sign-in.** The save does not pass
  `tolerateDiscoveryFailure`, unlike Cline/Qoder. A 5xx on `/models` turns a good grant into
  `CONFIGURATION_ERROR`.
- **CN verification URL falls back to the global host**, and the catalog URL hardcodes
  `region=en&buildEnv=prod` for both regions. Derive both from `MINIMAX_CODE_SITES`.
- **`slow_down` is collapsed to `pending`**, while the dashboard polls at a fixed 1 s; honour the
  backoff.
- **`healthCheck` claims `verified: 'credential'` from a model list** whose authentication is not
  proven. Either prove the endpoint rejects a bad token or report `catalog`/`unknown`.
- Delete the dead `minimaxCodeSignInAdapter` cache (memoised by provider id, never imported; it
  would share one adapter across accounts if used).

Add `Kernel/SDK/tests/minimax-code.test.js` (refresh rotation + concurrency, expiry, listModels,
SSE, quota rewrite) and a gateway test for an approved poll → saved connection → mirrored credential
after refresh. Reproduce the live flow with the user’s account and record which region was tested.

### T3.3 — Aion Labs live verification (U5)

Aion is a 15-line OpenAI-compatible subclass, but its public catalog makes three existing claims
untrue:

- **A bad key saves and reports healthy.** The save’s only check is model discovery; the catalog is
  public, so any string imports models and the health sweep marks the card “Credential check 100%”.
- **The Add-connection Check button is dead** — `POST /v1/connections/aion-labs/check` returns
  `NOT_SUPPORTED` because the generic adapter has no `validateCredential`.
- **The gateway transport is not injected** (`new AionLabsAdapter()` builds its own 30 s transport
  with no `checkDestination`), so it ignores the gateway’s timeout and SSRF policy.
- The card, registry and adapter each carry the base URL; nothing checks they agree.

Tasks:

- Capture the public `/v1/models` response as a fixture (we measured it returns
  `aion-labs/aion-2.0`, `aion-labs/aion-3.0`, context, pricing, modalities, tool support).
- Implement a real `validateCredential` (a cheap authenticated read that the public catalog cannot
  satisfy), register with `validateOnSave: true`, and make the health/check state honest until then
  (`catalog`/`unknown`, not “credential”).
- Pass `{ transport: this.transport }` from `OWN_PROVIDER_ADAPTERS` / the service.
- Add `Kernel/SDK/tests/aion-labs.test.js` through the real class: list, chat, stream, 401 mapping;
  drop the contract exemption.
- Cross-check card/registry/adapter base URL in a test.
- **Live:** one key for chat, streaming, tools and `tool_choice: required`; record the free-tier
  limits against the account dashboard rather than copying them from a release note.

### T3.4 — Add 100milionseek as a first-class provider (U13)

Provider facts from its docs and live `/api/status`:

- Base URL `https://100milionseek.top/v1`, OpenAI-compatible.
- Auth: `Authorization: Bearer hms-…`; key from its dashboard.
- Model: `deepseek-v4.1-flash-free` (198K context, 64K output, streaming, tools).
- Daily allowance: 100M tokens/day per account (bonus windows can raise it), reset 00:00 UTC;
  `x-quota-limit`, `x-quota-used`, `x-quota-remaining`, `x-quota-reset` on responses.
- Its `/v1/models` requires a key; `/api/status` is public.
- Own mark: `https://100milionseek.top/favicon.svg` (a small SVG; commit it as
  `public/providers/100milionseek.svg`).

Tasks:

- New `Kernel/SDK/100milionseek` package (`@omnihilbras/sdk-100milionseek`), OpenAI-compatible
  adapter with its own id, base, model path and Bearer auth.
- Add `100milionseek` to `Kernel/Tools/src/providerRegistry.ts` with `auth: 'api-key'`,
  `formats: ['openai']`, `modelsUrl`, and an optional `usageUrl` if a real one exists.
- Add a caps row (`tools: true`, forced choice only if the wire proves it; test it before claiming
  `required`).
- Add the card to `src/data/providers.ts` (group `free-tier`), with the real free allowance and the
  key page, and the logo.
- Add a slug (`hms` is proposed) to `PROVIDER_SLUGS`.
- Register `.onDemand('100milionseek', …)` in `Kernel/API/src/core/service.ts`, passing the gateway
  transport.
- Add tests: registry/card/caps consistency, package contract, a captured `/v1/models` fixture, a
  captured chat/stream fixture, and a guard that the logo is committed.
- Add README/SPEC/docs lines.
- **Live:** the service was overloaded and sign-ups were paused during the scan. Record that state
  and verify with a key when sign-ups resume; do not claim a live model test until then.

### T3.5 — Cline/ClinePass and Aion/MiniMax documentation

- README provider list, SPEC provider table, architecture provider categories.
- Release notes must state which live checks passed, which were blocked, and why.

**Phase 3 exit gate:** verify + e2e; live results recorded; release `3.70.0`.

---

## Phase 4 — Model discovery truth (`3.71.0`)

### T4.1 — Codex fetches the account’s whole catalog (U2)

- The catalog endpoint gates entries by `minimal_client_version`. `CODEX_CLI_VERSION = '0.154.0'`
  is already behind current Codex CLI releases — this repository has a measured
  `codex_cli_rs/0.159.2` string — so entries are silently absent from a 200 response.
- **Send the same identity as chat.** `listModels` currently sends only `accept`, `authorization`
  and `originator`; chat, quota and streaming also send `ChatGPT-Account-ID` when the credential
  carries one and `User-Agent: codex_cli_rs/<version>`. Copy that header construction so a
  multi-seat account is asked for the seat it will use.
- Measure with a real Codex account:
  - `client_version=0.154.0`, the current CLI version, and a high sentinel;
  - record the returned ids, `minimal_client_version`, plan fields, top-level keys, and whether the
    response paginated;
  - choose the lowest value that returns the account’s full catalog without claiming a client the
    endpoint refuses.
- Make the value configurable (`OMNIHILBRAS_CODEX_CLIENT_VERSION`, already present) and show the
  value in Settings.
- **Keep the default current, and expose the override.** Do not probe with a fabricated “99.0.0” client:
  that claims a client the account is not running. The measured CLI version is the honest default; an
  operator with a newer client sets `OMNIHILBRAS_CODEX_CLIENT_VERSION`.
- **Separate “empty” from “unreadable”.** If no recognised container key is present, throw
  `INVALID_RESPONSE` naming the top-level keys seen; do not report “no models” and blame the client
  version for a shape change. Accept `data`, `models`, `results`, `items`, and `data.models`.
- Do not filter by plan or “free” unless the user asked for it; the catalog is the account’s.
- Add a fixture test with captured entries carrying different `minimal_client_version` values,
  asserting the low version omits them and the chosen version includes them.
- Add `Kernel/API/test/catalog-version-freshness.test.js`: parse every `codex_cli_rs/x.y.z` string
  in the tree and fail if `CODEX.cliVersion` is older than the newest.
- Fix the registry `modelsUrl` for Codex (it currently points at `.../responses/models`, which the
  adapter never calls), or remove it and mark the catalog as adapter-owned.

### T4.2 — Fix Ollama’s keyless path and saved endpoint (critical)

Measured:

- `OllamaAdapter.listModels({ credential: { type: 'none' } })` throws
  `AUTHENTICATION_FAILED` because the inherited `OpenAICompatibleAdapter` requires an auth header.
- `PUT /v1/connections/ollama` with `credential: 'none' + modelPolicy: 'all'` therefore fails at
  discovery; the route does not tolerate discovery failure.
- The saved endpoint is ignored: `ProviderResolver.resolve` returns the on-demand factory before it
  reads `saved.endpoint`, and the adapter hard-codes `http://localhost:11434/v1`.

Fix:

- Make the Ollama adapter’s auth `required: false`, so `{ type: 'none' }` sends no header and a
  pasted key still sends `Bearer <key>` for a proxied Ollama.
- Pass the saved endpoint into the Ollama factory, or make the resolver prefer an explicitly
  endpoint-configurable provider’s saved endpoint over the factory constant.
- Replace the stub in `credential-free-connection.test.js` with the real `OllamaAdapter` and a
  recording transport; add a new `Kernel/SDK/tests/ollama.test.js`.
- Add a remote-endpoint test: a saved `http://127.0.0.1:<port>/v1` reaches that port.
- Acceptance: save, refresh, model list and a chat request all work for a keyless Ollama, and a
  saved remote endpoint is the one used.

### T4.3 — Generic model metadata, not just ids

- `Kernel/SDK/openai/lib/openai-compatible.ts` currently maps only `id` and `owned_by`.
- Extend it (and each vendored copy) to preserve what the OpenAI-shaped catalog states:
  context length, max output, modalities, pricing, tool support, and display name, using the same
  `ModelMeta` projection as the catalog.
- Accept `{ data: [...] }`, `{ models: [...] }`, `{ results: [...] }` and report the top-level keys
  on failure. This is the same shape tolerance Codex needs.
- Put the mapping in one file per package, with a fixture test per provider where the shape differs.
- Add a guard that a generic provider’s `/v1/models` entry carries metadata when its catalog did.

### T4.4 — “Latest models” audit for every provider (U2)

- Run `scripts/audit-model-catalogs.mjs` (T0.4) against every enabled connection, with the user’s
  approval. Every listing is an unbilled metadata read; the script must never call chat, streaming
  or `validateCredential` (the latter spends a real request on Nous).
- Record per provider: live endpoint used, before/after count, HTTP status, top-level keys,
  metadata present, duration, and whether the last refresh changed anything.
- Add `catalogRefreshedAt` to the connection record and show “last refreshed” on the provider page.
- Add an “Update all models” button on Providers with real progress and a result summary; each row
  can still be refreshed alone.
- Providers that cannot list models must say so: `models: false` in `/v1/models` output and an
  `unavailable` entry, never an empty list that reads as “this account has no models”.
- Static-list providers (`kiro`, `codebuddy-*`, `chatgpt-web`, `gemini-web`, `grok-web`,
  `perplexity-web`, `tokenharbor-web`, `deepseek-web`, `zcode`, `qoder` fallback) must be listed as
  a known limitation with the reason, and the UI must say “static list” rather than implying a live
  catalog. Do not invent a live endpoint for a product that does not publish one.
- Acceptance: the audit report is committed under `docs/reports/` (or linked from the release) and
  names every provider that could not be verified. No simulated catalog is saved.

### T4.5 — Fix provider endpoint/metadata mismatches found by the audit

- Cline card/registry loopback endpoint (T3.1) is one already-known case.
- Add a test that every registered provider’s card endpoint equals its registry base, except
  documented custom/local endpoints.
- Add a test that every `modelsUrl` in the registry is either used by that provider’s adapter or
  explicitly marked “adapter-owned”.
- Fix the latent `service.ts:1093-1095` path that calls `requireAdapter` instead of
  `resolveAdapter`; it would 500 for every on-demand provider if a new caller used it.
- Add a `CATALOG_NOT_RECORDED` map with a reason, replacing the “duplicates the OpenAI wire”
  excuse, so a new provider cannot claim catalog coverage by sharing the completion wire.

**Phase 4 exit gate:** audit report; Codex live count; Ollama keyless save/refresh works; release
`3.71.0`.

---

## Phase 5 — Token Saver and Logs (`3.72.0`)

### T5.1 — Token Saver end-to-end audit (U8)

Prove, with tests and one measured live request, each of these:

1. `OMNIHILBRAS_TOKEN_SAVER=1` reaches `GatewayService` and `preparedMessages`.
2. The saver runs on chat, stream and `/v1/responses` (all of which go through `preparedMessages`);
   it does not claim to run on embeddings/images.
3. Order: complete tool rounds → local compressor → Headroom → PXPIPE (Anthropic image context
   only) → caveman/ponytail → history trim → cache anchor in the adapter.
4. Every lossy rewrite is reversible when `reversible` is on; `GET /v1/token-saver/:id` returns the
   original; the store is bounded and lost on restart (already documented).
5. External savers fail open with a reason; a broken URL cannot cost a request.
6. Telemetry reaches the usage record and `/v1/token-saver/stats`; skip reasons and before/after
   bytes are not dropped.
7. The page’s “compressed / all requests” denominator is honest: distinguish requests with
   telemetry from all requests.

**Concrete defects to fix in the same pass (all reproduced by reading the code):**

- **A prompt saver disables the default tool shortener.** `compressToolResults` is only in the
  `else` branch; `caveman`/`ponytail` alone set `saversActive`, so prompts can become larger than a
  stock gateway. Call the shortener before the prompt savers, or integrate its telemetry into the
  saver list.
- **Local-tool rounds replay round-0 messages.** `compressionCache` is keyed by `scope.id` and
  `runLocalToolRounds` calls `preparedMessages` with a growing message array; the cache returns the
  first round. Key the cache by a content hash or bypass it for tool rounds.
- **Telemetry bytes double-count per route.** `record()` is called once per compression route but
  with whole-conversation `bytesBefore`/`bytesAfter`; the stats route subtracts each, so two routes
  in one request report twice the savings. Store per-route before/after, or count the conversation
  delta once.
- **External saver time is charged to the provider’s TTFB deadline.** `preparedMessages` runs
  inside `withDeadline(..., ttfbMs, ...)`, so a slow PXPIPE/Headroom yields
  `PROVIDER_TIMEOUT` for a delay the provider never caused. Move preparation outside the provider
  deadline, or give savers their own budget and report `skipped: deadline` honestly.
- **A saver that ran and saved nothing is invisible.** The built-in compressor only records
  telemetry when `savedTokens > 0`; add a `skipped`/`ran-no-savings` entry with a reason.
- **The default tool shortener produces no telemetry at all.** Add a `tool-shortener` saver row and
  record it in usage, or make the page say this mode is not measured.
- **No `cache-control: no-store` on retrieval and backup.** `/v1/token-saver/:id` returns prompt
  content and `/v1/backup` returns credentials; add both to the no-store list in `server.ts`.
- **Reversibility is overclaimed.** JSON array dedupe, string elision, depth markers and the
  non-reversible text/log paths have no stored original. Either store them when `reversible` is on,
  or label those rewrites “irreversible” on the page and in the SPEC.
- **Cache-anchor interaction is unmeasured.** Compression selects by the last user message, so
  historical blocks change every turn and can invalidate provider prefix caching. Record saver-on
  vs saver-off cache read/write tokens (or a per-request flag) and show the ratio; do not claim a
  saving without it.

Add a `POST /v1/token-saver/analyze` route that accepts a message array or text and returns the
per-saver result **without storing it**. This is how the page can show a real before/after without
putting prompt content in `usage.json`.

**Tests:** `Kernel/API/test/token-saver.test.js` (caveman + shortener, cache in tool rounds),
`token-saver-stats.test.js` (two routes, ran-no-savings, per-route bytes),
`token-external-savers.test.js` (slow saver does not become `PROVIDER_TIMEOUT`),
`token-saver-integration.test.js` (stream + retrieval + no-store), and a suite that proves
irreversible rewrites are labelled.

### T5.2 — Token Saver analysis page (U8)

Replace the current four cards + two tables with:

- **Status:** enabled/disabled, target ratio, protect-recent, reversible, history trim, cache anchor,
  Headroom/PXPIPE reachable or not (from `/v1/settings` and a real health probe where available).
- **Savings over time:** reuse `usage-breakdown` timeline and `UsageCharts` (already lazy).
- **By saver:** ran/skipped, skip reasons, before/after bytes, estimated tokens, per-request
  drill-down.
- **By provider and by model:** reuse `byProvider`/`byModel`.
- **Cache:** read/write tokens, cache-anchor on/off comparison only when there is data for both.
- **Analysis lab:** paste or select a conversation, run `POST /v1/token-saver/analyze`, show the
  before/after diff, reversibility markers and which savers ran/skipped and why. Nothing is stored.
- **Honesty:** every cost figure is labelled estimated; no “money saved” claim unless pricing is
  known and stated.

### T5.3 — Real Logs page (U7)

The page exists but is a 42-line live list. Build a real one:

- **History:** page `GET /v1/usage` with its existing filters (`period`, `provider`, `model`,
  `connection`, `outcome`, `limit`, `offset`). A reload must show history, not an empty page.
- **Live tail:** merge the SSE stream; pause buffers instead of dropping; reconnect with backoff and
  say how many events were missed.
- **One stream:** a shell-level provider shared by `FailureNotifications`, `AppHomePage` and
  `LogsPage`, instead of three independent subscriptions.
- **Filters/search:** outcome, provider, model, connection, time range, request id, error code.
- **Detail drawer:** request id, attempts with connection/outcome/error, latency, token usage,
  cache, compression telemetry. No prompt content.
- **Actions:** copy row, copy all, export JSON/CSV (safe: no prompts), clear filters.
- **Presentation:** tabular numerals, stable keys, `aria-live` off by default with a toggle,
  distinct icon from Usage, consistent page header.
- **Tests:** log stream route; history merge; pause/reconnect; export contains no prompt fields;
  e2e on the page.

**Phase 5 exit gate:** verify + e2e; a real compressed request appears on the analysis page and a
real request appears in history; release `3.72.0`.

---

## Phase 6 — Settings and UI system (`3.73.0`)

### T6.1 — One dialog primitive (U9, U11)

Create `src/ui/Dialog.tsx` (and `ConfirmDialog`) with:

- portal to `document.body`;
- `role="dialog"`, `aria-modal`, labelled heading;
- Escape and backdrop close, both gated by one `busy` flag;
- Tab/Shift-Tab focus trap, focus restore, body scroll lock;
- enter **and exit** animation (`--motion-fast/base`), reduced-motion aware;
- one header: title, subtitle, single close control; no fake traffic lights;
- size variants and a mobile bottom-sheet mode;
- optional `onBeforeClose` for unsaved changes.

Migrate every current dialog and replace the five `window.confirm` sites. Add a static guard that
no new `role="dialog"` is written outside the primitive, and extend `tests/accessibility.test.js`
with focus-trap and scroll-lock assertions.

### T6.2 — Forms live in the page, not in a navigation (U9)

Interpretation used here: a form opens as a **large dialog/drawer over the current page**, with a
full-page fallback for deep links and for very long forms. If the user meant the opposite (forms
should be full pages), the same component supports a `fullPage` variant; the decision is recorded
before T6.1 is implemented.

- `ProvidersPage.openAdd()` must open the method dialog or the API-key dialog over the list, not
  navigate to `/providers/:id` for OAuth/web cards.
- Provider detail keeps its route for direct links, but every “Add account”, “Edit”, “Connect”,
  “Delete” and “Backup import” action uses the primitive.
- Add unsaved-changes guard to the Settings port field, Resilience panel and account owner/purpose
  form.
- Standardise the outcome channel: toast for action results, `role="alert"` for page-failure state.

### T6.3 — Hide the two web groups (U3)

Recommended implementation: **remove the section grouping from the Providers page** and replace it
with a single responsive grid plus filter chips (All, OAuth, API key, Web session, Free tier, Local,
Custom). The `web-cookie` and `v2-web` labels disappear; the providers remain, because removing the
cards would remove working integrations.

- Replace `providerGroupOrder`/`providerGroupLabels` rendering with a filter model.
- Keep the group metadata for filtering and tests, but no visible “Web Cookie Providers” or
  “V2 Web” headings.
- Add a test that the two strings no longer render and that every catalog card still appears under
  some filter.
- If the user meant “remove those providers entirely”, that is a separate decision; the plan does
  not delete them without confirmation.

### T6.4 — Advanced Settings page (U6)

- Tabs or a sticky section rail: Appearance, Desktop, Gateway access, Startup configuration,
  Updates, Data & recovery, Advanced.
- One owner for `requireApiKey` (link the API Keys page to Settings or vice versa).
- Search across setting labels; section anchors; “resolved vs default” for read-only values.
- Sticky unsaved-changes bar with Reset, for the port and any future editable value.
- `useGatewayReload` so a gateway restart updates the page.
- Real buttons only:
  - Copy gateway URL / copy launch config (redacted);
  - Test connection (already real);
  - Restart gateway (desktop only; browser shows why it is unavailable);
  - Check/Download/Install update (desktop only);
  - Export diagnostics (desktop only);
  - Open backup (link or dialog);
  - any new preference is either wired or shown disabled with a reason.
- Add a Playwright sweep of every settings button: click, assert one of success/error/disabled-reason;
  no button may be a no-op. Remove `KNOWN_DEFECTS` exceptions.
- Persist only display preferences, within the existing browser-storage allowlist.

### T6.5 — Visual polish and motion (U10, U11)

- Add design tokens for radius, spacing, shadow, z-index and type scale; replace the
  `!px-3 !py-2 !text-xs` idiom with button size variants.
- One page header component (eyebrow + h1 + description) used by every route.
- One focus language (`:focus-visible` or `.input` halo, not both).
- Finish the hex-token pass in dialogs; widen `tests/dashboard-wiring.test.js` to all of `src/`.
- Use the existing motion tokens: dialog enter/exit, toast enter/exit, drawer transform, list
  stagger. Do not animate `left`, `width` or `padding`; use transform/opacity.
- Remove fake progress bars; either a real indeterminate bar or `aria-valuenow`.
- Add `<Skeleton>` variants: page, card, table, chart, list. Replace bare `…`/“Loading…” in
  Token Saver, Usage, Models, Settings, Logs, Routing and Provider detail.
- Reserve layout space for notices and data regions to remove the largest shifts (Usage charts,
  Settings startup block, Token Saver tables).
- Keep `tests/ui-performance.test.js` green: no `backdrop-filter` behind sticky/scrolling content,
  no `key={location.pathname}`, compositor-only animations.

### T6.6 — Global button audit (U6, U10)

- Extend `tests/e2e/buttons.spec.ts` to every route and every dialog opened by it. Each control
  must do one of: perform a real action with a visible result, navigate, open a dialog, or be
  disabled with a reason. A click that changes nothing is a failure.
- Remove the remaining `KNOWN_DEFECTS` exemption (the “Dismiss notification” case) and prove the
  fix at runtime.
- Add a static check for clickable elements without a handler, and for `button` elements whose only
  handler is `preventDefault`.
- Add a check that every form control has a label and every dialog has a name (some already exist
  in `tests/accessibility.test.js`; extend rather than duplicate).

**Phase 6 exit gate:** verify + e2e; every dialog passes focus/scroll/exit checks; settings button
sweep covers all controls; the global button audit has no dead control; release `3.73.0`.

---

## Phase 7 — Backup and connection speed (`3.74.0`)

### T7.1 — Encrypted backup deep verification and UI (U14)

Audit:

- Every store is exported, including usage, cooldowns and web profiles; the payload version is 2
  and version 1 still imports. Ten `Local*Store` classes are present; the envelope is AES-256-GCM +
  scrypt and the credentials are re-wrapped under the destination master key.
- **Import is not atomic across stores.** Validation is total, but the write loop has no
  cross-store rollback: a failure on the sixth store leaves the first five replaced while the UI
  promises “nothing is written at all”. Add a two-phase commit or snapshot/rollback, and test a
  failure on the last store leaves every store untouched.
- **Export can produce a file the same build refuses.** `encryptBackup` does not enforce the
  20 MiB envelope limit; `decryptBackup` does. With three web profiles (4 MiB each) plus a 4 MiB
  usage file, export succeeds and import fails. Decrypt-and-parse the payload once before returning
  the envelope, and fail the export with the import’s own message.
- **Section versions are strict.** Each section carries `version: 1` and rejects anything else; the
  first store format bump makes every old backup unimportable as a whole. Accept `version <= current`
  with an explicit migrator per section, and test an older section.
- **Web profiles can be restored under the wrong provider and losses are silent.** The importer
  derives the destination from `providerOf(connectionId)` and skips a missing connection with no
  entry in the result. Report skipped profiles; validate the profile's provider against the
  destination.
- **Desktop backup save does not chmod an existing file.** `writeFileSync(..., { mode: 0o600 })`
  ignores the mode when the file exists; add `chmodSync` after write.
- **No `cache-control: no-store` on `/v1/backup`**; it returns credentials.
- **The UI pins `envelope.version === 1`** by hand. Read the accepted envelope version from the
  gateway or drop the check and let the gateway answer.
- Add a **dry-run verify** endpoint (`POST /v1/backup/verify`) that decrypts and returns section
  names, record counts, format/version and warnings without writing.
- Add round-trip tests for every credential shape and every section, including an OAuth credential
  with all nine fields, a keyless connection, and a web profile.
- Add a test that an unauthenticated `POST /v1/backup/import` is refused when management enforcement
  is on (export is covered; import is only implicit).

UI:

- Export wizard: passphrase + confirm, strength meter, section checklist, “what this file contains”
  and “what it does not contain”, self-check before save, save via desktop dialog or download.
- Import wizard: pick file → dry-run verify → show section counts and what will be replaced →
  explicit confirm dialog → progress → result with per-section counts. No `window.location.reload()`
  after import; re-read the stores and keep the page.
- Drag-and-drop, file size hint (25 MiB server cap), last-backup timestamp, copy/print recovery
  instructions. No credential is ever shown.
- Tests: client envelope validation, dry-run rendering, confirm required, no reload, no prompt
  content, desktop file mode on overwrite.

### T7.2 — Connection speed, measured (U12)

Baseline from T0.3, then optimize only what the numbers justify:

1. **Remove per-request full connection list clones.** The request path currently calls
   `connections.list()` up to four times (`planRoute`, `CredentialManager.context`,
   `acquireConcurrency`, `contextForRequest`), and each `list()` awaits the mutation queue and
   deep-clones every record. Add `get(id)` to both stores, use it for `modelPolicy` and
   concurrency, and compute the route list once per request and pass it through the scope.
2. **Keep credential decryption once.** `LocalConnectionStore` already decrypts at load; the cost is
   the listing, not decryption. State this correctly and cache the per-connection `modelPolicy`.
3. **Transport reuse.** Node’s global fetch pools sockets, but the default keep-alive is short.
   Evaluate an explicit `undici.Agent` (keep-alive 30 s, bounded connections, `autoSelectFamily`)
   injected into `FetchHttpTransport`; keep `redirect: 'error'` and abort propagation. Do not
   introduce a custom DNS lookup without moving `assertPublicDestination` into it.
4. **Vendored transport parity.** There are 22 copies and two already differ (`openai`,
   `opencode-console`). Add a parity test (normalising documented differences) before changing any
   transport; otherwise the 20 identical copies drift silently.
5. **Provider latency, not gateway latency.** `latencyMs` is measured before dispatch and includes
   `preparedMessages`, adapter resolution, concurrency and credential lookup; the card shows it as
   provider latency. Measure inside `transport.request/stream` and store `providerMs` beside total.
   Show the split in the Logs detail drawer.
6. **Move saver preparation outside the provider deadline.** External Headroom/PXPIPE time is
   currently charged to the provider TTFB, producing a false `PROVIDER_TIMEOUT`. Give savers their
   own budget and report `skipped: deadline`; the provider deadline starts when the provider call
   starts.
7. **Body handling.** `readJsonBody` buffers three copies of up to 32 MiB. Measure before changing;
   if large requests are the bottleneck, use a single buffer and a streaming parser with the same
   limits. Do not weaken the body-size guard.
8. **Cache interaction.** Compression by last-user-message can invalidate provider prefix caching;
   measure cache read/write tokens with the saver on vs off (T5.1) before claiming a saving.
9. **Warm state.** Warm the adapter and model catalog on save/health, not on the first user request;
   preconnect on a successful credential test where the transport supports it.
10. **Target, not a promise:** after baseline, set a budget such as “gateway overhead p50 < 50 ms
    and p95 < 200 ms for a non-streaming turn; first-byte overhead p50 < 50 ms for a stream” only if
    the measurement supports it. Report before/after in the release notes.

**Do not:** turn the gateway into a transparent TCP proxy, remove failover, share a socket across
accounts with different credentials/proxy pools, or bypass credential isolation to save a few
milliseconds. The user-visible goal is “feels direct”, not “no gateway”.

**Phase 7 exit gate:** benchmark before/after committed; backup dry-run and rollback tests pass;
release `3.74.0`.

---

## Cross-cutting work — Documentation and release (every phase)

- Update `README.md`, `docs/SPEC-SDK.md`, `docs/architecture/`, `docs/CLI.md` if verbs change,
  `AGENTS.md` boundaries if a rule changes, and the relevant `tasks/` plan.
- Run `pnpm version:fix` after changing version-sensitive constants; `pnpm version:check`.
- `pnpm verify` + `pnpm test:e2e`.
- Commit, tag `v<version>`, push `origin/main`, GitHub release with what changed and how to verify.
- `npm publish --access public` from `cli/` when the CLI changed; confirm with
  `npm view @hilbras/omnihilbras@<version> version`; `pnpm release:audit` shows no new gap.
- Release notes must state what was measured live, what was fixture-only, and what remains
  unverified.

---

## Test and guard matrix

| Area | New/updated guard |
| --- | --- |
| Virtual model override | `virtual-models-routing.test.js` chat + stream + hedge |
| Stream policy parity | `execution-correctness.test.js` / new `stream-parity.test.js` |
| Cooldown key | `model-cooldowns.test.js` + integration with `connectionId !== providerId` |
| Breaker settlement | `circuit-breaker.test.js` + `breaker-integration.test.js` |
| Write coalescing | a counted fake writer; restart persistence |
| Docker | `docker.yml` starts the image and probes `/health` |
| Docs/version | `check-version.mjs` SPEC status; MCP version from build-info |
| Cline/ClinePass | new independence test + updated card/oauth/route guards |
| Codex catalog | fixture with mixed `minimal_client_version` |
| Generic metadata | fixture per provider shape |
| 100milionseek | registry/card/caps/package/logo fixtures |
| Token saver | order, reversibility, fail-open, telemetry, analyze route |
| Logs | stream + history merge + no prompt fields |
| Dialogs | focus trap, scroll lock, escape/backdrop, exit animation |
| Settings buttons | Playwright sweep, no dead control |
| Backup | dry-run, last-store failure rollback, all credential shapes |
| Speed | benchmark report, not a CI assertion |

## Open decisions for the user

1. **ClinePass OAuth independence.** Separate token per card (risk: WorkOS refresh rotation
   invalidates one) or linked OAuth credential with API key for independence (recommended).
2. **Web groups.** Hide the two section headings and keep the cards under filters (recommended), or
   remove the providers from the catalog entirely.
3. **Form presentation.** Large dialog/drawer over the page (recommended), or full-page forms. The
   comment “inside the page windows, not the full page” can mean either; T6.1 supports both, but the
   default must be chosen.
4. **Settings editability.** Keep environment settings read-only and provide copyable config
   (recommended), or add a persisted gateway settings file that can override environment values.
5. **Logs retention.** Use the existing 1,000-record usage store + live stream (recommended), or add
   a dedicated, longer-lived log store.
6. **Token Saver analysis input.** Ad-hoc, non-stored text (recommended), or sampled real requests
   stored for replay (privacy risk; not recommended).
7. **100milionseek id/slug.** `100milionseek` with slug `hms` (proposed), or a different public name.
8. **Live verification credentials.** Codex, MiniMax, Aion, Cline, ClinePass and 100milionseek need
   real accounts/keys. The plan cannot mark those green from fixtures.

## Non-goals

- No cloud-hosted gateway, multi-tenant hosting or remote credential storage.
- No transparent proxy mode that bypasses routing/failover.
- No prompt content in `usage.json`, logs or backups beyond what the encrypted backup already
  carries.
- No invented saving or cost numbers on the Token Saver page.
- No removal of the security model (loopback binding, encrypted vault, no browser credentials) to
  make a connection feel faster.

---

## Appendix A — Frontend inventory (condensed)

From the frontend review:

- **Dialogs needing the primitive:** `AddProviderModal`, `ConnectionMethodDialog`,
  `OauthConnectDialog`, `WebCookieConnectDialog`, `KiroConnectDialog`, `ApiKeysPage` modal,
  `ModelsPage` dialog, `UpdateIndicator` prompt.
- **Only `AddProviderModal` locks scroll; only `ModelsPage` traps focus.** Fix both centrally.
- **Fake traffic lights** in four dialogs: one works, all three close. Replace with one close
  control.
- **`window.confirm`** in five places; replace with `ConfirmDialog`.
- **Navigation where a dialog is expected:** `ProvidersPage.openAdd()` for OAuth/web cards,
  Settings backup link, `window.location.reload()` after import.
- **Bare loaders:** Token Saver, Usage charts, Models grid, Settings startup, Logs, Routing,
  Provider detail.
- **Layout-shift causes:** Usage charts after data, Settings 18 rows after load, Token Saver tables,
  Models grid, notices without reserved height.
- **Three outcome channels:** toast, page banner, inline alert. Standardize.
- **Two hover lifts** and a hand-rolled switch in Models; one primitive each.
- **Logs/Usage share an icon**; page titles/nav labels differ.

## Appendix B — Deep-look findings map

| ID | Finding | Phase |
| --- | --- | --- |
| D1 | Virtual model override dropped on stream and hedge | 1 |
| D2 | Stream does not fail over on limiter refusal, skips breaker/cooldown/sticky | 1 |
| D3 | Cooldown cleared by provider id, recorded by connection id | 1 |
| D4 | Half-open breaker can latch forever | 1 |
| D5 | Full vault + usage rewrite and fsync per request | 2 |
| D6 | Docker binds loopback, EXPOSE 8787; port mapping unreachable | 2 |
| D7 | Docs/version drift (401/5xx, SPEC status, architecture, card comment) | 1–2 |
| D8 | MCP version, raw ISO `lastUsed`, disabled virtual 502, stale comments | 1 |

## Appendix C — Feedback map

| ID | Feedback | Phase |
| --- | --- | --- |
| U1 | Cline/ClinePass separate + API key/OAuth | 3 |
| U2 | Codex/all providers latest models | 4 |
| U3 | Hide Web Cookie/V2 Web groups | 6 |
| U4 | MiniMax auth | 3 |
| U5 | Aion Labs check | 3 |
| U6 | Advanced Settings, every button works | 6 |
| U7 | Logs page | 5 |
| U8 | Token Saver audit + analysis page | 5 |
| U9 | Forms inside page windows | 6 |
| U10 | Frontend improvement | 6 |
| U11 | Animations + skeletons | 6 |
| U12 | Connection speed like direct | 7 |
| U13 | 100milionseek + logo | 3 |
| U14 | Backup verification + UI | 7 |
