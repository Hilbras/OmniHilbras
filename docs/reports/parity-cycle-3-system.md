# 9router parity, cycle 3 — whole-system comparison

Step 1 of `tasks/parity-loop/README.md`, re-measuring both trees at their current commits and in
their current working-tree state.

| Tree | Commit | Version | State |
| --- | --- | --- | --- |
| OmniHilbras (OH) | `bcd6222dbedaacb17633ae418608c825a2e66578` (2026-11-23 06:21:10 +0300) | HEAD `3.96.0`; **working tree `3.97.0`** (`package.json:4`, `Kernel/API/package.json:3`, `cli/package.json:3`) | commit unchanged since cycle 2; cycle-2 implementation is still uncommitted (`git status --short` lists modified `src/data/providers.ts`, `Kernel/API/src/core/service.ts`, `Kernel/SDK/codex/adapter/index.ts` and new video/cloaking/xai/defect-register files) |
| 9router (9R) | `1855aa44473e88feac9d3f131b9c0c5fc9706b68` (v0.5.119) | root `0.5.116`, CLI `0.5.119` | unchanged; untracked lockfiles only |

Commands establishing this (run in this ask):

```
git log -1 --format='%H %ad %s' --date=iso && git status --short && grep -n '"version"' package.json Kernel/API/package.json cli/package.json && git tag --sort=-v:refname | head -4
  # OH: bcd6222d, dirty, 3.97.0, newest tag v3.96.0
  # 9R: 1855aa4, root 0.5.116 / cli 0.5.119
```

`tasks/parity-loop/state.json` now says cycle 1 / step 2 with a history entry for cycle 2; the
scorecard was filled from `docs/reports/parity-cycle-2-system.md`. Neither file was edited by this
report. Cycle 3 asks the same 12 questions against a tree with additional uncommitted work, so this
report records both the committed baseline and what is only present in the working tree.

**Checks actually run in this ask** — `pnpm verify` was **not run**, as instructed:

```
node scripts/check-version.mjs                 -> "version check passed: 3.97.0", exit 0
node --test tests/*.test.js                    -> 493 tests, 487 pass, 0 fail, 6 skipped, 16182.654411 ms
pnpm --filter @omnihilbras/kernel-api test     -> 1243 tests, 1243 pass, 0 fail, 80248.739735 ms
node --test Kernel/SDK/tests/*.test.js         -> 959 tests, 959 pass, 0 fail, 41896.264811 ms
NINEROUTER_ROOT=/mnt/sda3/work/projects.old/9router node --test tests/9router-catalog.test.js
                                               -> 6 tests, 6 pass, 0 fail
pnpm release:audit                             -> exit 1: "v3.96.0 has no npm version"
npm view @hilbras/omnihilbras@3.97.0 version   -> E404, exit 1
npm view @hilbras/omnihilbras@3.96.0 version   -> E404, exit 1
```

Not run here: `pnpm verify`, Playwright, `pnpm app:smoke`, 9router's Vitest suite, and any live
provider request. No live credential is available; "passes" means local scripted tests only.

---

## 1. Verdict and scorecard

Cycle-2 implementation work (still uncommitted) closed three named gaps at the code level:
`Kernel/SDK/codex/adapter/index.ts:19` now pins `0.171.0`; Claude tool cloaking exists in
`Kernel/Tools/src/toolCloaking.ts:19-102` and is wired at
`Kernel/API/src/core/service.ts:3848-3851,3889,4016`; and `/v1/videos/*` exists as a route
(`Kernel/API/src/routes/video.ts:1-13`, `Kernel/API/src/server.ts:16,128,462`) — but the video handler
**refuses every request** because no video adapter exists. `xai` was added as an API-key card
(`src/data/providers.ts:1535`), and a generated defect register exists
(`docs/architecture/provider-defects.md:1-16`).

The release-discipline gap from cycle 2 remains: `v3.96.0` is tagged and released on GitHub but absent
from npm, and the working tree's `3.97.0` is neither committed, tagged nor published.

| # | Criterion | 9R | OH | OH ≥ 9R? | Evidence |
| --- | --- | --- | --- | --- | --- |
| 1 | Working provider coverage on live requests | 3 | 3 | = | §6; 148 vs 61 declared ids, no live calls |
| 2 | Credential validation | 3 | 4 | yes | §7; declared strategies + real probes |
| 3 | Model-ID / upstream-ID / capability mapping | 4 | 4 | = | §5; Codex pin fixed, tier rewrite still 9R-only |
| 4 | Tool calling breadth and reliability | 4 | 4 | = | §5; cloaking added, MCP plugin bridge absent |
| 5 | Failover and multi-account rotation | 4 | 4 | yes | §3; smart/fusion committed and tested |
| 6 | Streaming / protocol surfaces | 4 | 3 | **no** | §5; video route refuses, no video adapter, systemone absent |
| 7 | Web-session / free-tier / special providers | 4 | 3 | **no** | §6; 116 registry ids without OH counterpart |
| 8 | Observability | 3 | 4 | yes | §8; redacted request details |
| 9 | Dashboard and operator surfaces | 4 | 3 | **no** | §8; CLI-tool configurators/translator inspector absent |
| 10 | Security at rest and in browser | 2 | 4 | yes | §7; guards green in this ask |
| 11 | Test/CI gate that runs and fails | 2 | 5 | yes | 493 + 1243 + 959 tests run here, all green |
| 12 | Release discipline and audit trail | 2 | 2 | **no** | §9; audit exit 1, two versions absent from npm |

Rows 6, 7, 9 and 12 keep the loop running. Row 12 has regressed relative to cycle 2's score because
the working tree advanced to 3.97.0 without closing 3.96.0's npm gap.

---

## 2. Architecture

OH remains a plain Node `http` gateway: request id before any handler (`Kernel/API/src/server.ts:188`),
loopback/CORS/cross-site guards (`server.ts:191-206`), auth context from allowlisted origin and
per-launch token (`server.ts:217`), and ordered route dispatch that now imports the video handler
(`server.ts:15-16,128`). The new video paths are explicitly excluded from the inference fast path
(`server.ts:462`), so they get the key gate, limiter and ledger (`Kernel/API/src/routes/video.ts:22-35`).
9router still wraps Next.js 16 with a monkey-patched `http.createServer`
(`9router/custom-server.js:7,55,71,75`) and rewrites `/v1/* → /api/v1/*`
(`9router/next.config.mjs:73-108`). The architectural split is unchanged and remains deliberate.

---

## 3. Routing and failover

`resolveRoute` still orders paid → cheap → free, priority, name, pins a named connection, skips with
named reasons, and prevents a provider id aliasing a connection id from ejecting siblings
(`Kernel/API/src/core/routing.ts:669-817`, especially `:768-783`). `RequestExecutor` and the hedge
policy are unchanged (`request-executor.ts:178`, `hedge-policy.ts:56`).

Virtual-model `smart` and `fusion` remain committed: strategy union
(`Kernel/API/src/core/virtual-models.ts:12,16,123-149`), router choice with confidence threshold and
bounded session stickiness (`Kernel/API/src/core/service.ts:4294-4425`), anonymised fusion judge with
quorum/grace/hard-timeout and abort forwarding (`:4434-4560`), billable-cost disclosure
(`src/pages/ModelsPage.tsx:34-35,467-471`), and a 202-line proving test
(`Kernel/API/test/virtual-smart-fusion.test.js`, exercised within the 1243 gateway tests run here).
9router's capacity adapter (`9router/src/sse/handlers/chat.js:167-178`) and per-model fallback locks
(`9router/open-sse/services/accountFallback.js:9-75`) remain unmatched.

---

## 4. Provider onboarding, model IDs and capabilities

Counts from commands run in this ask:

```
OH cards (working tree)            -> 61
9R registry entries (no index.js)  -> 148
shared=32  ohOnly=29  nineOnly=116
```

`xai` is the cycle-2 addition (`src/data/providers.ts:1535`,
`Kernel/API/src/core/own-provider-adapters.ts:108`, `service.ts:838`) but is API-key-only, while
9router's `xai` is oauth+apikey with Responses/image/video/search lanes
(`9router/open-sse/providers/registry/xai.js:15-25,24,41,44,45`). The full 32/29/116 comparison and
the five-dimension matrix per shared id are in `docs/reports/parity-cycle-2-providers.md`.

Model identity handling is unchanged: first-slash prefix for connected providers
(`Kernel/API/src/core/routing.ts:533-552`), catalog `upstreamModelId` sent on dispatch
(`service.ts:983-997`), full-id-first tool narrowing (`Kernel/API/src/core/modelCapabilities.ts:8-28`).
The Codex CLI pin is now aligned with the registry latest (`Kernel/SDK/codex/adapter/index.ts:19` →
`0.171.0`). 9router's richer static capability patterns for model families remain (e.g. grok at
`9router/open-sse/providers/capabilities.js:573-584`).

---

## 5. Tool calling and streaming protocols

**Tools.** OH's asserted row-per-id table is intact (`Kernel/Tools/src/caps.ts:43-127`); the gate
refuses unserved tools before a provider call (`Kernel/API/src/core/service.ts:3775-3805`). Claude
cloaking is now present: suffix `_ide`, decoys and a restore map in
`Kernel/Tools/src/toolCloaking.ts:19-102`, wired into the request contract and both response paths at
`service.ts:3848-3851,3889,4016`. It deliberately excludes forged headers and browser impersonation
(`toolCloaking.ts:1-12`). What remains is 9router's external MCP stdio→SSE plugin bridge
(`9router/src/lib/mcp/stdioSseBridge.js:1-8`); a search for `mcpPlugins|stdio|spawn` under OH's
`Kernel/API/src/routes` and `server.ts` returned no matches.

**Streaming.** Responses SSE completeness from cycle 1 remains (`Kernel/API/src/routes/inference.ts:630-811`):
created/in_progress, reasoning summaries, output_text.done, tool events, completed and a terminal
failed. 360 s idle / 1800 s absolute budgets are explicit (`Kernel/API/src/core/config.ts:36-37,153`).
`/v1/fetch` exists (`Kernel/API/src/routes/fetch.ts:1-35`). **Video is a route, not a capability**: the
handler's own header says there is no video adapter and every request ends in `NOT_SUPPORTED`
(`Kernel/API/src/routes/video.ts:1-13`). 9router really generates video
(`9router/src/sse/handlers/videoGeneration.js:1-20`, `xai` config at `9router/open-sse/providers/registry/xai.js:44`)
and serves `/systemone` (`9router/next.config.mjs:87-89`), which OH does not.

---

## 6. Provider onboarding, web sessions and free tiers

OH has 61 cards / 55 SDK packages / 32 shared ids; 9router has 148 registry entries / 43 executors /
57 OAuth modules. Web-session descriptors remain provider-owned (`src/lib/webSessionProviders.ts:9+`)
with check/connect routes at `Kernel/API/src/routes/oauth.ts:545-715`. Credential strategies are
declared beside factories (`Kernel/API/src/core/own-provider-adapters.ts:68-108`, `service.ts:737-838`)
and enforced at Check (`service.ts:4627-4654`). OH's OpenCode free-tier stack still exceeds 9R's
(`Kernel/API/src/core/opencode-runtime.ts:281-410`). The 116 9R-only ids are listed in
`docs/reports/parity-cycle-2-providers.md:200-230`; they include the subscription CLI/OAuth wires
(`cursor`, `claude`, `gemini-cli`, `zed`, `windsurf`, `trae`, `glm`), binary wires (`commandcode`,
`mimo-free`, `xiaomi-tokenplan`), and media/search vendors. Do not copy 9router's TLS impersonation
or MITM stack (`9router/CHANGELOG.md:121`, `tasks/parity-loop/README.md:19-21`).

---

## 7. Credentials, auth and security

OH vault and key handling are unchanged and asserted: one `storedCredential()` writer/reader
(`Kernel/API/src/core/connections.ts:1682-1688,1752`), AES-256-GCM with scrypt and atomic write
(`:1369-1393`), hashed `ohk_` keys (`Kernel/API/src/core/api-keys.ts:99-125,499`). PKCE S256 remains
in the Codex/Claude Code/MiniMax/Qoder/Kiro flows. The no-secrets, browser-storage and dashboard
truthfulness guards passed within the 493-test repo suite run here. 9router still stores provider
credentials as plaintext JSON (`9router/src/lib/db/schema.js:33-50`) while offering richer sign-in
(bcrypt/JWT, OIDC/SAML, per-IP lockout) in `9router/src/lib/auth/`. **OH still has no dashboard
login/lockout/SSO**; workspaces are metadata (`Kernel/API/src/core/workspaces.ts:6-28`).

---

## 8. Observability and dashboard

Redacted request details remain (`Kernel/API/src/core/request-details.ts:14-28,53-100`,
`Kernel/API/src/routes/observability.ts:34-50`, `src/pages/LogsPage.tsx:6,92,134-136`), with no prompt,
response, header or credential recorded. Usage records still have no content field
(`Kernel/API/src/core/usage-store.ts:9-31`). Dashboard routes include MITM, proxy pools, tunnels and
skills (`src/dashboardApp.tsx:181-184`). Still absent: 9router's CLI-tool configurators (≈30 clients),
translator inspector, Monaco editors and combo drag-and-drop under
`9router/src/app/(dashboard)/dashboard/`. A generated provider defect register now exists
(`docs/architecture/provider-defects.md:1-16`: 177 rows, 9 ids with a recorded defect), which improves
discoverability but is not yet comprehensive.

---

## 9. Tests, CI and release discipline

OH's canonical gate is still `pnpm verify` (`package.json:44`) run by CI
(`.github/workflows/verify.yml:44`). In this ask its components were run separately with the outputs
at the top: 493 repo tests (487 pass, 6 skipped), 1243 gateway tests and 959 SDK tests, plus six
catalog tests with an explicit external root. The six skips in the repo suite are the catalog guard
without a root; with `NINEROUTER_ROOT` supplied all six pass. 9router has 456 Vitest test files, a
documented ~64-failure baseline (`9router/CLAUDE.md:43-45`), a manual comparator
(`9router/tests/__baseline__/verify-no-regression.mjs:1-21`), no root `test` script
(`9router/package.json:9-21`) and no CI workflow running tests.

**Release discipline is the top gap.** `v3.96.0` is tagged at the previous commit and has a GitHub
release (confirmed by API in cycle 2) but no npm version; `pnpm release:audit` exits 1 here with
`v3.96.0 has no npm version`. The working tree has bumped to `3.97.0` (`package.json:4`) but that
version is not committed, tagged, released or published; `git tag --sort=-v:refname | head -4` starts
at `v3.96.0`. `npm view` returns E404 for both `3.96.0` and `3.97.0`. 9router's manifest drift
persists: root `0.5.116` vs CLI/CHANGELOG/tag `0.5.119`.

---

## 10. Internet findings

1. **Neither open release version is on npm.** `https://registry.npmjs.org/@hilbras%2Fomnihilbras/latest`
   returns `"version": "3.95.0"`; `https://registry.npmjs.org/@hilbras%2Fomnihilbras/3.96.0` and
   `/3.97.0` both return 404. Locally confirmed with `npm view … version` (E404 for both) and
   `pnpm release:audit` (exit 1). Actionable: publish from `cli/` and poll the registry before any
   further release ceremony; publishing was forbidden by this ask.
2. **Codex CLI pin is now current.** `https://registry.npmjs.org/@openai%2Fcodex/latest` returned
   `"version": "0.171.0"`; OH's working tree now pins the same value at
   `Kernel/SDK/codex/adapter/index.ts:19` (cycle 2's `0.159.2` gap is closed). 9router still pins
   `0.167.1` (`9router/open-sse/providers/registry/codex.js:5`). No live Codex turn was made.
3. **MCP version alignment remains correct.** `https://modelcontextprotocol.io/specification/2025-11-25/basic/transports`
   names Streamable HTTP as the current transport; OH negotiates `2025-11-25` with a documented
   `2024-11-05` fallback (`Kernel/API/test/mcp-route.test.js:39-40,83-95`) and refuses GET streams with
   an explicit 405, which the spec permits. No change needed.

---

## 11. Ranked, concrete improvement plan

1. **Repair the release trail before more behavior work (high).**
   Files: `cli/` (publishable manifest), `NPM-PUBLISH.md`, `tasks/parity-loop/state.json`.
   Behavior: publish `3.96.0` from `cli/`, poll `npm view @hilbras/omnihilbras@3.96.0 version` until it
   echoes `3.96.0`, then commit/tag/release/publish the already-bumped `3.97.0` in one ceremony; never
   add a `knownGaps` exemption — this gap is recent and repairable. Proving test: `pnpm release:audit`
   exit 0 plus `npm view … version` for both tags. **Not performed in this report** (publishing forbidden).
2. **Give the video route at least one real adapter (high).**
   Files: `Kernel/API/src/routes/video.ts:1-13`, new `Kernel/SDK/xai/adapter/video.ts` (or another
   declared video provider), `Kernel/API/src/server.ts:16,128,462`.
   Behavior: the first provider that genuinely serves video — 9router's `xai` config at
   `9router/open-sse/providers/registry/xai.js:44` is a concrete model — gets a job creation and poll
   bound to the creating connection; every other provider keeps `NOT_SUPPORTED`. Proving test: extend
   `Kernel/API/test/video-route.test.js` with a scripted video transport, a poll case and a refusal
   case; no fake URL or simulated completion.
3. **Close the highest-value provider ids (high).**
   Files: new `Kernel/SDK/<id>/adapter/index.ts`, `Kernel/API/src/core/own-provider-adapters.ts`,
   `Kernel/API/src/core/service.ts:737-838`, `src/data/providers.ts`, `Kernel/Tools/src/caps.ts`.
   Behavior: first `claude`, `cursor`, `gemini-cli`, `zed`, `glm`; cards with no measured claims,
   declared validation strategies and real OAuth/device flows where 9router has them
   (`9router/src/lib/oauth/{providers,services}/<id>.js`), without anti-bot spoofing. Proving test:
   scripted adapter tests per id plus `tests/provider-cards.test.js`, `tests/tools-caps.test.js`,
   `tests/provider-oauth-routes.test.js` (all green in this ask's repo suite).
4. **Add the external MCP plugin bridge (medium).**
   Files: new `Kernel/API/src/routes/mcpPlugins.ts`, `Kernel/API/src/server.ts:408`,
   `docs/SPEC-SDK.md`.
   Behavior: supervised stdio→SSE bridge for user-installed MCP plugins, bounded output, no shell tool
   by default, and the same origin/key gates as `/v1/mcp`. Proving test: a gateway test with a scripted
   child process that asserts frame boundaries, bounded text and refusal of a shell request.
   Reference: `9router/src/lib/mcp/stdioSseBridge.js:1-8`.
5. **Add dashboard login lockout and SSO (medium, larger scope).**
   Files: new `Kernel/API/src/core/login-limiter.ts`, `dashboard-session.ts`,
   `Kernel/API/src/routes/api-keys.ts`, `src/components/Login.tsx`, `docs/SPEC-SDK.md`.
   Behavior: per-IP progressive lockout, OIDC authorization-code + PKCE S256 with exact redirect
   matching, scoped keys with model allow-lists, loopback binding by default. Proving test:
   `Kernel/API/test/login-limiter.test.js` and `oidc.test.js` with scripted discovery/token endpoints.
6. **Add CLI-tool configurator and translator inspector pages (medium).**
   Files: new `src/pages/CliToolsPage.tsx`, `src/pages/TranslatorPage.tsx`, `src/lib/routes.ts`,
   `src/dashboardApp.tsx:168-185`, `docs/SPEC-SDK.md`.
   Behavior: read existing gateway state only, no invented values, no timer-set success states.
   Proving test: extend `tests/dashboard-wiring.test.js` and `tests/dashboard-truthfulness.test.js`
   plus one Playwright spec against a fake gateway.
7. **Port per-model capability patterns (low).**
   Files: `Kernel/API/src/core/modelCapabilities.ts:8-28`, `Kernel/API/src/core/routing.ts:573-579`.
   Behavior: parse upstream `supports_tools`/`supports_thinking` and apply 9router-style family
   patterns (grok context/features at `9router/open-sse/providers/capabilities.js:573-584`) without
   inventing values. Proving test: extend `Kernel/API/test/model-capabilities.test.js` with a family
   pattern and a `supports_tools:false` catalog entry.
8. **Make candidate-key checks honest where they are currently `none` (low).**
   Files: `Kernel/API/src/core/own-provider-adapters.ts:87-108`, `tests/provider-validation.test.js`.
   Behavior: where an upstream catalog is authenticated, declare `validation:'models'` with an evidence
   note; where it is public, keep `none` and say so in the UI. Never add a generic fallback that
   accepts a bogus key. Proving test: bogus-key cases for `openai`, `gemini`, `openrouter`, `deepseek`,
   `together`, `fireworks`, `xai` modeled on 9router's `9router/src/app/api/providers/validate/route.js:289-330,401-413`.

**Not to copy:** plaintext credentials, public-catalog key validation, browser impersonation/MITM,
manifest version drift, a red-by-policy test baseline, and any simulated success. The safety rule in
`tasks/parity-loop/README.md:19-21` governs all eight items.
