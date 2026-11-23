# 9router parity, cycle 1 — whole-system comparison

**Step 1 of `tasks/parity-loop/README.md`.** Both trees were read at their current commits, not at the
commits used by the previous comparison:

| Tree | Commit read | Version | Working tree |
| --- | --- | --- | --- |
| OmniHilbras (OH) | `632eb79a62e4302d05427826275a334b357bc887` (2026-11-23 04:19:31 +0300) | `3.95.0` (`package.json:4`, `Kernel/API/package.json:3`, `cli/package.json:3`) | only untracked `.zcode/` |
| 9router (9R) | `1855aa44473e88feac9d3f131b9c0c5fc9706b68` (2026-11-12 18:50:35 +0700) | root `0.5.116`, CLI `0.5.119`, CHANGELOG `0.5.119` | untracked `pnpm-lock.yaml`, `pnpm-workspace.yaml` |

Commands that established the commits and versions (run in this ask):

```
cd /mnt/sda3/work/Hilbras/OmniHilbras && git log -1 --format='%H %ad %s' --date=iso && git status --short && grep -n '"version"' package.json Kernel/API/package.json cli/package.json
cd /mnt/sda3/work/projects.old/9router && git log -1 --format='%H %ad %s' --date=iso && git status --short && grep -n '"version"' package.json cli/package.json && grep -n '^# v' CHANGELOG.md | head -3
```

OH has advanced 22 commits since the previous comparison (`git log --oneline 49021443..HEAD | wc -l` → `22`),
including tool-contract refusal, Codex/AgentRouter tool lanes, upstream model-id preservation, 4xx
scoping, model catalog facts and the parity scorecard itself. 9router is at the same commit as in that
comparison. So this report re-measures, rather than repeating, the 2026-11-20 conclusions.

**Checks actually run here** (nothing else is claimed as passed):

```
node scripts/check-version.mjs                       -> "version check passed: 3.95.0", exit 0
node --test tests/no-secrets.test.js tests/browser-storage.test.js tests/gateway-routes.test.js tests/release-trail.test.js
                                                     -> 24 tests, 24 pass, 0 fail
node --test tests/9router-catalog.test.js            -> 4 tests, 0 pass, 0 fail, 4 SKIP
```

`pnpm verify`, the full unit suite, Playwright and `pnpm app:smoke` were **not run** (the ask forbids
`verify`, and no live provider key is available). Counts of files, registry entries and provider ids
come from the commands quoted at the point of use. Internet calls were limited to four pages that the
two trees cannot supply (protocol/spec/registry facts); each is cited in §13.

---

## 1. Verdict

Neither tree is a superset of the other, and the loop's stop condition is not met.

- OH is decisively ahead on **credential storage, browser secret hygiene, tool-contract honesty,
  failure-ledger auditability, a single green CI gate, and release discipline**. Twenty-two further
  commits closed several of the gaps the previous report named: combos now exist as virtual models,
  upstream model ids are preserved and sent, the Responses lane exists on AgentRouter, 360 s stream
  idle tolerance is configured, provider validation strategies are declared, and a forced tool call a
  provider cannot honour is a stated refusal rather than a silent prose answer.
- 9router remains ahead on **declared provider breadth (149 registry entries vs 58 OH cards),
  smart/fusion combo routing, special-provider knowledge and OAuth breadth, Responses stream event
  completeness, media/fetch protocols, MCP client-plugin bridging, Claude tool cloaking, and the
  operator dashboard's configurators**.
- Both trees are **unmeasured on live requests**: no live key was available in this ask. Every
  "works" below means implemented and covered by scripted/local tests, never a live vendor turn.

### Cycle-1 scorecard measurement (evidence below)

Scale from `docs/reports/9router-parity-scorecard.md:24-25`: 0 absent, 1 declared but broken,
2 common case, 3 with guards, 4 measured across providers with regression tests, 5 better than reference.

| # | Criterion | 9R | OH | OH ≥ 9R? | Where the evidence is |
| --- | --- | --- | --- | --- | --- |
| 1 | Working provider coverage on live requests | 3 | 3 | = | §7; 149 vs 58 declared, no live calls either side |
| 2 | Credential validation | 3 | 4 | yes | §8; OH declares strategy per registration |
| 3 | Model-ID / upstream-ID / capability mapping | 4 | 4 | = | §6; both full-id then stripped, both keep upstream ids |
| 4 | Tool calling breadth and reliability | 4 | 4 | = | §5; 9R cloaking/MCP, OH asserted refusal/loops |
| 5 | Failover and multi-account rotation | 4 | 3 | **no** | §3; `smart`/`fusion` missing in OH |
| 6 | Streaming / protocol surfaces | 4 | 3 | **no** | §5; video/fetch and Responses events missing |
| 7 | Web-session / free-tier / special providers | 4 | 3 | **no** | §7; 9R has 21 OAuth + more special executors |
| 8 | Observability | 3 | 4 | yes | §9; no prompt/header field in OH usage records |
| 9 | Dashboard and operator surfaces | 4 | 3 | **no** | §10; CLI-tool/translator/MITM config pages |
| 10 | Security at rest and in browser | 2 | 4 | yes | §8; 9R plaintext provider credential column |
| 11 | Test/CI gate that runs and fails | 2 | 5 | yes | §11; 24 OH guards passed here |
| 12 | Release discipline and audit trail | 2 | 5 | yes | §12; OH version check and audit passed here |

Rows 5, 6, 7 and 9 are behind and keep the loop running.

---

## 2. Architecture

**OH.** Plain Node `http` service, no web framework. Every request gets a 32-hex request id before
any handler (`Kernel/API/src/server.ts:177-188`); guard order is loopback `Host` → 421, exact CORS
origin → 403, cross-site check with exact OAuth-callback carve-out → 403, then an auth context decided
once from allowlisted origin **and** per-launch token (`server.ts:189-219`). Build order is SDK →
TokenSaver → Tools → API → frontend → CLI (`package.json:24-33`). The gateway is independently
deployable; the published CLI bundles it and starts it (`package.json:44,62`).

**9R.** Next.js 16 standalone with a custom server that monkey-patches `http.createServer`
(`custom-server.js:6-14`) to stamp a peer token and sanitise forwarded headers, and starts background
token refresh (`custom-server.js:17-30`). `/v1/*` is rewritten to `/api/v1/*`, including repair of
`/v1/v1/*` (`next.config.mjs:73-112`), so middleware authorises pre-rewrite paths. The engine claims
to be standalone but imports app modules (`open-sse/handlers/chatCore.js:15`, prior report).

**Difference that matters:** OH's guard set is in one place and asserted; 9R's network-trust guard
depends on which server entry point was used — a bare `next start` was a real GHSA
(`CHANGELOG.md:602-610` in the prior comparison). OH has no equivalent of 9R's standalone engine
package; a provider vendor that wants to embed only the router cannot do so from this tree.

---

## 3. Routing and failover

**OH.** `RoutingEngine.plan()` reads health, limiter and latency as injected questions
(`Kernel/API/src/core/routing-engine.ts:24-48, 100-118`). `resolveRoute()` filters enabled +
credentialed connections, sorts by quota tier → priority → name, rotates balanced and `fastest`
candidates, pins a named account first, then skips named reasons (`unhealthy`,
`model-cooling-down`, `rate-limited`, `no-models`) at `routing.ts:669-817`. The explicit provider
pin is a fence: a pin with no usable connection is refused rather than billed elsewhere
(`routing.ts:711-724`). A per-connection health check avoids one account ejecting its siblings
(`routing.ts:755-775`). `RequestExecutor` enforces deadlines, breaker and ledger
(`request-executor.ts:175, 528, 649, 814`); hedging is its own policy (`hedge-policy.ts:24-93`).

**9R.** Combos are a first-class routing mode: `fallback | round-robin | smart | fusion`
(`src/sse/handlers/chat.js:109-165`), with session stickiness, a router model and confidence
threshold for `smart` (`open-sse/services/combo.js:344-450`), an anonymised judge panel for
`fusion` (`:714-890`), and a capacity adapter that adds models when the requested one lacks a
required capability (`chat.js:167-178`). Account rotation uses config-driven text/status rules,
exponential 429 backoff and per-model locks (`open-sse/services/accountFallback.js:9-75`);
unmatched 4xx is request-scoped and does not cool the account (`:59-71`). OH has since copied that
last rule (`9c2d9b1c`, "Scope unmatched 4xx failures and honour Retry-After on retry").

**Gap (high):** OH virtual models offer only `priority | round-robin | fastest`
(`Kernel/API/src/core/virtual-models.ts:11,97`; resolution at `service.ts:4231-4267`), so a combo
cannot ask a router model to choose by task, keep a session sticky for prompt-cache reasons, or fuse
a panel of answers through a judge. 9R does all three. The improvement item 1 in §14 closes this.

---

## 4. Provider integration, model IDs and capabilities

**OH.** One private SDK package per provider with `adapter/` and vendored `lib/` (55 directories
under `Kernel/SDK/`; `find Kernel/SDK -mindepth 1 -maxdepth 1 -type d | wc -l` → `55`). Registration
is a typed table in `Kernel/API/src/core/service.ts:737-820` carrying factory and validation
strategy; `ProviderResolver` has no provider id in its algorithm. Prefix stripping splits on the
**first** slash and only for a connected provider (`Kernel/API/src/core/routing.ts:533-552`), `bareModelFor`
removes only the dispatched provider's own prefix (`:556-568`), and `lookupModelId` normalises
dots/dashes and thinking suffixes for comparison only (`:573-579`). Catalog-declared upstream ids are
persisted as `modelMeta.u` (`connection-manager.ts:62-93`) and sent on dispatch
(`service.ts:983-997, 3903, 3942, 3955`). Per-model tool narrowing tries the full id, bare id and
normalised forms (`modelCapabilities.ts:8-28`) — the full-id-then-stripped pattern 9R uses at
`open-sse/providers/capabilities.js:839-883`. 9R's `getModelUpstreamId` additionally rewrites
thinking suffixes and tier variants (`open-sse/config/providerModels.js:95-133`), which OH's
catalog does not do.

**9R.** Declarative registry entries generate a static import index
(`open-sse/providers/registry/index.js:1-80`, auto-generated comment at `:1`); wire quirks live in
43 executors (`find open-sse/executors -maxdepth 1 -name '*.js' | wc -l` → `43`) over
`BaseExecutor` (`open-sse/executors/base.js:11-204`). Adding a provider is cheaper than OH's new
package, but the knowledge is spread across index, registry, models, capabilities, executor and
tests.

**Verdict:** parity on identity mapping after the recent OH work; 9R still ahead on the number of
provider-specific wire decisions captured.

---

## 5. Tool calling and streaming protocols

**Tool contract.** OH's single table declares `tools`, `toolChoice` and `web` for every id
(`Kernel/Tools/src/caps.ts:24-26, 113-142`). `normalizeToolsRequest` refuses a forced call without
definitions and drops/renames unsanitised definitions (`Kernel/Tools/src/normalize.ts:71-137`).
`applyToolContract` now refuses declared-but-unserved tools before any provider call instead of
letting an agent loop end as normal prose (`Kernel/API/src/core/service.ts:3775-3805`). Call IDs are
healed deterministically (`Kernel/Tools/src/toolHistory.ts:14-58`; tests
`Kernel/Tools/test/toolHistory.test.js:5-42`), matching the intent of 9R's
`open-sse/translator/concerns/toolCall.js:9-27,123-163`. `tests/tools-caps.test.js` makes rows
match what adapters actually send; `Kernel/API/test/tool-contract.test.js:137-146` pins the healed
id. Local tools are read-only `glob/grep/read` with `bash` removed
(`Kernel/Tools/src/gatewayTools.ts:3-31`).

**What OH lacks here (medium):** 9R repairs and cloaks Claude tool names with decoys and a restore
map (`open-sse/utils/claudeCloaking.js:58-118,134-169`) and bridges external MCP plugins from stdio
to SSE (`src/lib/mcp/stdioSseBridge.js:1-8`). OH's `/v1/mcp` is a gateway-introspection JSON-RPC
endpoint with three tools (`Kernel/API/src/routes/mcp.ts:31-42`) — useful, but not a client-plugin
bridge, and no cloaking code exists anywhere in OH (`rg 'cloak|decoy' Kernel/API/src Kernel/SDK/*/adapter Kernel/SDK/*/lib Kernel/Tools/src` → no matches).

**Streaming OH.** Failover is decided before the first byte; clean streams end with one
`[DONE]`, mid-stream failure emits `event: error` with no sentinel
(`Kernel/API/src/routes/inference.ts:949-1054`). Anthropic Messages reframes the same normalized
chunks with indexed blocks and tool deltas (`:553-523`), Responses emits text/tool/terminal events
(`:628-727`), and 360 s idle / 1800 s absolute stream budgets are explicit
(`Kernel/API/src/core/config.ts:25-37,152-153`) — matching 9R's `STREAM_STALL_TIMEOUT_MS` at
`open-sse/config/runtimeConfig.js:53`.

**Gap (high): Responses event completeness.** OH emits `response.output_text.delta`,
`response.output_item.added`, `response.function_call_arguments.delta/.done`,
`response.output_item.done` and `response.completed`
(`Kernel/API/src/routes/inference.ts:669-715`). 9R emits `response.created`,
`response.in_progress`, `response.reasoning_summary_part.added`,
`response.reasoning_summary_text.delta/.done`, `response.reasoning_summary_part.done`,
`response.output_text.done` and `response.failed`
(`open-sse/translator/response/openai-responses.js:81-95,190-204`,
`open-sse/transformer/responsesTransformer.js:105-141,278-292`,
`open-sse/utils/responsesStreamHelpers.js:7-45`). Official OpenAI streaming guidance lists the
wider event union (§13). A strict Responses client that waits for `response.created` or a terminal
`response.failed` will not see either from OH on error.

**Gap (medium): protocol breadth.** OH serves chat, messages, responses, embeddings, images
(`Kernel/API/src/routes/inference.ts:42-84`), audio speech/transcriptions and search
(`Kernel/API/src/routes/media.ts:13,51,85`). 9R additionally serves video generation
(`src/sse/handlers/videoGeneration.js:1-20`), web fetch (`src/sse/handlers/fetch.js:1-20`),
systemone, and TTS/STT handler families (`src/sse/handlers/`). OH has no video or fetch route.

---

## 6. Credentials, auth and security

**OH.** `api-key | oauth | none` credentials, one `storedCredential()` for writer and reader
(`Kernel/API/src/core/connections.ts:1682-1688,1752`), AES-256-GCM with scrypt, random salt/IV and
atomic write (`:1369-1393`), generated 0600 master key (`:1412`). Gateway keys are `ohk_` + random
bytes, SHA-256 stored and constant-time compared, with rpm/expiry at the gate
(`Kernel/API/src/core/api-keys.ts:99-125,499,510-514`; `api-key-manager.ts:176-183`). Provider
validation strategy is declared beside the factory — `credential`, `none` or `validateOnSave`
(`service.ts:737-820`) — so a Check button cannot silently validate against a public `/models`
endpoint. PKCE S256 is used for Codex, Claude Code, MiniMax, Qoder and Kiro
(`Kernel/SDK/codex/adapter/index.ts:170-187`, `Kernel/SDK/claude-code/adapter/index.ts:430-474`,
`Kernel/API/src/providers/codexOAuth.ts:161-179`). Guards asserted in this ask: no-secrets scans
15 shapes over 1587 tracked files with 0 exemptions; browser storage allows only two non-secret
keys and asserts sessionStorage/cookies/IndexedDB/Cache at zero.

**9R.** Provider connections are stored as a plaintext `data TEXT` JSON column
(`src/lib/db/schema.js:33-50`), and usage history has an `apiKey` column (`:120`). Dashboard auth is
bcrypt + 24 h JWT cookies (`src/lib/auth/dashboardSession.js:1-2,61-70`) with a per-IP in-memory
login limiter (`src/lib/auth/loginLimiter.js:1-51`), OIDC/SAML (`src/lib/auth/oidc.js`,
`saml.js`), and HMAC-keyed API keys with model allow-lists (`src/shared/utils/apiKey.js`). SSRF
guard exists but is applied per call site (`src/shared/utils/ssrfGuard.js` used in five places).

**Gap (medium): sign-in surface.** OH has no dashboard login, lockout, OIDC/SAML or per-key model
allow-list; `Workspaces` are metadata labels (`Kernel/API/src/core/workspaces.ts:6-28`), not
isolated tenants. This is acceptable for a loopback single-user gateway but behind 9R on a shared
host. RFC 9700 guidance is in §13.

---

## 7. Provider onboarding, web sessions and free tiers

Counted with:

```
# OH
rg -o "id: '[a-z0-9-]+'" src/data/providers.ts | sed ... | sort -u | wc -l   -> 58
# 9R
find open-sse/providers/registry -maxdepth 1 -type f -name '*.js' | wc -l     -> 149
LC_ALL=C comm -23 /tmp/9r_ids.txt /tmp/oh_ids.txt | wc -l                     -> 120
LC_ALL=C comm -12 /tmp/9r_ids.txt /tmp/oh_ids.txt | wc -l                     -> 29
```

Shared ids include `anthropic`, `chatgpt-web`, `cline`, `clinepass`, `codex`, `deepseek`,
`gemini`, `groq`, `kiro`, `nvidia`, `openai`, `openrouter`. 120 registry ids have no OH card,
including `cursor`, `claude`, `gemini-cli`, `grok-cli`, `xai`, `glm`, `perplexity`, `together`,
`fireworks`, `vertex`, `bedrock`, `synthetic`, `zed` and `windsurf`. OH has 29 ids 9R lacks,
mostly OpenAI-compatible routers plus `zcode`, `qwen-web`, `opencode-console`, `duckduckgo-web`.
Raw counts are not a claim that all 149 work; many are aliases or media/search providers.

**OH free-tier depth exceeds 9R in one area.** OpenCode Console/Zen/Go is integrated with local
service discovery, runtime install, `/proc`-based adoption of its own orphan, streamed
`session.text.delta`/`session.reasoning.delta`, a deny-first read-only tool allow list and an
explicitly documented read exposure
(`Kernel/API/src/core/opencode-runtime.ts:281-315,345-410`,
`Kernel/API/src/core/opencode-service.ts`, `docs/SPEC-SDK.md:1124-1498`). 9R has `opencode-zen`
and `opencode` executors but no equivalent install/adopt/tool-scope story.

**Web sessions.** OH descriptors carry provider-owned instructions and paste/check routes for
ChatGPT, Qwen, DeepSeek, Gemini, Grok, Perplexity, Token Harbor, ZCode and DuckDuckGo
(`src/lib/webSessionProviders.ts:9-80`, `Kernel/API/src/routes/oauth.ts:545-715`). 9R has web
executors for `chatgpt-web`, `deepseek-web`, `gemini-web`, `muse-web`, `uc-web`, `veoaifree-web`.
Neither tree can honestly claim a live web session works in this ask; the OH docs record measured
session captures for several of them.

**9R special-provider breadth.** 31 OAuth provider modules
(`find src/lib/oauth -name '*.js' | wc -l` returns more because of duplicate layer files; modules
include `cursor`, `antigravity`, `gemini-cli`, `xai`, `zed`, `windsurf`, `trae`, `iflow`) and
executors for binary/subscription wires such as `cursor.js`, `commandcode.js`, `antigravity.js`,
`mimo-free.js`, `zed.js`. OH reaches 9R's `zed`, `cursor`, `glm` families only via generic
OpenAI-compatible routing or not at all. Improvement item 4 targets a small, high-value subset
rather than all 120.

---

## 8. Observability

**OH.** Usage records have no field that can hold a prompt, response, header or credential
(`Kernel/API/src/core/usage-store.ts:9-31`); a test scans record keys so a content field fails the
suite. Every record carries a request id and an ordered attempt ledger with `dispatched`, outcome
and error code (`:33-50`). The Logs page merges 24 h history with a 500-event live stream, 20-row
paging, filters, attempt-ledger search and JSON export (`src/pages/LogsPage.tsx:5-63,121-179`).
`/metrics`, `/v1/routing`, `/v1/logs/stream`, `/v1/events` and `/health` are the operational
surfaces. Tool-contract telemetry (declared/forwarded/dropped/stripped) is now carried into the
usage record (`144b73cb`).

**9R.** SQLite request-detail capture stores payloads with a 5 KiB JSON cap and retention trim
(`src/lib/db/repos/requestDetailsRepo.js:7,122-130`), plus a console-log buffer and MITM request
views. That is genuinely more debuggable but stores content; the earlier OH decision deliberately
refuses it.

**Gap (low/medium):** OH has no redacted request-detail view, so an upstream 400 caused by a
particular tool schema or message shape can only be diagnosed from an error code. Add a separate,
bounded, redacted record — never widen `UsageRecord`.

---

## 9. Dashboard and operator surfaces

**OH.** One React Router app at `/dashboard` with Providers, Models (virtual-model combos),
Routing, Keys, Usage, Logs, Settings, Token Saver, About and provider detail/usage
(`src/dashboardApp.tsx:148-158`, `src/lib/routes.ts:6-60`). Card values may only come from measured
state (`src/lib/providerCards.ts`; `tests/provider-card-merge.test.js`), success states set in timers
fail `tests/dashboard-truthfulness.test.js`, and blur under sticky surfaces fails
`tests/ui-performance.test.js`. The page wrapper is deliberately not keyed on path.

**9R.** 16 top-level dashboard sections and 24 `page.jsx`/`page.js` files under the dashboard app,
including CLI-tool configurators for ~30 clients, combos with drag-and-drop, Monaco editors,
translator inspector, media providers, proxy pools, MITM, tunnels, PXPIPE, console log, quota and
skill marketplace (`find 'src/app/(dashboard)/dashboard' -mindepth 1 -maxdepth 1 -type d | wc -l`
→ `16`). OH has gateway API routes for tunnels, MITM, proxy pools, skills and workspaces
(`Kernel/API/src/server.ts:406`) but no dashboard pages for them.

**Gap (medium):** operator breadth — no CLI-tool configurator, translator inspector or MITM/
proxy-pool UI. Improvement item 7.

---

## 10. Tests, CI and release discipline

**OH.** `package.json:44` defines `verify` as version → brand → typecheck → test → SPEC guard →
build → CLI smoke → bundle budget, and `.github/workflows/verify.yml:20-44` runs exactly that command
with full history and tags. Playwright is a separate job (`e2e.yml`); release audit is scheduled
(`release-audit.yml`). `pnpm version:check` passed here (`3.95.0`); 24 repo-guard assertions
passed. `tests/9router-catalog.test.js` alone skips all four cases here because its registry path is
hardcoded to `/home/gin/work/9router` (`tests/9router-catalog.test.js:34-40`,
`scripts/build-9router-catalog.mjs:18-22`) — a skipped guard cannot detect that the committed
catalog says **124** registry entries (`docs/architecture/9router-provider-catalog.md:9`) while the
current 9R tree has **149**. Improvement item 10.

**9R.** 456 `*.test.js` files under `tests/`, Vitest configured in `tests/vitest.config.js:1-20`,
but the root manifest has no `test` script (`package.json:9-21`) and none of the three GitHub
workflows runs tests. `CLAUDE.md:43-45` documents ~938 pass / ~64 fail as the expected baseline, with
26 catalogued known failures and a manual comparison script `tests/__baseline__/verify-no-regression.mjs:1-21`
that is not wired into CI. Release drift is live: `package.json:3` = 0.5.116, `cli/package.json:3` =
0.5.119, `CHANGELOG.md:1` = 0.5.119, while `git tag --sort=-v:refname | head -1` → `v0.5.119`.

**OH release trail.** 175 tags; `git tag --sort=-v:refname | head -10` starts at `v3.95.0`;
`tests/release-trail.test.js:152-153` pins 22 early-era + 88 suspended-publishing exemptions;
`scripts/audit-release-trail.mjs:20-35` explains why the online audit is separate from verify.
Externally, registry and GitHub both confirm the current version (§13). **Not run here:** the
networked `pnpm release:audit`; only its offline test half ran.

---

## 11. Internet findings (not derivable from either tree)

1. **MCP transport is now Streamable HTTP.** The current MCP specification
   (`https://modelcontextprotocol.io/specification/2025-11-25/basic/transports`) says the protocol
   defines stdio and Streamable HTTP, that the latter "replaces the HTTP+SSE transport" from
   2024-11-05, that the server "MUST provide a single HTTP endpoint path … that supports both POST
   and GET methods", that invalid `Origin` "MUST" get 403, and that clients "MUST" include
   `MCP-Protocol-Version`. OH negotiates `2024-11-05` and only handles POST
   (`Kernel/API/src/routes/mcp.ts:63-124`). The 2025-06-18 page
   (`https://modelcontextprotocol.io/specification/2025-06-18/basic/transports`) says the same about
   the replacement. This makes item 6 concrete and standards-backed.
2. **OAuth security BCP.** RFC 9700 (January 2025),
   `https://datatracker.ietf.org/doc/html/rfc9700`: §2.1 requires exact redirect-URI string matching
   except for loopback ports; §2.1.1 requires PKCE for public clients with S256 and token-endpoint
   enforcement; §2.2.2 requires public-client refresh tokens to be sender-constrained or rotated.
   OH satisfies the first two for its code-flow providers (§8) but has no general refresh-token
   rotation/replay-revocation module (`Kernel/API/src/core/token-renewal.ts:9-16`), so a future
   provider that returns a long-lived refresh token is not covered by a stated policy.
3. **Responses streaming event names.** OpenAI's "Streaming API responses" guide
   (`https://developers.openai.com/api/docs/guides/streaming`) documents `response.created`,
   `response.output_text.delta`, `response.completed`, `error` and a union including
   `ResponseInProgressEvent`, `ResponseReasoning*`, `ResponseRefusal*`,
   `ResponseFunctionCallArguments*` and `ResponseFailedEvent`. This corroborates the §5 event gap;
   the guide explicitly points to the API reference for the full list, so the list here is not claimed
   exhaustive.
4. **OH's current release is externally real.** `https://registry.npmjs.org/@hilbras%2Fomnihilbras/latest`
   returned `"version": "3.95.0"`; `https://api.github.com/repos/Hilbras/OmniHilbras/releases/tags/v3.95.0`
   returned tag `v3.95.0`, published `2026-11-23T00:24:52Z`. These are facts neither tree can prove.

---

## 12. Ranked, concrete improvement plan

Ordering: closeness to the scorecard's four failing rows, then user-visible impact, then cost. Each
item names files, the behavior to add, and a proving test. "Cost" flags a turn that spends money.

1. **Add `smart` and `fusion` virtual-model strategies — closes scorecard row 5 (high).**
   Files: `Kernel/API/src/core/virtual-models.ts:11,97` (strategy union and parser),
   `Kernel/API/src/core/service.ts:4214-4267` (planning), `src/pages/ModelsPage.tsx:160-186`
   (editor), `docs/SPEC-SDK.md:413-420` (spec line; `tests/gateway-routes.test.js` guards it).
   Behavior: `smart` calls a configured router model with the prompt, uses a confidence threshold
   and a session-sticky choice, and falls back to declared target order on router error; `fusion`
   fans one prompt out to enabled targets in parallel, anonymises answers as Source N, asks a judge
   model for one synthesis, cancels outstanding members on client abort, and refuses to start when
   no panel member is enabled. Both must spend real turns and say so in the UI, not simulate them.
   Proving test: new `Kernel/API/test/virtual-smart-fusion.test.js` plus extensions to
   `Kernel/API/test/virtual-models-routing.test.js`; scripted transports assert router selection,
   judge prompt anonymisation, abort propagation, and that `UsageRecord` keys still contain no
   prompt/response fields. Reference behavior: `9router/open-sse/services/combo.js:364-450,714-890`.

2. **Complete the Responses SSE event contract — closes part of row 6 (high).**
   Files: `Kernel/API/src/routes/inference.ts:628-727`, `Kernel/API/src/core/provider-responses-lane.ts`,
   `docs/SPEC-SDK.md:355-370`. Behavior: emit `response.created` before work,
   `response.in_progress`, `response.reasoning_summary_part.added` /
   `response.reasoning_summary_text.delta` / `.done` / `response.reasoning_summary_part.done` when
   reasoning is present, `response.output_text.done`, `response.output_item.done`,
   `response.completed`, and a terminal `response.failed` on abort/stall with no fabricated success.
   Proving test: extend `Kernel/API/test/responses-route.test.js` with a scripted reasoning + tool
   stream that asserts exact event names/order and a failure case with no `response.completed`.
   References: `9router/open-sse/translator/response/openai-responses.js:81-95,190-204`,
   `open-sse/utils/responsesStreamHelpers.js:7-45`, internet finding 3.

3. **Add video generation and web fetch routes — closes the rest of row 6 (medium).**
   Files: new `Kernel/API/src/routes/video.ts` and `fetch.ts` wired in
   `Kernel/API/src/server.ts:406` and `Kernel/API/src/routes/inference.ts:1627-1632`, plus
   `docs/SPEC-SDK.md:490`, `tests/gateway-routes.test.js`. Behavior: OpenAI-shaped endpoints that
   route through the existing executor/ledger; a provider with no capability returns a named
   `NOT_SUPPORTED`, never a placeholder URL or simulated body; fetch applies the existing
   destination guard (`Kernel/API/src/core/url.ts`) so loopback/private URLs are refused.
   Proving test: `Kernel/API/test/video-route.test.js` and `fetch-route.test.js` with scripted
   transports, plus an SSRF case for `http://127.0.0.1`. References:
   `9router/src/sse/handlers/videoGeneration.js:1-20`, `fetch.js:1-20`.

4. **Close the highest-value provider-coverage holes — row 1 (high).**
   Files: new `Kernel/SDK/<id>/adapter/index.ts` packages, `Kernel/API/src/core/own-provider-adapters.ts`,
   `Kernel/API/src/core/service.ts:737-820`, `src/data/providers.ts`, `Kernel/Tools/src/caps.ts`.
   Behavior: first `cursor`, `claude`, `gemini-cli`, `xai`/`grok-cli`, `perplexity`, `glm`,
   `together`, `fireworks`; card metadata with no measured claims (per `AGENTS.md`), validation
   strategy declared beside the factory, and a real capability row. Do **not** copy 9R's
   anti-bot or MITM spoofing; a refusal is reported, not forged. Proving test: one scripted
   `Kernel/SDK/tests/<id>.test.js` per adapter plus additions to `tests/provider-cards.test.js`,
   `tests/tools-caps.test.js` and `tests/provider-oauth-routes.test.js`; no live keys required.
   Evidence: the 120-id diff in §7 and 9R's registry index at
   `9router/open-sse/providers/registry/index.js:1-80`.

5. **Upgrade `/v1/mcp` to current Streamable HTTP — protocol/security (medium).**
   Files: `Kernel/API/src/routes/mcp.ts:31-124`, `Kernel/API/test/mcp-route.test.js`,
   `docs/SPEC-SDK.md`. Behavior: negotiate `2025-11-25` (with a documented 2024-11-05 fallback),
   require `Accept: application/json, text/event-stream`, return 202 for notifications, support GET
   as SSE or an explicit 405, validate `Origin` (403 on invalid), validate
   `MCP-Protocol-Version`, and keep the existing gateway-key auth. Proving test: extend
   `Kernel/API/test/mcp-route.test.js` with HTTP-level cases for each of those five behaviors.
   References: MCP 2025-11-25 transport spec, internet finding 1.

6. **Bring over Claude tool cloaking and an external MCP plugin bridge — row 4 breadth (medium).**
   Files: new `Kernel/Tools/src/toolCloaking.ts`, `Kernel/API/src/core/service.ts:3775-3830`,
   new `src/routes/mcpPlugins.ts`, `Kernel/API/src/server.ts:406`. Behavior: deterministic suffixed
   names + decoys on the Claude wire and a restore map for both non-streaming and SSE tool names;
   a supervised stdio→SSE bridge for user-installed plugins, with names/outputs bounded and no
   shell tool exposed by default. Proving test: `Kernel/Tools/test/toolCloaking.test.js` plus a
   gateway test that a client receives only names it declared and that a decoy call never reaches
   the client. References: `9router/open-sse/utils/claudeCloaking.js:58-169`,
   `src/lib/mcp/stdioSseBridge.js:1-8`.

7. **Add the missing operator pages — row 9 (medium).**
   Files: new `src/pages/CliToolsPage.tsx`, `src/pages/TranslatorPage.tsx`, `src/pages/MitmPage.tsx`,
   `src/lib/routes.ts:6-60`, `src/dashboardApp.tsx:148-158`, `docs/SPEC-SDK.md`. Behavior: read
   existing gateway routes (`/v1/tunnels`, `/v1/mitm`, `/v1/proxy-pools`, `/v1/skills`), show only
   values the gateway returned, and make no state change on a timer. Proving test: extend
   `tests/dashboard-wiring.test.js` and `tests/dashboard-truthfulness.test.js`, plus one Playwright
   spec that loads each page against a fake gateway. References: 9R's 16 sections in §9.

8. **Add bounded, redacted request details — observability (medium).**
   Files: new `Kernel/API/src/core/request-details.ts` and route, `src/pages/LogsPage.tsx`,
   `Kernel/API/src/routes/observability.ts`. Behavior: store only sanitised error text, tool names,
   schema byte counts and a request id; never prompt/response/header/credential fields; bounded
   file size and retention; opt-in. Proving test: `Kernel/API/test/request-details.test.js` scans
   the record type and a written file for forbidden keys and oversized bodies. Reference:
   `9router/src/lib/db/repos/requestDetailsRepo.js:7,122-130` — borrow the debug value, not the
   plaintext content.

9. **Add login lockout and SSO to the gateway — security parity (medium, larger scope).**
   Files: new `Kernel/API/src/core/login-limiter.ts`, `Kernel/API/src/core/dashboard-session.ts`,
   `Kernel/API/src/routes/api-keys.ts`, `src/components/Login.tsx`, `docs/SPEC-SDK.md`. Behavior:
   per-IP progressive lockout, OIDC authorization-code + PKCE S256 with exact redirect matching,
   scoped API keys with model allow-lists, and explicit loopback-only binding by default. Proving
   test: `Kernel/API/test/login-limiter.test.js` and `oidc.test.js` with scripted discovery/token
   endpoints, plus a case that a non-allowlisted redirect is refused. References:
   `9router/src/lib/auth/{dashboardSession,loginLimiter,oidc}.js`, RFC 9700 internet finding 2.

10. **Make the 9router catalog guard runnable against the current tree — doc honesty (low).**
    Files: `scripts/build-9router-catalog.mjs:18-22`, `tests/9router-catalog.test.js:34-40`,
    `docs/architecture/9router-provider-catalog.md:1-9`. Behavior: read the 9router root from
    `NINEROUTER_ROOT` (or `--root`), default to the existing path, and fail the freshness test when
    an explicit root is supplied and counts differ. Proving test: run
    `NINEROUTER_ROOT=/mnt/sda3/work/projects.old/9router node --test tests/9router-catalog.test.js`
    after regeneration; it must stop skipping and assert the current 149-entry count. Evidence:
    the four skips from `node --test tests/9router-catalog.test.js` and the 124-vs-149 mismatch.

**Explicitly not in the plan:** plaintext credential storage, a red-by-policy test baseline,
version drift between manifests, killing foreign port holders, 9router's MITM/anti-bot stack, and
any test that presents a scripted transport as a live provider request. The parity loop's own
safety note (`tasks/parity-loop/README.md:19-21`) governs all ten items.
