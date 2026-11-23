# 9router parity, cycle 5 — whole-system comparison

Step 1 of `tasks/parity-loop/README.md`, re-measuring both trees at their current commits.

| Tree | Commit | Version | State |
| --- | --- | --- | --- |
| OmniHilbras (OH) | `1e8b3fc7656242ead188de6eb435a1a43eed898d` (2026-11-23 12:01:07 +0300) | HEAD `3.97.0` in all three manifests; working tree `3.98.0` | tag `v3.97.0` exists and is published to npm; `v3.98.0` is not tagged; working tree dirty with the 3.98.0 bump and small lint/test edits |
| 9router (9R) | `1855aa44473e88feac9d3f131b9c0c5fc9706b68` (v0.5.119) | root `0.5.116`, CLI `0.5.119` | unchanged; untracked lockfiles only |

Commands establishing this (run in this ask):

```
git log -1 --format='%H %ad %s' --date=iso && git status --short && grep -n '"version"' package.json Kernel/API/package.json cli/package.json && git tag --sort=-v:refname | head -5
git show HEAD:package.json | grep '"version"'   -> 3.97.0 ; cli and Kernel/API likewise
git tag --points-at HEAD                         -> (empty)
```

Cycle 4's implementation is committed at `1e8b3fc7` (24 files, +1171/−61) and includes the five new
OpenAI-compatible providers, their scripted tests, an updated defect register, and bookkeeping that
finally advanced the scorecard and state. No source was edited by this report.

**Checks actually run in this ask** — `pnpm verify` was **not run**, as instructed:

```
node scripts/check-version.mjs                        -> "version check passed: 3.98.0", exit 0
node --test tests/*.test.js                           -> 497 tests, 491 pass, 0 fail, 6 skipped, 27615.280849 ms
pnpm --filter @omnihilbras/kernel-api test            -> 1255 tests, 1255 pass, 0 fail, 87610.957291 ms
node --test Kernel/SDK/tests/*.test.js                -> 979 tests, 979 pass, 0 fail, 39608.295309 ms
NINEROUTER_ROOT=/mnt/sda3/work/projects.old/9router node --test tests/9router-catalog.test.js
                                                      -> 6 tests, 6 pass, 0 fail
pnpm release:audit                                    -> exit 1: "v3.96.0 has no npm version"
npm view @hilbras/omnihilbras@3.96.0 version           -> E404, exit 1
npm view @hilbras/omnihilbras@3.97.0 version           -> 3.97.0, exit 0
npm view @hilbras/omnihilbras@3.98.0 version           -> E404, exit 1
```

Not run here: `pnpm verify`, Playwright, `pnpm app:smoke`, 9router's Vitest suite, and any live
provider request. Local tests are scripted transports, not live vendor turns.

---

## 1. Verdict and scorecard

The release trail has mostly recovered: the tag/version mismatch is gone, `v3.97.0` is on npm and the
repo suite is green again. One fresh gap remains — `v3.96.0` was tagged and released but never
published, and 3.98.0 is only a working-tree bump. The project's own precedent (`3.70.0` in
`scripts/audit-release-trail.mjs:84-86`) is to record an unrecoverable gap with a reason rather than
publish superseded code, but that decision has not been made for 3.96.0, so the audit still fails.

| # | Criterion | 9R | OH | OH ≥ 9R? | Evidence |
| --- | --- | --- | --- | --- | --- |
| 1 | Working provider coverage on live requests | 3 | 3 | = | §6; 148 vs 67 declared ids, no live calls |
| 2 | Credential validation | 3 | 4 | yes | §7; declared strategies + real probes |
| 3 | Model-ID / upstream-ID / capability mapping | 4 | 4 | = | §5; catalog parsing improved, family patterns still 9R-only |
| 4 | Tool calling breadth and reliability | 4 | 4 | = | §5; cloaking + supervised MCP plugin bridge |
| 5 | Failover and multi-account rotation | 4 | 4 | yes | §3; smart/fusion committed and tested |
| 6 | Streaming / protocol surfaces | 4 | 3 | **no** | §5; video route refuses, systemone absent |
| 7 | Web-session / free-tier / special providers | 4 | 3 | **no** | §6; 110 registry ids without OH counterpart |
| 8 | Observability | 3 | 4 | yes | §8; redacted request details |
| 9 | Dashboard and operator surfaces | 4 | 3 | **no** | §8; CLI-tool configurators/translator inspector absent |
| 10 | Security at rest and in browser | 2 | 4 | yes | §7; guards green |
| 11 | Test/CI gate that runs and fails | 2 | 5 | yes | 497 + 1255 + 979 tests run here, all green |
| 12 | Release discipline and audit trail | 2 | 2 | **no** | §9; 3.96.0 npm gap keeps audit red; 3.98.0 uncommitted |

Rows 6, 7, 9 and 12 keep the loop running. Row 12 recovered from level 1 to 2 but is not yet green.

---

## 2. Architecture

OH remains a plain Node `http` gateway: request id before any handler (`Kernel/API/src/server.ts:188`),
loopback/CORS/cross-site guards (`server.ts:191-206`), one auth context (`server.ts:217`), and route
dispatch that includes video and MCP plugins (`server.ts:15-16,128`). Video paths are excluded from the
inference fast path so they still receive the key gate, limiter and ledger (`server.ts:462`,
`Kernel/API/src/routes/video.ts:22-35`). 9router still wraps Next.js 16 with a monkey-patched
`http.createServer` (`9router/custom-server.js:7,55,71,75`) and rewrites `/v1/* → /api/v1/*`
(`9router/next.config.mjs:73-108`). The runtime split is unchanged.

---

## 3. Routing and failover

Core routing is stable: quota tier → priority → name, named-account pin, named skip reasons, and the
provider-id/connection-id alias guard (`Kernel/API/src/core/routing.ts:669-817`, `:768-783`).
`RequestExecutor` and `HedgePolicy` remain (`request-executor.ts:178`, `hedge-policy.ts:56`).

Virtual `smart`/`fusion` are committed and exercised by the 1255 gateway tests: strategy union
(`Kernel/API/src/core/virtual-models.ts:16,123-149`), smart router choice with confidence and bounded
session stickiness (`Kernel/API/src/core/service.ts:4434-4460`), anonymised fusion judge with
quorum/grace/hard timeout (`service.ts:4500-4600`), and billable-cost disclosure
(`src/pages/ModelsPage.tsx:34-35,467-471`). 9router's capacity adapter
(`9router/src/sse/handlers/chat.js:167-178`) and per-model fallback locks
(`9router/open-sse/services/accountFallback.js:9-75`) remain unmatched.

---

## 4. Provider onboarding, model IDs and capabilities

Counts recomputed here:

```
OH cards -> 67 ; 9R registry entries (no index.js) -> 148
shared=38 ; ohOnly=29 ; nineOnly=110
```

Cycle 4 committed five OpenAI-compatible routers (`sambanova`, `cerebras`, `siliconflow`, `nebius`,
`perplexity` at `src/data/providers.ts:1570-1646`, `Kernel/API/src/core/own-provider-adapters.ts:110-114`,
caps rows in `Kernel/Tools/src/caps.ts`). The full five-dimension matrix is in
`docs/reports/parity-cycle-4-providers.md`.

Model identity is first-slash prefix stripping plus catalog `upstreamModelId`
(`Kernel/API/src/core/routing.ts:533-552`, `service.ts:983-997`). Upstream `supports_tools` and
`supports_thinking` are parsed (`Kernel/SDK/openai/lib/model-normalize.ts:87-88`), but 9router's
regex family defaults remain richer (`9router/open-sse/providers/capabilities.js:573-584`). Codex CLI
identity is aligned at `0.171.0` (`Kernel/SDK/codex/adapter/index.ts:19`), now ahead of 9R's `0.167.1`.

---

## 5. Tool calling and streaming protocols

**Tools.** OH's asserted table is intact (`Kernel/Tools/src/caps.ts:43-132`), refusals happen before a
provider call (`Kernel/API/src/core/service.ts:3775-3805`), Claude cloaking with decoys and restore
maps is present (`Kernel/Tools/src/toolCloaking.ts:19-102`, `service.ts:3848-3851,3889,4016`), and the
supervised MCP plugin bridge spawns only operator-registered ids with `shell:false`
(`Kernel/API/src/routes/mcpPlugins.ts:7,107-120,142-143`) while refusing a `shell` tool (`:278`).
This closes the tool-breadth gaps of earlier cycles without copying 9router's forged headers or TLS
impersonation (`toolCloaking.ts:1-12`).

**Streaming.** Responses SSE remains complete (`Kernel/API/src/routes/inference.ts:630-811`): created,
in_progress, reasoning summaries, output_text.done, tool events, completed and terminal failed
(`:747,809-811`). 360 s idle / 1800 s absolute budgets are explicit
(`Kernel/API/src/core/config.ts:36-37,153`). `/v1/fetch` is served (`Kernel/API/src/routes/fetch.ts:1-35`).
`/v1/videos/*` is a route but **still refuses every request** — no video adapter exists
(`Kernel/API/src/routes/video.ts:1-13,111,122`). 9router really generates video
(`9router/src/sse/handlers/videoGeneration.js:1-20`, `xai` config at
`9router/open-sse/providers/registry/xai.js:44`) and serves `/systemone`
(`9router/next.config.mjs:87-89`), which OH does not.

---

## 6. Provider onboarding, web sessions and free tiers

OH has 67 cards, 57+ SDK directories, 38 shared ids; 9router has 148 registry entries, 43 executors
and 57 OAuth modules. Web-session descriptors remain provider-owned
(`src/lib/webSessionProviders.ts:9+`) with check/connect routes at
`Kernel/API/src/routes/oauth.ts:545-715`. Validation strategies are declared beside factories
(`Kernel/API/src/core/own-provider-adapters.ts:61-114`, `service.ts:737-862`) and enforced at Check
(`service.ts:4627-4654`). OH's OpenCode free-tier stack still exceeds 9R's
(`Kernel/API/src/core/opencode-runtime.ts:281-410`). The 110 9R-only ids include `cursor`, `zed`,
`gemini-cli`, `grok-cli`, `glm`, `commandcode`, `mimo-free`, media and cloud hosts, listed in
`docs/reports/parity-cycle-4-providers.md:186-210`. Do not copy 9R's browser impersonation/MITM stack.

---

## 7. Credentials, auth and security

OH's vault is unchanged and asserted: one credential-shape decision
(`Kernel/API/src/core/connections.ts:1682-1688,1752`), AES-256-GCM with scrypt and atomic write
(`:1369-1393`), hashed `ohk_` keys (`Kernel/API/src/core/api-keys.ts:99-125,499`). PKCE S256 is used
in Codex, Claude, Claude Code, MiniMax, Qoder and Kiro flows. The no-secrets, browser-storage and
dashboard-honesty guards passed within the 497-test repo suite. 9router still stores provider
credentials as plaintext JSON (`9router/src/lib/db/schema.js:33-50`) but has richer sign-in
(`9router/src/lib/auth/{dashboardSession,loginLimiter,oidc,saml}.js`). **OH still has no dashboard
login/lockout/SSO**; workspaces are metadata (`Kernel/API/src/core/workspaces.ts:6-28`).

---

## 8. Observability and dashboard

Redacted request details remain (`Kernel/API/src/core/request-details.ts:14-28,53-100`,
`Kernel/API/src/routes/observability.ts:34-50`, `src/pages/LogsPage.tsx:6,92,134-136`) with no prompt,
response, header or credential stored. Usage records still have no content field
(`Kernel/API/src/core/usage-store.ts:9-31`). Dashboard routes include MITM, proxy pools, tunnels and
skills (`src/dashboardApp.tsx:181-184`). Still absent: 9router's CLI-tool configurators, translator
inspector, Monaco editors and combo drag-and-drop under
`9router/src/app/(dashboard)/dashboard/`. The provider defect register
(`docs/architecture/provider-defects.md:1-16`) was updated in cycle 4 but records a defect for only a
small minority of ids.

---

## 9. Tests, CI and release discipline

OH's canonical gate is `pnpm verify` (`package.json:44`) run by CI
(`.github/workflows/verify.yml:44`). Its components were run separately here: repo suite 497 tests /
491 pass / 0 fail / 6 skipped; gateway 1255/1255; SDK 979/979; catalog with explicit root 6/6.
The six skips are the catalog guard without an external root; with `NINEROUTER_ROOT` all six pass.
9router has 456 Vitest test files, a documented ~64-failure baseline
(`9router/CLAUDE.md:43-45`), no root `test` script (`9router/package.json:9-21`) and three CI
workflows, none of which runs tests.

**Release trail:** the tag/version mismatch is repaired — HEAD manifests all say 3.97.0 and
`tests/release-trail.test.js` passes within the green repo suite. `npm view` confirms `3.97.0` is
published. But `pnpm release:audit` still exits 1 because `v3.96.0` has no npm version;
`npm view @hilbras/omnihilbras@3.96.0 version` returns E404. The working tree's `3.98.0` bump is not
committed, tagged, released or published. 9router's manifest drift persists (root `0.5.116`,
CLI/CHANGELOG/tag `0.5.119`).

---

## 10. Internet findings

1. **3.97.0 is published; 3.96.0 remains missing.** `https://registry.npmjs.org/@hilbras%2Fomnihilbras/latest`
   returns `"version": "3.97.0"`; `npm view @hilbras/omnihilbras@3.97.0 version` echoes `3.97.0`,
   while `@3.96.0` and `@3.98.0` return E404. `pnpm release:audit` lists only `v3.96.0` as broken.
   Actionable: either publish 3.96.0 from its own tag (if that tag's code is still what users should
   get) or record it in `knownGaps` with the explicit reason that 3.97.0 supersedes it, following the
   project's own 3.70.0 precedent at `scripts/audit-release-trail.mjs:84-86`. No publish was performed.
2. **Codex CLI is now ahead of 9router.** `https://registry.npmjs.org/@openai%2Fcodex/latest` returned
   `0.171.0`, matching `Kernel/SDK/codex/adapter/index.ts:19`; 9router still pins `0.167.1`
   (`9router/open-sse/providers/registry/codex.js:5`). No live Codex turn was made.
3. **MCP transport alignment remains correct.** `https://modelcontextprotocol.io/specification/2025-11-25/basic/transports`
   names Streamable HTTP as current; OH negotiates `2025-11-25` with a `2024-11-05` fallback
   (`Kernel/API/test/mcp-route.test.js:39-40,83-95`) and the plugin bridge uses a supervised stdio
   child with `shell:false` (`Kernel/API/src/routes/mcpPlugins.ts:7,142-143`). No action needed.

---

## 11. Ranked, concrete improvement plan

1. **Close the last release gap and finish the 3.98.0 ceremony (high).**
   Files: `scripts/audit-release-trail.mjs:57-90`, `NPM-PUBLISH.md`, `tasks/parity-loop/state.json`.
   Behavior: decide explicitly whether 3.96.0 is republishable from its own tag; if 3.97.0 supersedes
   it, add a `knownGaps` entry with that reason (with a test pinning the count), otherwise publish it.
   Then commit/tag/release/publish 3.98.0 and poll the registry. Proving test:
   `pnpm release:audit` exit 0 and `npm view @hilbras/omnihilbras@3.98.0 version` echoing 3.98.0.
   **Not performed in this report** (commit/publish forbidden).
2. **Give video a real adapter or keep the refusal honest (high).**
   Files: `Kernel/API/src/routes/video.ts:1-13,111,122`, new `Kernel/SDK/xai/adapter/video.ts`,
   `Kernel/API/src/server.ts:16,128,462`.
   Behavior: implement job creation and a poll bound to the creating connection for at least one
   provider that really serves video (9router's `xai` config at
   `9router/open-sse/providers/registry/xai.js:44`); all other providers keep `NOT_SUPPORTED` and no
   synthetic URL or completion is produced. Proving test: extend `Kernel/API/test/video-route.test.js`
   with a scripted video transport and a connection-bound poll case.
3. **Close the highest-value remaining provider ids (high).**
   Files: new SDK packages, `Kernel/API/src/core/own-provider-adapters.ts`,
   `Kernel/API/src/core/service.ts:737-862`, `src/data/providers.ts`, `Kernel/Tools/src/caps.ts`.
   Behavior: next `cursor`, `gemini-cli`, `zed`, `glm`, `commandcode`; cards with no measured claims,
   declared validation strategies, real OAuth/device flows where 9router has them
   (`9router/src/lib/oauth/{providers,services}/<id>.js`), no anti-bot spoofing. Proving test:
   scripted adapter tests per id plus `tests/provider-cards.test.js`, `tests/tools-caps.test.js` and
   `tests/provider-oauth-routes.test.js` (all green in this ask's repo suite).
4. **Resolve the `xai` and `kimi` id mismatches (medium).**
   Files: `src/data/providers.ts:1003,1535`, `Kernel/API/src/core/own-provider-adapters.ts:93,108`,
   `Kernel/SDK/xai/adapter/index.ts`, `src/components/AddProviderModal.tsx`, `docs/SPEC-SDK.md`.
   Behavior: for `xai`, implement OAuth plus Responses/image/video/search lanes or state in the card
   that only API-key chat is served; for `kimi`, point it at the coding endpoint with OAuth like
   `9router/open-sse/providers/registry/kimi.js:23-28` or say explicitly that `kimi-code` is the
   coding subscription. Proving test: extend `Kernel/SDK/tests/xai.test.js` and
   `tests/provider-cards.test.js` to assert endpoint/auth agreement with each card.
5. **Add dashboard CLI-tool configurator and translator inspector (medium).**
   Files: new `src/pages/CliToolsPage.tsx`, `src/pages/TranslatorPage.tsx`, `src/lib/routes.ts`,
   `src/dashboardApp.tsx:168-185`, `docs/SPEC-SDK.md`.
   Behavior: read existing gateway state only, no invented values, no timer-set success. Proving
   test: extend `tests/dashboard-wiring.test.js` and `tests/dashboard-truthfulness.test.js` plus one
   Playwright spec against a fake gateway.
6. **Add dashboard login lockout and SSO (medium, larger scope).**
   Files: new `Kernel/API/src/core/login-limiter.ts`, `dashboard-session.ts`,
   `Kernel/API/src/routes/api-keys.ts`, `src/components/Login.tsx`, `docs/SPEC-SDK.md`.
   Behavior: per-IP progressive lockout, OIDC authorization-code + PKCE S256 with exact redirect
   matching, scoped keys with model allow-lists, loopback binding by default. Proving test:
   `Kernel/API/test/login-limiter.test.js` and `oidc.test.js` with scripted discovery/token endpoints.
7. **Make candidate-key checks honest and family capability defaults bounded (low).**
   Files: `Kernel/API/src/core/own-provider-adapters.ts:61-114`,
   `Kernel/API/src/core/modelCapabilities.ts:8-28`, `tests/provider-validation.test.js`,
   `Kernel/API/test/model-capabilities.test.js`.
   Behavior: declare `validation:'models'` only with an evidence note about an authenticated catalog;
   otherwise keep `none` and say so in the UI. Add family defaults only where 9router's upstream
   publishes them (`9router/open-sse/providers/capabilities.js:573-584`). Proving test: bogus-key
   cases modeled on `9router/src/app/api/providers/validate/route.js:289-330,401-413` plus a
   `supports_tools:false` catalog case.

**Not to copy:** plaintext credentials, public-catalog key validation, browser impersonation/MITM,
manifest version drift, a red-by-policy test baseline, and any simulated success. The safety rule in
`tasks/parity-loop/README.md:19-21` governs all seven items.
