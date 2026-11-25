# 9router parity, cycle 2 — whole-system comparison (re-measured at current commits)

**Step 1 of `tasks/parity-loop/README.md`.** This path already held an earlier cycle-2 measurement
taken at `bcd6222d`/`3.96.0` (505-line-excerpt read at `:1-80` before writing). The ask names this
exact path, so this re-measurement replaces it; the earlier measurement's conclusions are summarised
in §1 and §12 rather than silently discarded. No source, tag, release or package was modified.

| Tree | Commit read | Version | Working tree |
| --- | --- | --- | --- |
| OmniHilbras (OH) | `3e4088f966df0d64b26cca3c60c95062c68e175c` (2026-11-23 14:00:01 +0300, "Parity cycle 1: Implemented all nine DO items…") | working tree `3.98.0` in `package.json:4`, `Kernel/API/package.json:3`, `cli/package.json:3`; `git show HEAD:package.json` also `3.98.0` | dirty with cycle-1/cycle-5/cycle-6 implementation slices: modified Codex tests, provider-defect register/generator, `tasks/parity-loop/state.json`; new `Kernel/API/src/routes/translators.ts`, `Kernel/Tools/src/toolCloaking.ts`, MCP-plugin routes, operator pages, `docs/reports/parity-cycle-2-providers.md`, `parity-cycle-6-system.md` |
| 9router (9R) | `1855aa44473e88feac9d3f131b9c0c5fc9706b68` (2026-11-12 18:50:35 +0700, `# v0.5.119`) | root `0.5.116` (`package.json:3`), CLI `0.5.119` (`cli/package.json:3`), CHANGELOG `0.5.119` (`CHANGELOG.md:1`) | untracked lockfiles only |

Commands that established this (run in this ask):

```
git log -1 --format='%H %ad %s' --date=iso && git status --short && grep -n '"version"' package.json Kernel/API/package.json cli/package.json
git show HEAD:package.json | grep '"version"'        -> "version": "3.98.0",
git tag --points-at HEAD                              -> v3.96.0
git -C /mnt/sda3/work/projects.old/9router log -1 ... -> 1855aa44…
```

`git tag --points-at HEAD` returning **`v3.96.0`** while the tagged commit's own manifest says
**`3.98.0`** is the concrete release-trail defect of this cycle; it is not a reading error.

**Checks actually run here** — `pnpm verify` was **not run**, as instructed:

```
node scripts/check-version.mjs
  -> "version check passed: 3.98.0", exit 0
node --test tests/*.test.js
  -> exit 1; tests 505, pass 498, fail 1, skipped 6, duration 16051.884023 ms
     failing: tests/release-trail.test.js:48 "every tag states the version its own commit carries"
     detail: [ 'v3.96.0: its package.json says 3.98.0' ]
node --test tests/release-trail.test.js
  -> same failure at :67
pnpm --filter @omnihilbras/kernel-api test
  -> exit 0; tests 1258, pass 1258, fail 0, duration 85421.953022 ms
node --test Kernel/SDK/tests/*.test.js
  -> exit 0; tests 982, pass 982, fail 0, duration 42989.520864 ms
node --test tests/no-secrets.test.js tests/browser-storage.test.js tests/gateway-routes.test.js tests/tools-caps.test.js tests/dashboard-truthfulness.test.js tests/ui-performance.test.js
  -> tests 39, pass 39, fail 0
pnpm release:audit
  -> exit 1: 178 tag(s), 265 npm versions, 178 GitHub releases;
     "release trail is broken: v3.98.0 has no npm version"
```

Not run: `pnpm verify`, Playwright, `pnpm app:smoke`, 9router's Vitest suite, any build, and any
live provider request (no credential is available). Passing local tests are scripted transports, not
live vendor turns. Exact suite outputs are in `/tmp/cycle2-repo-tests.txt`,
`/tmp/cycle2-gateway-tests.txt`, `/tmp/cycle2-sdk-tests.txt` and `/tmp/cycle2-release-audit.txt`
from this ask.

---

## 1. Verdict and scorecard

Functional parity improved substantially since the earlier cycle-2 measurement: `smart`/`fusion`
routing, complete Responses SSE, `/v1/fetch`, `/v1/videos/*` with a real xAI adapter, current MCP
negotiation, tool cloaking, an MCP plugin bridge, redacted request details, operator dashboard pages
and a provider-defect register now exist in this tree (some uncommitted). **Release discipline
regressed again**: the tag on `HEAD` names a different version from its manifest, the offline
release-trail guard is red, and `v3.98.0` has a GitHub release but no npm version.

Scale from `docs/reports/9router-parity-scorecard.md:24-25`: 0 absent, 1 declared but broken,
2 common case, 3 with guards, 4 measured across providers with regression tests, 5 better than reference.

| # | Criterion | 9R | OH | OH ≥ 9R? | Evidence |
| --- | --- | --- | --- | --- | --- |
| 1 | Working provider coverage on live requests | 3 | 3 | = | §6; 148 vs 69 declared ids, no live calls either side |
| 2 | Credential validation: real probe vs public catalog | 3 | 4 | yes | §7; declared strategies + 1-token probes; 9R `9RV` public-catalog checks |
| 3 | Model-ID / upstream-ID / capability mapping | 4 | 4 | = | §5; first-slash + catalog upstream ids, `supports_tools` parsed; 9R tier/family defaults richer |
| 4 | Tool calling breadth and reliability | 4 | 4 | = | §5; OH asserted contract + cloaking + MCP bridge; 9R per-provider repairs |
| 5 | Failover and multi-account rotation | 4 | 4 | yes | §3; `smart`/`fusion` in `virtual-models.ts:16,123` and `service.ts:4451-4716`; 9R capacity adapter still unmatched |
| 6 | Streaming / protocol surfaces | 4 | 3 | **no** | §5; video is real for xAI, but `/systemone` is absent and no cross-provider live measurement exists |
| 7 | Web-session / free-tier / special providers | 4 | 3 | **no** | §6; 108 registry ids lack an OH counterpart |
| 8 | Observability: honest records, failure reasons, logs | 3 | 4 | yes | §8; no prompt/header fields in usage, redacted request details |
| 9 | Dashboard and operator surfaces | 4 | 3 | **no** | §9; OH now has translator/MITM/proxy/tunnel/skills pages, still no CLI-tool configurators |
| 10 | Security at rest and in browser | 2 | 4 | yes | §7; 39/39 guards passed here; 9R provider secrets plaintext |
| 11 | Test/CI gate that actually runs and fails | 2 | 4 | yes | 1258 + 982 green, repo suite red on one release-trail case, so not 5 |
| 12 | Release discipline and audit trail | 2 | 1 | **no** | §10; tag/manifest mismatch + `v3.98.0` absent from npm |

Rows 6, 7, 9 and 12 keep the loop running. Row 12 is the same class of regression the earlier
cycle-2 report first identified, now with different version numbers.

---

## 2. Architecture

**OH.** Plain Node `http` gateway with no web framework. Every request gets a request id before
any handler (`Kernel/API/src/server.ts:203`), then loopback `Host` → 421, exact CORS → 403,
cross-site → 403 and an auth context decided from allowlisted origin + per-launch token
(`server.ts:206-217`). Route dispatch imports video, MCP plugins and translators explicitly
(`server.ts:16,36,38,136-139`), and `MANAGEMENT_PREFIXES` now includes `/v1/fetch` and
`/v1/translators` (`server.ts:423-426`). Build order remains SDK → TokenSaver → Tools → API →
frontend → CLI (`package.json:24-44`).

**9R.** Next.js 16 standalone wrapped by a custom server that monkey-patches `http.createServer`
(`9router/custom-server.js:7,55,71,75`) and rewrites `/v1/* → /api/v1/*`
(`9router/next.config.mjs:73-108`). The engine is documented as standalone but still imports app
modules (`open-sse/handlers/chatCore.js:15`, prior report).

**Difference that still matters:** OH's guard set is central and asserted; 9R's peer-token/IP trust
depends on using the custom server entry point, a defect with a recorded GHSA history
(`9router/CHANGELOG.md:602-610` as read in cycle 1). OH has no standalone embeddable router package
equivalent to `open-sse/`.

---

## 3. Routing and failover

**OH.** `resolveRoute()` filters enabled + credentialed connections, sorts quota tier → priority →
name, rotates balanced/`fastest` candidates, pins a named account, and returns named skip reasons
(`Kernel/API/src/core/routing.ts:669-817`); the provider-id/connection-id alias guard at `:768-783`
keeps one account's failure from ejecting siblings. `RequestExecutor` and `HedgePolicy` remain
(`request-executor.ts:178`, `hedge-policy.ts:56`).

**Virtual models closed the earlier gap.** The strategy union now includes `smart` and `fusion`
(`virtual-models.ts:16,123,136-149`; fusion requires a concrete `judgeModel` at `:145-149`).
`service.ts:4451-4460` resolves the smart router choice with confidence and bounded session
stickiness; `:4591-4716` builds an anonymised fusion judge with quorum/grace/timeout and a named
refusal when no panel member is enabled. The user-facing cost disclosure is in
`src/pages/ModelsPage.tsx:34-35,467-471`.

**9R still ahead on two routing behaviors.** Its capacity adapter adds a model when the requested
one lacks a required capability (`9router/src/sse/handlers/chat.js:20,168-183`,
`open-sse/services/capacityAdapter.js`), and account fallback uses config-driven text/status rules,
exponential backoff and per-model locks (`open-sse/services/accountFallback.js:9-70,231`). OH has
no equivalent of either; its failover is terminal-code/ledger based but does not choose a different
model for a missing capability.

---

## 4. Provider onboarding, model IDs and capabilities

Counts recomputed here:

```
OH cards = 69 ; 9R registry entry files (excluding generated index.js) = 148
shared = 40 ; OH-only = 29 ; 9R-only = 108
```

Commands: `rg -o "id: '[a-z0-9-]+'" src/data/providers.ts | sed … | sort -u | wc -l` and
`find open-sse/providers/registry -maxdepth 1 -name '*.js' ! -name index.js …`, followed by
`LC_ALL=C comm -12/-13/-23`.

**Onboarding.** OH registers factories with a declared validation beside each
(`Kernel/API/src/core/own-provider-adapters.ts:68-121`, `Kernel/API/src/core/service.ts:737-835`).
9R uses declarative registry entries with a generated import index
(`9router/open-sse/providers/registry/index.js:1`) plus 43 executors. The full five-dimension matrix
for all 40 shared ids is in `docs/reports/parity-cycle-1-providers.md` and its cycle-3/cycle-4
successors; the current slice added `xai`, `claude`, `glm`, `glm-cn` and the video flow.

**Defect register is now a guard, not prose.** `docs/architecture/provider-defects.md:1-20` has
177 rows (69 OH cards + 108/148 9R ids) and 10 recorded defects, generated by
`scripts/build-provider-defects.mjs:34-105`; `tests/provider-cards.test.js:463-469` fails when a new
card has no row. It records `xai` video as fixed, `claude` PKCE flow as fixed, `glm`/`glm-cn` as
partial (keyed OpenAI-compatible chat only), and `gemini-cli`/`cursor`/`zed` as gaps.

**Model identity.** OH strips only a connected provider's first-slash prefix
(`routing.ts:533-552`, `:556-568`), uses a normalised comparison key (`:573-579`), and sends a
catalog `upstreamModelId` when present (`service.ts:1043-1049`, call sites `:4033,4072,4123`).
`supports_tools`/`supports_thinking` from upstream catalogs are parsed
(`Kernel/SDK/openai/lib/model-normalize.ts:87-88`). 9R's `getModelUpstreamId` still rewrites
thinking tiers and suffix variants (`9router/open-sse/config/providerModels.js:95-133`) and its
regex family defaults are richer (`open-sse/providers/capabilities.js:573-584`, prior report).

---

## 5. Tool calling, streaming and protocols

**Tool contract.** One table says whether a provider serves tools and whether forcing is possible
(`Kernel/Tools/src/caps.ts:43,90,105,110,126-130,148`). A declared-but-unserved tool is a named
refusal before any provider call (`Kernel/API/src/core/service.ts:3905-3907`). Tool ids are healed
deterministically (`Kernel/Tools/src/toolHistory.ts:14-58`). OH now has deterministic Claude
cloaking with decoys and a restore map (`Kernel/Tools/src/toolCloaking.ts:24-25,43-102`,
tested by `Kernel/API/test/tool-cloaking.test.js`), closing the earlier 9R-only gap. The gateway
also exposes a bounded stdio→SSE MCP plugin bridge (`Kernel/API/src/routes/mcpPlugins.ts:26-28`,
`mcp-plugins.json` registry, 50k character cap).

**Streaming.** `/v1/chat/completions` writes one `[DONE]` only after a clean loop; a mid-stream
failure emits `event: error` with no sentinel (`Kernel/API/src/routes/inference.ts:949-1054`).
`/v1/messages` reframes Anthropic SSE with indexed content blocks and tool deltas (`:553-727`).
Responses now opens with `response.created` and `response.in_progress`, emits reasoning summary
parts, `response.output_text.done`, tool item events and either `response.completed` or
`response.failed` (`:630-811`) — matching the event set that was missing in cycle 1. 360 s idle /
1800 s absolute budgets remain explicit (`Kernel/API/src/core/config.ts:25-37,152-153`), matching 9R's
`STREAM_STALL_TIMEOUT_MS` (`9router/open-sse/config/runtimeConfig.js:53`).

**Video/fetch.** `/v1/videos/*` creates and polls real xAI jobs bound to the creating connection
(`Kernel/API/src/routes/video.ts:2-11,31,86,132`; `Kernel/SDK/xai/adapter/index.ts:87-135`),
and every other provider receives `NOT_SUPPORTED` (`:111-122`). `/v1/fetch` exists
(`Kernel/API/src/routes/fetch.ts:19-23`) with an explicit public-destination guard. `/v1/mcp`
negotiates `MCP-Protocol-Version`, validates `Origin`, refuses GET with an explicit 405, and
answers notifications with 202 (`mcp.ts:92-162`).

**Remaining protocol gap:** no `/v1/systemone` gateway route exists. OH's only mentions of
`systemone` are upstream-lane notes in `docs/SPEC-SDK.md:1068,1083,1152,1235`; 9router serves it at
`9router/src/sse/handlers/systemone.js:11`. No live cross-provider streaming comparison was made.

---

## 6. Web sessions, free tiers and special providers

OH web-session descriptors and check/connect routes cover ChatGPT, Qwen, DeepSeek, Gemini, Grok,
Perplexity, Token Harbor, ZCode and Duck.ai (`src/lib/webSessionProviders.ts`,
`Kernel/API/src/routes/oauth.ts:545-725`); their caps rows are `web: true, tools: false` by contract
(`Kernel/Tools/src/caps.ts:110,130`). 9R has `chatgpt-web`, `deepseek-web`, `gemini-web`, `muse-web`,
`uc-web` and `veoaifree-web` executors plus TLS/browser impersonation
(`9router/CHANGELOG.md:121`) — not copied here by policy (`tasks/parity-loop/README.md:19-21`).

**OpenCode free tier remains OH's strongest special-provider asset**: local service discovery,
gateway-installed runtime, `/proc`-based adoption of its own orphan, streamed
`session.text.delta`/`session.reasoning.delta`, and deny-first read-only tools with documented
`external_directory` exposure (`Kernel/API/src/core/opencode-runtime.ts:288-438`,
`Kernel/API/src/core/opencode-service.ts`, `AGENTS.md` Boundaries). The defect register records this
as "documented and mitigated" (`docs/architecture/provider-defects.md` `opencode-console` row).

The 108 9R-only ids include 15 OAuth ids (`cursor`, `gemini-cli`, `zed`, `windsurf`, `trae`, `claude`,
`glm`, `xai`, `xiaomi-mimo`, …), 3 free ids, 15 free-tier ids, 2 web-cookie ids and 82 apikey ids;
the register marks `gemini-cli`, `cursor` and `zed` as explicit parity gaps.

---

## 7. Credentials, auth and security

OH keeps `api-key | oauth | none` credentials in an AES-256-GCM vault with scrypt, random salt/IV
and atomic write (`Kernel/API/src/core/connections.ts:1369-1393`), one `storedCredential()` for
writer and reader (`:1682-1688,1752`), `ohk_` keys hashed and constant-time compared
(`api-keys.ts:99-125,499`), and declared validation strategies beside factories
(`own-provider-adapters.ts:68-121`). PKCE S256 is used for Codex, Claude Code, MiniMax, Qoder,
Kiro and the newly added `claude` flow (`codexOAuth.ts:161-179`, `Kernel/SDK/claude-code/adapter/index.ts:430-474`).
Browser storage allows exactly two non-secret keys; the guard passed here (39/39), as did the
secret scan, route/spec check, tool caps, dashboard truthfulness and UI performance guards.

9R stores provider connections as a plaintext `data TEXT` JSON column
(`9router/src/lib/db/schema.js:33-50`), has bcrypt + 24 h JWT dashboard sessions and login lockout
(`9router/src/lib/auth/dashboardSession.js:1-2,61-81`, `loginLimiter.js:1-51`) plus OIDC/SAML
(`oidc.js`, `saml.js`). OH still has no dashboard login, lockout, OIDC/SAML or per-key model
allow-list; `Workspaces` are metadata labels (`Kernel/API/src/core/workspaces.ts:6-28`), not tenants.
The accepted limitations are documented in `SECURITY.md` and `AGENTS.md`.

---

## 8. Dashboard and observability

OH now mounts 16 dashboard routes (`src/dashboardApp.tsx:173-191`): the original providers/models/
routing/keys/usage/logs/settings/about/token-saver pages plus MITM, proxy pools, tunnels, skills
and translators (`src/pages/MitmPage.tsx`, `ProxyPoolsPage.tsx`, `TunnelsPage.tsx`,
`SkillsPage.tsx`, `TranslatorPage.tsx`), with nav entries at
`src/components/DashboardShell.tsx:78-85`. The translator page is backed by a read-only
`GET /v1/translators` inventory (`Kernel/API/src/routes/translators.ts:6-25`). Honesty and
performance guards pass here (`tests/dashboard-truthfulness.test.js`, `tests/ui-performance.test.js`).
9R still leads on CLI-tool configurators for ~30 clients and Monaco-based editors
(`9router/src/app/(dashboard)/dashboard/cli-tools/…`, 16 top-level sections).

**Observability.** Usage records have no field capable of holding a prompt, response, header or
credential (`Kernel/API/src/core/usage-store.ts:9-31`), with an ordered attempt ledger (`:33-50`).
Redacted request details exist as a separate store: sanitised error text, tool names, schema byte
counts, no prompt/response/header/credential (`Kernel/API/src/core/request-details.ts:14-73`).
The Logs page merges 24 h history with a 500-event live stream and 20-row paging
(`src/pages/LogsPage.tsx:5-63`). 9R's `requestDetailsRepo.js:7,122-130` stores payloads with a
5 KiB cap and plaintext credentials elsewhere.

---

## 9. Tests, CI and release discipline

**OH gates.** `package.json:44` defines `verify` as version → brand → typecheck → tests → SPEC →
build → CLI smoke → bundle budget; `.github/workflows/verify.yml:44` runs that exact command, with
separate e2e and release-audit workflows. In this ask: repo suite 505 tests with **one real failure**
(`tests/release-trail.test.js:48`), gateway 1258/1258, SDK 982/982, and 39/39 selected guards.
`pnpm verify` was not run because the ask forbids it; given the red offline guard, it cannot be
claimed green.

**OH release trail.** 178 tags; `git tag --points-at HEAD` is `v3.96.0` while `HEAD`'s manifest
says `3.98.0`; release-trail test reports `v3.96.0: its package.json says 3.98.0`.
`pnpm release:audit` exits 1 on `v3.98.0 has no npm version`. `scripts/audit-release-trail.mjs:57-86`
records unrecoverable gaps including `3.70.0` and `3.96.0`.

**9R tests/CI.** 456 `*.test.js` files (`find tests -name '*.test.js' | wc -l`), no root `test`
script (`package.json:9-21`), no CI workflow running tests (`.github/workflows/` has only Docker,
GitBook and tray binaries), and a documented ~64-failure baseline with a manual
`tests/__baseline__/verify-no-regression.mjs` not wired into CI. Root/CLI/CHANGELOG versions diverge
(`0.5.116` / `0.5.119` / `0.5.119`).

---

## 10. Internet findings (trees cannot supply these)

1. **OH's published tip is 3.97.0, not 3.98.0.** `https://registry.npmjs.org/@hilbras%2Fomnihilbras/latest`
   returned `"version": "3.97.0"`; `https://registry.npmjs.org/@hilbras%2Fomnihilbras/3.96.0` and
   `…/3.98.0` both returned HTTP 404. GitHub does have both releases:
   `https://api.github.com/repos/Hilbras/OmniHilbras/releases/tags/v3.96.0` → `published_at`
   `2026-11-23T03:21:17Z`; `…/tags/v3.98.0` → `2026-11-23T09:58:40Z`. This confirms the release
   audit's `v3.98.0 has no npm version` and closes `v3.96.0` as an npm gap.
2. **Codex identity is now OH-ahead.** `https://registry.npmjs.org/@openai%2Fcodex/latest` returned
   `"0.171.0"`. OH pins `0.171.0` (`Kernel/SDK/codex/adapter/index.ts:19`) while 9R still pins
   `0.167.1` (`9router/open-sse/providers/registry/codex.js:5`). No live Codex request was made.
3. **MCP's current HTTP transport remains Streamable HTTP.** `https://modelcontextprotocol.io/specification/2025-11-25/basic/transports`
   says the server MUST provide one endpoint supporting POST and GET, MUST validate `Origin`, and
   clients MUST send `MCP-Protocol-Version`; OH's `/v1/mcp` now implements those checks and returns
   an explicit 405 for GET because it offers no server-initiated stream
   (`Kernel/API/src/routes/mcp.ts:92-162`), which the spec permits.

---

## 11. Ranked, concrete improvement plan

Ordered by release risk first, then user-visible functional gaps. Every item names files, the
behavior to add and a proving test. No item was implemented by this report.

1. **Repair the release trail before any functional work (high).**
   Files: `tasks/parity-loop/state.json`, `scripts/audit-release-trail.mjs:57-86`,
   `tests/release-trail.test.js:48,67`, `package.json:4`, `Kernel/API/package.json:3`,
   `cli/package.json:3`. Behavior: make the tag on `HEAD` name the version the commit declares, ship
   the missing npm version from `cli/` only after the GitHub release exists, poll
   `npm view @hilbras/omnihilbras@3.98.0 version`, and record `3.96.0` (and any other unrecoverable
   gap) with a reason rather than republishing stale code. **Proving test:** rerun
   `node --test tests/*.test.js` to 0 failures and `pnpm release:audit` to exit 0; both were red
   here with the exact outputs quoted in §0 and §9.

2. **Serve `/v1/systemone` (high).**
   Files: new `Kernel/API/src/routes/systemone.ts`, `Kernel/API/src/server.ts:16,136-139,423`,
   `docs/SPEC-SDK.md` (route line required by `tests/gateway-routes.test.js`). Behavior: accept a
   decision-model request, resolve through the same gateway key/ledger/failover path, and return the
   provider's decision shape; a provider without the lane answers a named `NOT_SUPPORTED`, never a
   fabricated decision. **Proving test:** `Kernel/API/test/systemone-route.test.js` with a scripted
   adapter asserting the request body, the gateway key gate, the usage record and the refusal case.
   Reference: `9router/src/sse/handlers/systemone.js:11`, `open-sse/handlers/systemoneCore.js`.

3. **Add the capacity adapter and per-model fallback locks (high).**
   Files: `Kernel/API/src/core/routing.ts:669-817`, `Kernel/API/src/core/routing-engine.ts`,
   `Kernel/API/src/core/service.ts:4451-4716`, `src/pages/RoutingPage.tsx`. Behavior: when a request
   needs a capability the selected model lacks (vision, tools, long context), let an operator-
   declared adapter model be inserted ahead of it without lying about the requested model; and
   serialize retries per model rather than per provider so two accounts of one provider do not
   collide on one lock. **Proving test:** extend `Kernel/API/test/virtual-models-routing.test.js`
   and `Kernel/API/test/routing-engine.test.js` with two concurrent requests for the same model on
   different connections, plus a capability-mismatch case that asserts the upstream model id is the
   adapter's and the usage record names the requested id. References:
   `9router/src/sse/handlers/chat.js:20,168-183`, `open-sse/services/capacityAdapter.js`,
   `open-sse/services/accountFallback.js:9-70,231`.

4. **Close the three explicitly recorded CLI/OAuth gaps (medium).**
   Files: new `Kernel/SDK/<gemini-cli|cursor|zed>/adapter/`, `Kernel/API/src/routes/oauth.ts`,
   `Kernel/API/src/core/own-provider-adapters.ts:68-121`, `src/data/providers.ts`,
   `Kernel/Tools/src/caps.ts`, `scripts/build-provider-defects.mjs:34-105`. Behavior: implement the
   real OAuth/device flows and chat wire for `gemini-cli`, `cursor` and `zed`, then flip those defect
   rows from `gap — parity backlog` to `fixed` with source and test. Do not copy browser
   impersonation or MITM. **Proving test:** one scripted adapter test per id plus
   `tests/provider-cards.test.js`, `tests/tools-caps.test.js` and `tests/provider-oauth-routes.test.js`;
   `node scripts/build-provider-defects.mjs --check` must still pass.

5. **Add dashboard login/lockout and scoped keys (medium).**
   Files: new `Kernel/API/src/core/login-limiter.ts`, `Kernel/API/src/core/dashboard-session.ts`,
   `Kernel/API/src/routes/api-keys.ts`, `src/components/Login.tsx`, `docs/SPEC-SDK.md`. Behavior:
   per-IP progressive lockout, OIDC authorization-code + PKCE S256 with exact redirect matching, and
   per-key model allow-lists; loopback binding stays the default. **Proving test:**
   `Kernel/API/test/login-limiter.test.js` and `oidc.test.js` with scripted discovery/token
   endpoints, plus a rejected non-allowlisted redirect case. Reference:
   `9router/src/lib/auth/{dashboardSession,loginLimiter,oidc,saml}.js`.

6. **Add CLI-tool configurator pages (medium).**
   Files: new `src/pages/CliToolsPage.tsx`, `src/lib/routes.ts`, `src/dashboardApp.tsx:173-191`,
   `src/components/DashboardShell.tsx:78-85`, `docs/SPEC-SDK.md`. Behavior: show only values the
   gateway already returns, write back through existing routes, and set no state in a timer.
   **Proving test:** extend `tests/dashboard-wiring.test.js` and
   `tests/dashboard-truthfulness.test.js`, plus one Playwright spec against a fake gateway.
   Reference: `9router/src/app/(dashboard)/dashboard/cli-tools/`.

7. **Port 9R's tier/suffix-aware model-id rewrite (low).**
   Files: `Kernel/API/src/core/routing.ts:573-579`, `Kernel/API/src/core/service.ts:1043-1049`,
   `Kernel/SDK/openai/lib/model-normalize.ts:87-88`. Behavior: when the catalog supplies tiered
   variants, resolve `model(level)` to the tiered upstream id and re-append the level, as 9R does;
   keep first-slash prefix semantics. **Proving test:** extend
   `Kernel/API/test/model-meta-round-trip.test.js` and `Kernel/API/test/model-capabilities.test.js`
   with a tiered id and an explicit `supports_tools:false` row. Reference:
   `9router/open-sse/config/providerModels.js:95-133`.

**Explicitly excluded:** plaintext credential storage, public-catalog key validation, anti-bot/TLS
spoofing, a red-by-policy test baseline, version drift between manifests, and any test presented as a
live provider request. The parity loop's safety rule (`tasks/parity-loop/README.md:19-21`) governs all
seven items.

---

## 12. Earlier cycle-2 measurement, summarised for continuity

The report this replaced measured `bcd6222d`/`3.96.0` with 9router at the same `1855aa4`. It recorded
490 repo tests (486 pass, 4 skipped), 1233 gateway tests, 956 SDK tests, 42 selected guards, and
`pnpm release:audit` exiting 1 because `v3.96.0` had no npm version. Its scorecard had rows 6, 7, 9
and 12 behind (row 12 a new regression). Those conclusions remain in the scorecard history at
`docs/reports/9router-parity-scorecard.md`; the current measurement above supersedes their numbers.
No source, tag, release or package was changed by this re-measurement.
