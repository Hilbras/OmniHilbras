# OmniHilbras vs 9router — full comparison (2026-11-20)

**Scope:** every dimension requested except raw provider count. Both trees were read at their current commits:
OmniHilbras `490214431f2d6341551ad5c5b58627987645be41` (v3.87.1), 9router `1855aa44473e88feac9d3f131b9c0c5fc9706b68` (v0.5.119).
Four independent investigations were run (two full architecture reads, one Nous trace per tree), then the load-bearing claims were re-verified directly against source and the user's real usage record. No files in either project were modified by the investigation.

Sources used first: [`AGENTS.md`](../../AGENTS.md), [`README.md`](../../README.md), [`docs/SPEC-SDK.md`](../SPEC-SDK.md), [`docs/architecture/README.md`](../architecture/README.md), 9router `CLAUDE.md`, `README.md`, `docs/ARCHITECTURE.md`. Prior narrower audit: [`audit-9router-borrowing.md`](../architecture/audit-9router-borrowing.md).

---

## 1. Verdict at a glance

| Dimension | OmniHilbras | 9router | Edge |
| --- | --- | --- | --- |
| Runtime shape | Dedicated Node HTTP gateway (`Kernel/API`), Vite/React SPA, TS strict | Next.js 16 standalone wrapped by a custom HTTP server, JS ESM | Different by design; OH gateway is smaller and independently deployable |
| Routing core | Provider-neutral `routing.ts` + executor + breaker, measured fast dispatch | `open-sse` engine: translators, executors, combos, account fallback | **9router** for routing *breadth* (combos/fusion); **OH** for correctness guards |
| Protocol surfaces | OpenAI chat, Anthropic Messages (incl. Anthropic SSE), Responses, embeddings, images | OpenAI chat, Messages, Responses, embeddings, images, audio, video, search, fetch | **9router** breadth; **OH** depth on the agent surfaces |
| Credentials | Encrypted at rest (AES-256-GCM, scrypt, 0600 key), one `storedCredential()` shape | Plaintext JSON in SQLite `data` column, filesystem permissions only | **OH**, decisively |
| Auth | Gateway keys + per-launch dashboard token; no tenants | Shared password + bcrypt + JWT + OIDC/SAML, scoped API keys, login lockout | **9router** for SSO/lockout; neither has real tenants |
| Tool calling | One asserted caps table, forced-choice contract, local read-only tools | Tool repair/dedupe, Claude cloaking, MCP bridge, but no single asserted caps contract | Split: **OH** contract, **9router** breadth |
| Provider integration | One private SDK package each, vendored `lib/`, `ProviderResolver` | Declarative registry entries + `BaseExecutor`, live model fetchers | **9router** extensibility ergonomics; **OH** isolation/drift guard |
| Dashboard | 11 pages, 20-row paged logs with detection, lazy charts | More pages: combo builder, Monaco, flow graphs, MITM, tunnels, CLI tools | **9router** breadth; **OH** honesty/performance assertions |
| Launch surfaces | npm CLI starts both servers, Electron desktop, Android WebView | npm CLI, tray, autostart, self-update; no desktop/mobile shell | **OH** on shells; **9router** on tray/update maturity |
| Observability | 11 error codes, request-id on every record, attempt ledger, two SSE channels | Structured upstream errors, request-detail capture, console log stream | Roughly even; **OH** has type-level "no prompt content" guarantee |
| Tests/CI | `pnpm verify` = 8 ordered gates, CI runs the same command; e2e green | 456 Vitest files, ~64 known failures by policy, no CI workflow running tests | **OH**, decisively |
| Release discipline | Version bump → tag → release → npm → poll registry → `release:audit` | Two divergent manifests (root 0.5.116 vs CLI 0.5.119 vs CHANGELOG 0.5.119) | **OH** |
| Security assertions | Secret scan, browser-storage allowlist, symlink containment, bounded KDF | SSRF guard, peer-token IP trust, bcrypt/JWT; no scanner assertions | Split: **OH** guard layer, **9router** network trust plumbing |
| Performance | Measured 6.3% gateway CPU reduction, 37→61 fps UI fix, bundle budget | 4 s keep-alive cap, fresh-socket replay, 360 s stall timeout; no bundle budget | Split |

Neither project is a superset. OmniHilbras is the stronger *gateway* (credential safety, failover correctness, assertion discipline, release gate); 9router is the stronger *product shell* (combos, dashboard breadth, provider-quirk knowledge, SSO, network tooling).

---

## 2. Architecture and runtime

**OmniHilbras.** pnpm workspace, strict TypeScript. Build order is dependency order: `Kernel/SDK/* → TokenSaver → Tools → API → frontend → CLI` (`package.json:26-33`). The gateway is a plain Node `http` service with no web framework; composition root and ordered route dispatcher are in `Kernel/API/src/server.ts:165-326`, `:86-126`. Every request gets a 32-hex request id before any handler (`server.ts:177-188`). Guard order: loopback `Host` → 421, exact CORS origin → 403, cross-site check with exact OAuth-callback carve-out → 403, dashboard auth via allowlisted origin **and** per-launch token → 403 (`server.ts:189-219`). A measured fast path sends public LLM routes straight to the inference handler without skipping auth (`server.ts:450-458`). Ports 20138 (gateway) / 20137 (dashboard) in dev; packaged surfaces use 20128/20127 with free-port fallback.

**9router.** Next.js 16 App Router in JavaScript ESM, `output: standalone` (`next.config.mjs:15`), wrapped by `custom-server.js` which monkey-patches `http.createServer` to sanitize forwarded-for headers, downgrade h2c, and start the token-refresh scheduler (`custom-server.js:9-14, 52-126, 128-138`). Four code trees: `src/` (Next app + `src/sse/` glue), `open-sse/` (routing engine), `cli/` (published launcher), `tests/` (independent Vitest package). Engine is documented as standalone (`CLAUDE.md:65`) but in practice imports `@/lib/usageDb.js` and `@/shared/*` (`open-sse/handlers/chatCore.js:15`).

**Notable:** 9router rewrites `/v1/* → /api/v1/*` and even repairs `/v1/v1/*` (`next.config.mjs:73-112`), so its middleware authorizes pre-rewrite paths; OH keeps one literal path per route, asserted by `tests/gateway-routes.test.js`.

---

## 3. Request flow, routing and failover

**OH path:** `server.ts` → `routes/inference.ts` (`parseChatRequest`, strict validation at `inference.ts:1165-1395`) → `service.ts:chatWithFailover` → `routing-engine.ts:planRoute` → `request-executor.ts` (breaker, limiter, deadline, ledger) → adapter. Routing filters enabled + credential candidates, sorts by quota tier/priority/name, applies round-robin and `fastest`, skips unhealthy/cooling/rate-limited with named reasons (`core/routing.ts:669-801`). Breaker is per connection, three-state, with `recordAbandoned` so a limiter refusal cannot strand the half-open probe (`core/circuit-breaker.ts:8-29, 134-156`). Retry decisions come from one `RetryPolicy` (`core/retry-policy.ts:90-160`); `INVALID_RESPONSE` is retryable *because it is about the answer, not the request* (`core/routing.ts:501-523`); a client disconnect is `cancelled`, never success.

**9router path:** `src/sse/handlers/chat.js:37-390` strips Claude Code's `[1m]` marker, enforces key/access, then runs combos (`fallback | round-robin | smart | fusion` with judge model) at `:112-165`. `getProviderCredentials` serializes selection through a mutex and fills first or sticks round-robin (`src/sse/services/auth.js:28-235`). `open-sse/handlers/chatCore.js:64-539` detects format, picks native passthrough vs translation, dedupes tools, runs five token savers, dispatches through `BaseExecutor`, refreshes 401/403 up to three times, and classifies non-2xx via `parseUpstreamError`. Account fallback uses text+status rules with exponential backoff and **per-model** locks (`open-sse/services/accountFallback.js:9-75`); unmatched 4xx is request-scoped and does not cool the account (`:59-71`).

**The durable difference:** OH's failover is narrower but asserted — terminal codes (`INVALID_REQUEST`, `AUTHENTICATION_FAILED`, `NOT_SUPPORTED`, `NOT_FOUND`) stop the walk, ledger entries carry the reason and end up in the usage record. 9router's combo engine can fuse and judge across models, which OH has no equivalent for; that is the single largest feature gap in the comparison.

---

## 4. Streaming, protocols and tool calling

**OH:** failover is decided before the first byte, so a stream that cannot start is a normal JSON error (`inference.ts:908-918`). `[DONE]` is written only after a clean loop; a mid-stream provider death emits `event: error` with no sentinel (`inference.ts:941-996`). The same normalized stream is reframed for `/v1/messages` (Anthropic SSE: `message_start`, indexed content blocks, `message_delta`, `message_stop`) and `/v1/responses`. Two additional SSE channels: `/v1/logs/stream` (finished records only) and `/v1/events` (`{type:"state"}` only) with drop-on-backpressure. Tool support comes from `Kernel/Tools/src/caps.ts:26-143`: one row says whether a provider serves tools and whether forcing is possible, and a forced call a provider cannot honour is a stated `501`. Gateway tools are declared centrally with `bash` removed (`gatewayTools.ts:3-51`); local tools run under realpath containment with 64 KiB/200-entry/4-turn caps.

**9router:** SSE transforms selected per source/target format (`chatCore/streamingHandler.js:27-46`), non-SSE upstream bodies blocked and sanitized (`:60-85`), disconnect and stall detection with a 360 s inter-chunk timeout (`utils/stream.js:593,611`). Tool call ids are generated/repaired pre-translation (`translator/concerns/toolCall.js:9-27, 123-163`); Claude OAuth clients get tool-name cloaking with decoys and a restore map (`utils/claudeCloaking.js`); TTS models lose tool messages; MCP is a stdio→SSE bridge. There is no single asserted capability table — tool support is inferred from translator/executor quirks and per-model capability patterns (`open-sse/providers/capabilities.js:839`).

---

## 5. Provider integration model (no counts)

**OH:** each provider is a private package with `adapter/index.ts` and vendored `types/transport/streaming/errors/url` in `lib/`; deleting one package leaves the rest buildable (`docs/architecture/README.md:188-196`). `ProviderRegistry` validates declared capabilities against implementations (`core/registry.ts:4-22`); `ProviderResolver` contains no provider id in its algorithm and resolves on-demand → registered → generic OpenAI-compatible fallback (`core/provider-resolver.ts:112-123, 267-306`). Model ids are `<fixed slug>/<model>` from `provider-slugs.ts`, with legacy slugs still resolving and prefix uniqueness asserted; only the *provider's own* prefix is stripped and real slashes in model names are preserved (`core/routing.ts:533-564`). Residual provider surface is concentrated in `service.ts:716-771` and `routes/oauth.ts` (904 lines), honestly recorded in the architecture doc.

**9router:** declarative `open-sse/providers/registry/<id>.js` entries generate runtime config at import time; wire behaviour lives in `open-sse/executors/`, with `BaseExecutor` providing URL/headers/retry/refresh/error parsing (`executors/base.js:11-204`). Binary upstreams (Kiro EventStream, Cursor protobuf) stay in their own executors. `getModelUpstreamId` looks up a seed entry and returns `upstreamModelId || id`, or the input unchanged (`config/providerModels.js:95-133`) — so live/rotating ids need no registry edit. Capability lookup keys on the **full** namespaced id before the stripped fallback (`capabilities.js:839-883`). Adding a provider means a registry file, a model list, a regenerated index, and an executor only for non-OpenAI wires (`CLAUDE.md:72-75`).

**Trade-off:** 9router's knowledge is more extensive and easier to add; OH's isolation means a provider bug cannot reach Core, and `vendored-lib-drift.test.js` catches a fix applied to only one copy. Neither substitutes for the other.

---

## 6. Credentials, auth and security

**OH:** `api-key` / `oauth` / `none` credentials; one `storedCredential()` decides the shape for writer and reader, asserted by a restart round-trip test (`core/connections.ts:1697-1760`). AES-256-GCM per write with scrypt-derived key, random salt/IV, AAD and atomic rename (`:1337-1355`); master key is env-supplied or generated 0600 (`:1370-1391`). Gateway keys are `ohk_` + 32 random bytes, SHA-256 hashed, constant-time compared, with per-key rpm/expiry at the gate. Dashboard token is per-launch and never held by the browser; the shipped CLI proxy injects it only for `sec-fetch-site: same-origin` (`cli/server-src/static.mjs:137-155`). Guards: `tests/no-secrets.test.js` scans 15 credential shapes in tracked files; `tests/browser-storage.test.js` allows exactly two non-secret storage keys and asserts sessionStorage/cookies/IndexedDB/Cache at zero; symlink containment and bounded backup KDF. Accepted limitations are recorded in `SECURITY.md:148-175` (DNS rebinding window, Origin-derived trust, OAuth callback carve-outs, OpenCode tool scope, unsigned installers).

**9router:** one shared dashboard password (default `123456`) bcrypted in settings, 24 h HS256 JWT in `httpOnly`/`SameSite=Lax` cookies, per-IP login lockout, OIDC + SAML SSO, HMAC-keyed API keys with model allow-lists (`src/lib/auth/*`, `src/shared/utils/apiKey.js:3-39`). Peer-token IP trust and local-only routes are enforced in `dashboardGuard.js:22-288`, but only when the custom server entry point is used; a bare `next start` was a real GHSA (`CHANGELOG.md:602-610`). Provider secrets are **plaintext in SQLite** (`src/lib/db/index.js:79`, `CLAUDE.md:89`). SSRF guard exists but is applied per call site with a history of bypass fixes (`src/shared/utils/ssrfGuard.js`, `CHANGELOG.md:404,385,364`). MITM with DNS rewriting is opt-in and encrypts only the sudo password.

**Verdict:** OH is safer by default at rest and in the browser; 9router has richer sign-in (SSO, lockout) and network-level trust plumbing but stores long-lived provider credentials in cleartext.

---

## 7. Persistence and observability

**OH:** everything file-backed under `$XDG_CONFIG_HOME/omnihilbras`; usage records have no field that can hold a prompt, response, header or credential — a type-level property asserted by scanning record keys (`core/usage-store.ts:16-31, 63-109`). SQLite is an opt-in durability backend, not an analytics engine (`usage-store-sqlite.ts:33-37`). Backups exclude the master key and dashboard token and validate everything before writing. Every usage record carries the request id and an ordered attempt path, so failover is auditable; `/metrics`, `/v1/routing`, `/v1/logs/stream`, `/v1/events`, `/health` are the operational surfaces.

**9router:** SQLite with a four-driver chain (`bun:sqlite → better-sqlite3 → node:sqlite → sql.js`) at `<DATA_DIR>/db/data.sqlite` with WAL and migrations (`src/lib/db/driver.js:8-105`, `schema.js`). Request-detail capture stores payloads with configurable retention and a 5 MB cap (`requestDetailsRepo.js:20-42`); observability is on by default. The docs still describe the superseded `db.json` layout and cloud-sync routes that do not exist in the checkout — a documented drift (`CLAUDE.md:76-80`, `docs/ARCHITECTURE.md:136-149`).

---

## 8. Dashboard, CLI and shells

**OH dashboard:** one React Router app at `/dashboard` with Servers, Providers, Detail+Usage, Models, Routing, Keys, Usage, Logs, Settings, Token Saver, About. Logs are the page the user asked to upgrade: 24 h history + live SSE, 500-event cap, 20-row numbered paging, filters for outcome/provider/error/time/retries, search covering the attempt ledger, pause/buffer, JSON export, and a detection summary computed over the filtered rows (`src/pages/LogsPage.tsx:5-63, 121-179, 252-260`). Charts are lazy because recharts pulls redux/immer/victory-vendor. Provider cards may only show measured values, asserted by a merge test.

**9router dashboard:** App Router pages including combo builder with drag-and-drop (`@dnd-kit`), Monaco editors, flow graphs (`@xyflow/react`), quota, CLI-tool configurators, proxy pools, PXPIPE, MITM controls, tunnels, console log stream, skill marketplace. More surface, but no equivalent assertion layer for card honesty, storage secrets, or bundle cost.

**Shells:** OH's published `@hilbras/omnihilbras` starts gateway + dashboard with verbs dispatched before launcher work, TCP-connect readiness, inline spinner, process-group ownership verified by command line before signalling, foreign port holders refused rather than killed (`bin/omnihilbras.js:12-31`). Electron desktop owns a bounded supervisor and crosses a narrow preload bridge; Android is a Capacitor WebView with a Keystore-backed secure store. 9router's CLI has tray, autostart and npm self-update with a detached process, but its fallback kills whatever holds the app port (`cli/cli.js:440-461`, `lsof -ti | kill -9`); no desktop or mobile shell.

---

## 9. Tests, CI, release and deployment

**OH:** `pnpm verify` chains version → brand → typecheck → tests → SPEC success criteria → build → CLI smoke → bundle budget, and CI runs exactly that (`.github/workflows/verify.yml`). Playwright e2e, desktop (now green on all three OS lanes after the 3.87.x fixes), Docker, daily release audit. Release ceremony requires polling `npm view` because npm's success line is not registry presence; `release:audit` records unrecoverable gaps and fails on a new one.

**9router:** 456 Vitest files with regression snapshots and a documented known-fail baseline (~64 failures); the root manifest has no `test` script and no CI workflow runs the suite. Three workflows exist (Docker publish, GitBook pages, tray binaries); Dependabot is empty. Root/CLI/CHANGELOG versions currently diverge, which the Docker tag preflight would reject (`.github/workflows/docker-publish.yml:70-85`).

**Deployment:** both have Docker; 9router additionally has CapRover config and a documented MITM/tunnel stack. OH's site is a separate Vercel deploy outside the release ceremony.

---

## 10. Performance

OH has measured numbers: 6.3% gateway CPU reduction per 400-request batch from an alternating same-runtime A/B (`docs/reports/concurrency-benchmark-2026-11-20.md`), 37/39 → 61/62 fps by removing blur under sticky surfaces, 8/8 navigations preserving the page DOM node after removing a path key. 9router tunes connection reuse centrally (4 s keep-alive cap, fresh-socket replay, 360 s inter-chunk stall) after measured 502 incidents, and defers heavy startup 3 s; it has no bundle budget or performance regression tests. For very long reasoning turns, 9router's 360 s inter-chunk allowance is more generous than OH's defaults (`config.ts` 120 s / 360 s / 1800 s across request stages).

---

## 11. Nous Research: why the error appears

### 11.1 What the real record says

`/home/gin/.config/omnihilbras/usage.json` has 8 Nous records:

| Model as recorded | Outcome | Error | Attempts | Latency |
| --- | --- | --- | --- | --- |
| `ns/qwen/qwen4-max:free` (×5) | failure | `INVALID_RESPONSE` | 2 | 4.1 s, 5.1 s, 31.0 s, 5.4 s, 46.8 s |
| `qwen/qwen4-max:free` (×2) | success | — | 1 | 3.2 s, 4.0 s |
| `tencent/hy4-flash:free` (×1) | success | — | 1 | 5.1 s |

Caveat: on failure the route records the *requested* model (with `ns/`), on success the provider-echoed model (bare). So the prefix is a clue, not proof — but **prefix stripping was verified correct**: `splitProviderPrefix('ns/qwen/qwen4-max:free', [nous])` returns `qwen/qwen4-max:free`, with no double strip. The connection has `modelPolicy: all`, 376 imported ids, `maxRetries: 1`, `timeoutMs: 120000`, and a cooldown on `nous:qwen/qwen4-max:free` set after the failure.

### 11.2 Ranked causes

1. **Reasoning-only streams are rejected as invalid (most likely).** `Kernel/SDK/nous/lib/openai-compatible.ts:293, 309-310` requires payload + `[DONE]` + a "meaningful" delta, where meaningful means role/content/tool_calls/finish_reason/usage — `reasoning_content` is **not** counted, and the chunk's `reasoning` is dropped entirely (`lib/openai-compatible.ts:309-310`, chunk construction below it). A reasoning model that streams a long thinking phase and then ends (agent tool round, cancellation, or empty content) therefore throws `INVALID_RESPONSE`: "The provider stream ended before completion." `core/request-executor.ts:785-788` adds a second `INVALID_RESPONSE` if no first chunk arrives in time. The 31 s / 47 s latencies fit a slow reasoning turn plus one retry. Every observed failure carries exactly this code.

2. **Nous attribution tags are missing.** 9router injects `product=9router`, `client=9router`, `user=9router` into `body.tags` only for the exact Nous chat URL (`open-sse/executors/default.js:118-139`); its tests show the upstream returns **400 "missing user tag"** without them (`tests/unit/nous-attribution.test.js`, fix at `CHANGELOG.md:175`). Our Nous adapter sends no `tags` field at all (`lib/openai-compatible.ts:355-369`). That would surface as `PROVIDER_REQUEST_FAILED` rather than `INVALID_RESPONSE`, so it is a distinct real gap rather than the cause of these five records — but it will bite the same agent traffic.

3. **Wrong reasoning wire shape.** 9router sends Nous reasoning as nested `reasoning: {enabled:true, effort}` because Nous does not advertise top-level `reasoning_effort` for all models (`open-sse/translator/concerns/thinkingUnified.js:403-414`). Our adapter sends top-level `reasoning_effort` (`lib/openai-compatible.ts:368`). A reasoning model asked for a thinking level may ignore it or refuse the request shape.

4. **Cooldown makes later attempts fail fast.** After the first failures, `nous:qwen/qwen4-max:free` was stood down (`core/routing.ts:778-781`); without another serving connection the answer becomes "No enabled provider connection can serve this model" (`core/routing.ts:812`), which reads as a Nous outage even when the original cause was one malformed turn.

5. **Catalog drift on rotating free ids.** `modelPolicy: all` imported 376 ids, including `:batch` and `:free` variants; there is no catalog gate on chat requests, so a retired upstream id is accepted locally and 404s upstream as `PROVIDER_REQUEST_FAILED` (`core/transport.ts:458-499`). 9router has the same exposure but preserves `upstreamModelId` and uses full-id capability lookup; notably **9router's pinned validation model `poolside/laguna-xs-2.1:free` is stale (404)** while OH replaced that probe with a catalog-derived one (`Kernel/SDK/nous/adapter/index.ts:56-69, 530-554`) — OH is ahead here.

### 11.3 What 9router does differently, across the whole path

- Splits on the **first slash only** (`open-sse/services/model.js:34-55`): `nous/meituan/longcat-2.0:free → {provider:"nous", model:"meituan/longcat-2.0:free"}`; vendor namespace and `:free` stay in the id. A gateway stripping every slash would send `longcat-2.0:free` and 404.
- Resolves the upstream id through `getModelUpstreamId` (seed id or unchanged input) and preserves it as `upstreamModelId` in the catalog (`config/providerModels.js:95-133`, `src/app/api/providers/[id]/models/route.js:83-90`).
- Keys capabilities on the full namespaced id before the stripped fallback, preserving Nous `thinkingFormat` and measured context windows (`capabilities.js:430-440, 839-883`).
- Stores the device-flow-minted **agent key** as `apiKey` and sends it as Bearer (`src/lib/oauth/providers/nous.js:96-107`); refreshes re-mint it (`tokenRefresh/providers.js:770-853`).
- Injects attribution tags (above), uses nested reasoning (above), validates credentials with a **1-token authenticated chat probe**, never the public `/models` endpoint (`src/app/api/providers/validate/route.js:333-344`).
- Classifies unmatched 400/404 as request-scoped, so a dead model id is reported rather than cooling the account (`accountFallback.js:59-71`).

### 11.4 Fixes applied after the investigation

All five items below were implemented in `Kernel/SDK/nous/adapter/index.ts` (provider-specific code stays in the adapter; the shared vendored `openai-compatible.ts` keeps its byte identity across providers) and asserted by seven new cases in `Kernel/SDK/tests/nous.test.js` (27/27 Nous tests green):

1. `reasoning_content` / nested `reasoning` deltas are meaningful and are forwarded in `delta.reasoning`, which the gateway already relays as `reasoning_content` on the chat SSE surface.
2. Attribution tags are injected into every Nous inference body — chat, stream and the 1-token credential probe — keyed on the resolved Nous chat URL, mirroring 9router's exact-host guard.
3. Requested reasoning effort is rewritten to Nous's nested `reasoning: { enabled, effort }`; the generic top-level field never reaches Nous.
4. A reasoning-only stream now yields the reasoning plus one explicit empty text chunk with `finishReason: stop` instead of throwing `INVALID_RESPONSE`. A stream with no payload or no `[DONE]` is still invalid. (The cooldown itself was left alone: the stand-down was a correct consequence of the repeated invalid responses, which no longer occur.)
5. The new tests replay reasoning-only and mixed reasoning+text SSE frames, plus the wire-body and probe assertions.

---

## 12. What to borrow, and what not to

**Borrow from 9router:** combos (especially `smart` and `fusion`), the full-id capability lookup pattern, Nous attribution/nested-reasoning quirks, attribution-as-conditional-on-resolved-URL, 360 s inter-chunk stall tolerance, credential validation via a one-token chat probe, and the breadth of tool/MCP handling.

**Do not borrow:** plaintext credential storage, a test suite that is red by policy, version drift between manifests, killing foreign port holders, IP trust that depends on which server entry point was used, and the MITM/tunnel stack unless there is a clear local-first need and a security review.

**Keep in OH:** encrypted vault and one credential-shape decision, asserted capability contract, terminal-vs-retryable failover with an auditable ledger, no prompt content in the usage store, guard-as-test discipline, `pnpm verify` as a single green gate, and the release audit.
