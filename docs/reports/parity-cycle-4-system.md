# 9router parity, cycle 4 — whole-system comparison

Step 1 of `tasks/parity-loop/README.md`, re-measuring both trees at their current commits.

| Tree | Commit | Version | State |
| --- | --- | --- | --- |
| OmniHilbras (OH) | `a71f61d8e322e7ad70daaa1b706f6fa325aad892` (2026-11-23 10:12:33 +0300) | at HEAD root/cli `3.96.0`, `Kernel/API` `3.97.0`; working tree bumps root/cli to `3.97.0` | tag `v3.97.0` points at HEAD; working tree dirty with the version fix and small test/lint edits |
| 9router (9R) | `1855aa44473e88feac9d3f131b9c0c5fc9706b68` (v0.5.119) | root `0.5.116`, CLI `0.5.119` | unchanged; untracked lockfiles only |

Commands establishing this (run in this ask):

```
git log -1 --format='%H %ad %s' --date=iso && git status --short && grep -n '"version"' package.json Kernel/API/package.json cli/package.json && git tag --sort=-v:refname | head -4
# HEAD: a71f61d8; tags v3.97.0, v3.96.0...
git show HEAD:package.json | grep '"version"'      -> 4:  "version": "3.96.0",
git show HEAD:Kernel/API/package.json | grep '"version"' -> 3:  "version": "3.97.0",
git show HEAD:cli/package.json | grep '"version"'   -> 3:  "version": "3.96.0",
git tag --points-at HEAD                            -> v3.97.0
```

Cycle 3's implementation is committed at `a71f61d8` (60 files, +5751/−55) and tagged `v3.97.0`.
Its own commit message says the release-trail item was blocked by the network/credential boundary and
the do-not-commit instruction. That block is now visible as a **red offline test**, not just a missing
npm version. No source was edited by this report.

**Checks actually run in this ask** — `pnpm verify` was **not run**, as instructed:

```
node scripts/check-version.mjs                       -> "version check passed: 3.97.0", exit 0
node --test tests/*.test.js                          -> 495 tests, 488 pass, 1 fail, 6 skipped
  failing: tests/release-trail.test.js:48 "every tag states the version its own commit carries"
  assertion: v3.97.0: its package.json says 3.96.0
pnpm --filter @omnihilbras/kernel-api test           -> 1255 tests, 1255 pass, 0 fail, 83059.114155 ms
node --test Kernel/SDK/tests/*.test.js               -> 967 tests, 967 pass, 0 fail, 42261.114355 ms
NINEROUTER_ROOT=/mnt/sda3/work/projects.old/9router node --test tests/9router-catalog.test.js
                                                     -> 6 tests, 6 pass, 0 fail
pnpm release:audit                                   -> exit 1: v3.96.0 and v3.97.0 have no npm version
npm view @hilbras/omnihilbras@3.96.0 version          -> E404, exit 1
npm view @hilbras/omnihilbras@3.97.0 version          -> E404, exit 1
```

Not run here: `pnpm verify`, Playwright, `pnpm app:smoke`, 9router's Vitest suite, and any live
provider request. "Passing" means local scripted tests only.

---

## 1. Verdict and scorecard

Cycle-3 implementation closed most of the provider/tool/routing gaps named in earlier cycles:
`claude` OAuth and SDK (`Kernel/SDK/claude/adapter/index.ts`, 610 lines), a real `xai` SDK
(`Kernel/SDK/xai/adapter/index.ts`, 136 lines), a supervised MCP plugin bridge
(`Kernel/API/src/routes/mcpPlugins.ts`, 290 lines, `shell:false` at `:142-143`), a video route with
honest `NOT_SUPPORTED` (`Kernel/API/src/routes/video.ts:1-13,111,122`), tool cloaking
(`Kernel/Tools/src/toolCloaking.ts:19-102`), and upstream capability parsing
(`Kernel/SDK/openai/lib/model-normalize.ts:87-88`). The Codex CLI pin is now `0.171.0`.

**The release trail is now the worst it has been in this loop**: a tag that disagrees with the
version in its own commit, two tagged versions missing from npm, and a red test inside `pnpm verify`'s
own chain. This is a user-visible failure of the project's release contract and is ranked first.

| # | Criterion | 9R | OH | OH ≥ 9R? | Evidence |
| --- | --- | --- | --- | --- | --- |
| 1 | Working provider coverage on live requests | 3 | 3 | = | §6; 148 vs 62 declared ids, no live calls |
| 2 | Credential validation | 3 | 4 | yes | §7; declared strategies + real probes |
| 3 | Model-ID / upstream-ID / capability mapping | 4 | 4 | = | §5; parsing improved, family patterns still 9R-only |
| 4 | Tool calling breadth and reliability | 4 | 4 | = | §5; cloaking + MCP bridge now present |
| 5 | Failover and multi-account rotation | 4 | 4 | yes | §3; smart/fusion committed and tested |
| 6 | Streaming / protocol surfaces | 4 | 3 | **no** | §5; video route refuses, systemone absent |
| 7 | Web-session / free-tier / special providers | 4 | 3 | **no** | §6; 115 registry ids without OH counterpart |
| 8 | Observability | 3 | 4 | yes | §8; redacted request details |
| 9 | Dashboard and operator surfaces | 4 | 3 | **no** | §8; CLI-tool configurators/translator inspector absent |
| 10 | Security at rest and in browser | 2 | 4 | yes | §7; guards green except release trail |
| 11 | Test/CI gate that runs and fails | 2 | 4 | yes | 1255 + 967 green; repo suite has 1 real failure, so not 5 |
| 12 | Release discipline and audit trail | 2 | 1 | **no** | §9; tag/version mismatch + two npm gaps |

Rows 6, 7, 9 and 12 keep the loop running; row 12 is now level 1 (declared but broken).

---

## 2. Architecture

OH remains a plain Node `http` gateway: request id before any handler
(`Kernel/API/src/server.ts:188`), loopback/CORS/cross-site guards (`server.ts:191-206`), one auth
context (`server.ts:217`), and route dispatch that now includes video and MCP plugins
(`server.ts:15-16,128`). Video paths are excluded from the inference fast path so they receive the
key gate, limiter and ledger (`server.ts:462`, `Kernel/API/src/routes/video.ts:22-35`). 9router still
monkey-patches `http.createServer` (`9router/custom-server.js:7,55,71,75`) and rewrites `/v1/* →
/api/v1/*` (`9router/next.config.mjs:73-108`). The two runtime shapes remain different by design.

---

## 3. Routing and failover

Core routing is unchanged: quota tier → priority → name ordering, named-account pin, named skip
reasons, and the provider-id/connection-id alias guard
(`Kernel/API/src/core/routing.ts:669-817`, `:768-783`). `RequestExecutor` and `HedgePolicy` remain
(`request-executor.ts:178`, `hedge-policy.ts:56`).

Virtual `smart`/`fusion` are now committed and exercised by the 1255 gateway tests:
strategy union (`Kernel/API/src/core/virtual-models.ts:16,123-149`), smart decision with confidence
and bounded stickiness (`Kernel/API/src/core/service.ts:4434-4460`), anonymised fusion judge with
quorum/grace/hard timeout (`:4500-4600`), cost disclosure (`src/pages/ModelsPage.tsx:34-35,467-471`).
9router's capacity adapter (`9router/src/sse/handlers/chat.js:167-178`) and per-model fallback locks
(`9router/open-sse/services/accountFallback.js:9-75`) remain unmatched.

---

## 4. Provider onboarding, model IDs and capabilities

Counts recomputed here:

```
OH cards -> 62 ; 9R registry entries (no index.js) -> 148
shared=33 ; ohOnly=29 ; nineOnly=115
```

The cycle-3 additions are committed: `claude` (`src/data/providers.ts:1085`, SDK
`Kernel/SDK/claude/adapter/index.ts`, sign-in `Kernel/API/src/core/service.ts:1860-1903`, caps
`Kernel/Tools/src/caps.ts:98`) and `xai` (`src/data/providers.ts:1535`, SDK
`Kernel/SDK/xai/adapter/index.ts:1-136`, factory `own-provider-adapters.ts:108`). The full five-dimension
matrix is in `docs/reports/parity-cycle-3-providers.md`.

Model identity remains first-slash prefix stripping plus catalog `upstreamModelId`
(`Kernel/API/src/core/routing.ts:533-552`, `service.ts:983-997`). Upstream `supports_tools` and
`supports_thinking` are now parsed (`Kernel/SDK/openai/lib/model-normalize.ts:87-88`), closing the
catalog half of the capability gap; 9router's regex family defaults remain richer
(`9router/open-sse/providers/capabilities.js:573-584`). Codex CLI identity is aligned at `0.171.0`
(`Kernel/SDK/codex/adapter/index.ts:19`).

---

## 5. Tool calling and streaming protocols

**Tools.** OH's asserted table is intact (`Kernel/Tools/src/caps.ts:43-127`), refusals happen before a
provider call (`Kernel/API/src/core/service.ts:3775-3805`), and Claude cloaking with decoys and restore
maps is present (`Kernel/Tools/src/toolCloaking.ts:19-102`, `service.ts:3848-3851,3889,4016`). The
external MCP plugin bridge now exists with operator-registered commands, `shell:false`
(`Kernel/API/src/routes/mcpPlugins.ts:7,107-120,142-143`) and a shell-tool refusal (`:278`). This closes
the tool-breadth gap from cycles 1–2 without carrying over 9router's TLS impersonation or forged
headers (`toolCloaking.ts:1-12`).

**Streaming.** Responses SSE remains complete (`Kernel/API/src/routes/inference.ts:630-811`):
created/in_progress, reasoning summaries, output_text.done, tool events, completed and terminal
failed. 360 s idle and 1800 s absolute budgets are explicit (`Kernel/API/src/core/config.ts:36-37,153`).
`/v1/fetch` is served (`Kernel/API/src/routes/fetch.ts:1-35`). `/v1/videos/*` is now a real route but
**still refuses every request** — no video adapter exists (`Kernel/API/src/routes/video.ts:1-13,111,122`).
9router really generates video (`9router/src/sse/handlers/videoGeneration.js:1-20`, `xai` config at
`9router/open-sse/providers/registry/xai.js:44`) and exposes `/systemone`
(`9router/next.config.mjs:87-89`), which OH does not.

---

## 6. Provider onboarding, web sessions and free tiers

OH has 62 cards / 57 SDK directories / 33 shared ids; 9router has 148 registry entries / 43
executors / 57 OAuth modules. Web-session descriptors remain provider-owned
(`src/lib/webSessionProviders.ts:9+`) with check/connect routes at
`Kernel/API/src/routes/oauth.ts:545-715`. Validation strategies are declared beside factories
(`Kernel/API/src/core/own-provider-adapters.ts:68-108`, `service.ts:737-838`) and enforced at Check
(`service.ts:4627-4654`). OH's OpenCode free-tier stack still exceeds 9R's
(`Kernel/API/src/core/opencode-runtime.ts:281-410`). The 115 9R-only ids include `cursor`, `zed`,
`gemini-cli`, `grok-cli`, `glm`, `commandcode`, `mimo-free`, media vendors and cloud hosts, listed in
`docs/reports/parity-cycle-3-providers.md:200-230`. Do not copy 9R's browser impersonation/MITM stack.

---

## 7. Credentials, auth and security

OH's vault is unchanged and asserted: one credential-shape decision
(`Kernel/API/src/core/connections.ts:1682-1688,1752`), AES-256-GCM with scrypt and atomic write
(`:1369-1393`), hashed `ohk_` keys (`Kernel/API/src/core/api-keys.ts:99-125,499`). PKCE S256 is used
in Codex, Claude, Claude Code, MiniMax, Qoder and Kiro flows. The no-secrets, browser-storage and
dashboard-truthfulness guards passed within the 495-test repo suite; the only failure is the
release-trail test. 9router still stores provider credentials as plaintext JSON
(`9router/src/lib/db/schema.js:33-50`) but has richer sign-in
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
(`docs/architecture/provider-defects.md:1-16`) has 177 rows and 9 recorded defects.

---

## 9. Tests, CI and release discipline

OH's canonical gate is `pnpm verify` (`package.json:44`) run by CI
(`.github/workflows/verify.yml:44`). Its components were run separately here: repo suite 495 tests /
488 pass / **1 fail** / 6 skipped; gateway 1255/1255; SDK 967/967; catalog with explicit root 6/6.
The failing test is not cosmetic: `tests/release-trail.test.js:48-67` asserts that every tag's own
commit states the tag's version, and `v3.97.0` violates it because the commit has root/cli at
`3.96.0` while only `Kernel/API` was bumped. The working tree contains the root/cli bump to 3.97.0
but it is uncommitted, so `node scripts/check-version.mjs` passes (3.97.0) while the committed tag
still fails the offline guard. 9router has 456 Vitest files and a documented ~64-failure baseline
(`9router/CLAUDE.md:43-45`), no root `test` script (`9router/package.json:9-21`) and no CI workflow
that runs tests.

**Online release audit also fails**: `pnpm release:audit` exit 1 listing both `v3.96.0` and `v3.97.0`
as missing npm versions; `npm view` E404 for both. The GitHub release for `v3.97.0` exists
(`published_at: 2026-11-23T07:12:41Z`, verified via the GitHub API). 9router's manifest drift
persists (root `0.5.116`, CLI/CHANGELOG/tag `0.5.119`).

---

## 10. Internet findings

1. **Two tagged OH versions are absent from npm, while both have GitHub releases.** Registry latest
   is `3.95.0` (`https://registry.npmjs.org/@hilbras%2Fomnihilbras/latest`); both version-specific
   endpoints returned 404, `npm view` returned E404, and `pnpm release:audit` exited 1. GitHub has
   both releases (`https://api.github.com/repos/Hilbras/OmniHilbras/releases/tags/v3.96.0` and
   `.../v3.97.0`, the latter published `2026-11-23T07:12:41Z`). Action: fix the version bump, re-tag
   if needed, publish from `cli/`, then poll the registry. Publishing was forbidden by this ask.
2. **Codex CLI identity is ahead of 9router now.** `https://registry.npmjs.org/@openai%2Fcodex/latest`
   returned `0.171.0`, matching OH's pin (`Kernel/SDK/codex/adapter/index.ts:19`); 9router pins
   `0.167.1` (`9router/open-sse/providers/registry/codex.js:5`). No live turn was made.
3. **MCP transport alignment remains correct.** `https://modelcontextprotocol.io/specification/2025-11-25/basic/transports`
   names Streamable HTTP as the current transport; OH negotiates `2025-11-25` with a `2024-11-05`
   fallback (`Kernel/API/test/mcp-route.test.js:39-40,83-95`), and the new plugin bridge uses a
   separate supervised stdio child rather than letting a browser spawn commands
   (`Kernel/API/src/routes/mcpPlugins.ts:7,142-143`). No action needed.

---

## 11. Ranked, concrete improvement plan

1. **Repair the release trail before any further behavior work (high).**
   Files: `package.json:4`, `cli/package.json:3`, `Kernel/API/package.json:3`, `tasks/parity-loop/state.json`,
   `NPM-PUBLISH.md`.
   Behavior: commit the working-tree root/cli bump to 3.97.0 (or revert the tag to a commit whose
   manifests agree), confirm `git tag --points-at HEAD` names the version in all three manifests, run
   `node --test tests/release-trail.test.js` to green, publish from `cli/`, and poll
   `npm view @hilbras/omnihilbras@3.97.0 version` until it echoes 3.97.0. Also publish 3.96.0 only if
   its tagged source warrants it; do not add a `knownGaps` exemption for a fresh, repairable gap.
   Proving test: `node --test tests/release-trail.test.js` 1/1 pass, `pnpm release:audit` exit 0,
   and `npm view` for both versions. **Not performed in this report** (commit/publish forbidden).
2. **Give video a real adapter or keep the refusal honest (high).**
   Files: `Kernel/API/src/routes/video.ts:1-13,111,122`, new `Kernel/SDK/xai/adapter/video.ts`,
   `Kernel/API/src/server.ts:16,128,462`.
   Behavior: implement job creation and connection-bound poll for at least one provider that really
   serves video (9router's `xai` config at `9router/open-sse/providers/registry/xai.js:44`), while
   every other provider keeps `NOT_SUPPORTED` and no synthetic URL or completion is produced.
   Proving test: extend `Kernel/API/test/video-route.test.js` (242 lines, present) with a scripted
   video transport, a poll bound to the creating connection and an abort case.
3. **Close the highest-value remaining provider ids (high).**
   Files: new SDK packages, `Kernel/API/src/core/own-provider-adapters.ts`,
   `Kernel/API/src/core/service.ts:737-838`, `src/data/providers.ts`, `Kernel/Tools/src/caps.ts`.
   Behavior: next `cursor`, `gemini-cli`, `zed`, `glm`, `commandcode`; no measured claims on cards,
   declared validation strategies, real OAuth/device flows where 9router has them
   (`9router/src/lib/oauth/{providers,services}/<id>.js`), no anti-bot spoofing. Proving test:
   scripted adapter tests per id plus `tests/provider-cards.test.js`, `tests/tools-caps.test.js` and
   `tests/provider-oauth-routes.test.js` (green in this ask's repo suite apart from release trail).
4. **Resolve the `xai` lane mismatch (medium).**
   Files: `src/data/providers.ts:1535`, `Kernel/API/src/core/own-provider-adapters.ts:108`,
   `Kernel/SDK/xai/adapter/index.ts:1-136`, `Kernel/API/src/routes/oauth.ts`.
   Behavior: either add OAuth plus the Responses lane and state the image/video/search limits, or
   keep API-key-only and say in the card that those 9router lanes are not served. Proving test:
   extend `Kernel/SDK/tests/xai.test.js` and `tests/provider-oauth-routes.test.js` to assert the
   exact wire path and that no route is advertised unless implemented.
5. **Resolve the `kimi` product mismatch (medium).**
   Files: `src/data/providers.ts:1003`, `Kernel/API/src/core/own-provider-adapters.ts:93`,
   `src/components/AddProviderModal.tsx`, `docs/SPEC-SDK.md`.
   Behavior: one product per id — either point `kimi` at the coding endpoint with OAuth like
   `9router/open-sse/providers/registry/kimi.js:23-28`, or keep the Moonshot platform id and state
   that `kimi-code` is the coding subscription. Proving test: `tests/provider-cards.test.js` plus a
   gateway test asserting the request URL for a saved `kimi` credential matches the card endpoint.
6. **Add dashboard login lockout and SSO (medium, larger scope).**
   Files: new `Kernel/API/src/core/login-limiter.ts`, `dashboard-session.ts`,
   `Kernel/API/src/routes/api-keys.ts`, `src/components/Login.tsx`, `docs/SPEC-SDK.md`.
   Behavior: per-IP progressive lockout, OIDC authorization-code + PKCE S256 with exact redirect
   matching, scoped keys with model allow-lists, loopback binding by default. Proving test:
   `Kernel/API/test/login-limiter.test.js` and `oidc.test.js` with scripted discovery/token endpoints.
7. **Add CLI-tool configurator and translator inspector pages (medium).**
   Files: new `src/pages/CliToolsPage.tsx`, `src/pages/TranslatorPage.tsx`, `src/lib/routes.ts`,
   `src/dashboardApp.tsx:168-185`, `docs/SPEC-SDK.md`.
   Behavior: read existing gateway state only; no invented values and no timer-set success states.
   Proving test: extend `tests/dashboard-wiring.test.js` and `tests/dashboard-truthfulness.test.js`
   plus one Playwright spec against a fake gateway.
8. **Keep candidate-key checks honest and capability defaults bounded (low).**
   Files: `Kernel/API/src/core/own-provider-adapters.ts:87-108`,
   `Kernel/API/src/core/modelCapabilities.ts:8-28`, `tests/provider-validation.test.js`,
   `Kernel/API/test/model-capabilities.test.js`.
   Behavior: declare `validation:'models'` only with an evidence note about an authenticated catalog;
   otherwise keep `none` and say so in the UI. Add 9router-style family defaults only where upstream
   publishes them (`9router/open-sse/providers/capabilities.js:573-584`). Proving test: bogus-key
   cases modeled on `9router/src/app/api/providers/validate/route.js:289-330,401-413`, plus a
   `supports_tools:false` catalog case.

**Not to copy:** plaintext credentials, public-catalog key validation, browser impersonation/MITM,
manifest version drift, a red-by-policy test baseline, and any simulated success. The safety rule in
`tasks/parity-loop/README.md:19-21` governs all eight items.
