# 9router parity, cycle 1 — whole-system comparison at the current commits

A fresh step-1 comparison of the two trees as they stand now. This report supersedes the earlier
cycle-1 report written at OH `632eb79a` / `3.95.0`; both trees have moved since, and the working tree
is no longer clean. It covers architecture, routing and failover, provider onboarding, credentials,
model IDs and capabilities, tool calling, streaming protocols, web-session and free-tier providers,
dashboard, observability, security, tests/CI and release discipline, and ends with a ranked concrete
improvement plan.

## Trees read

| Tree | Commit read | Version | Working-tree state |
| --- | --- | --- | --- |
| OmniHilbras (OH) | `3e4088f966df0d64b26cca3c60c95062c68e175c` (2026-11-23 14:00:01 +0300) | `3.98.0` in all three manifests (`package.json:4`, `Kernel/API/package.json:3`, `cli/package.json:3`) | **dirty**: 20 tracked files modified, 12 untracked source/report files (see below) |
| 9router (9R) | `1855aa44473e88feac9d3f131b9c0c5fc9706b68` (2026-11-12 18:50:35 +0700, `# v0.5.119`) | root `0.5.116` (`package.json:3`), CLI `0.5.119` (`cli/package.json:3`), CHANGELOG `0.5.119` | two untracked lockfiles only |

Commands that established this (run in this ask):

```
cd /mnt/sda3/work/Hilbras/OmniHilbras && git rev-parse HEAD && git log -1 --format='%H %ci %s' && git status --short
cd /mnt/sda3/work/projects.old/9router && git rev-parse HEAD && git log -1 --format='%H %ci %s' && git status --short
grep -n '"version"' package.json Kernel/API/package.json cli/package.json
grep -n '"version"' /mnt/sda3/work/projects.old/9router/package.json /mnt/sda3/work/projects.old/9router/cli/package.json
```

OH has advanced 9 commits since the earlier cycle-1 measurement (`git log --oneline v3.95.0..HEAD | wc -l`
→ `9`), including committed `smart`/`fusion` virtual models, a real xAI video adapter, a redacted
request-detail store, MCP Streamable HTTP and a fixed 9router catalog guard. 9router is at the same
commit it was at for the previous comparison. The **uncommitted** OH working tree adds routing/config
changes, a System One route, a translators route and dashboard page, and Claude tool cloaking; it also
introduces two red checks (§13). This report describes the checkout as it stands and marks which
findings exist only in uncommitted files.

Untracked OH source files (from `git status --short`): `Kernel/API/src/routes/systemone.ts`,
`Kernel/API/src/routes/translators.ts`, `Kernel/API/test/tool-cloaking.test.js`,
`Kernel/API/test/translators-route.test.js`, `Kernel/Tools/src/toolCloaking.ts`,
`Kernel/Tools/test/toolCloaking.test.js`, `src/pages/TranslatorPage.tsx`,
`tests/e2e/translators.spec.ts`, plus three parity report files and `.zcode/`.

## Checks actually run in this ask

Nothing below is claimed as passed unless the command was executed here. `pnpm verify` was **not**
run (the ask forbids it); nor were Playwright, `pnpm app:smoke`, 9router's Vitest suite, or any live
provider request.

```
node --version                                  -> v26.13.1
node scripts/check-version.mjs                   -> "version check passed: 3.98.0", exit 0
node --test tests/*.test.js                      -> 505 tests, 497 pass, 2 fail, 6 skipped, EXIT=1
  failing: tests/documentation-counts.test.js:266 (architecture doc line counts stale)
  failing: tests/release-trail.test.js:48 (v3.96.0 tag vs manifest)
pnpm --filter @omnihilbras/kernel-api test       -> EXIT=1 at tsc:
  src/core/service.ts(5030,23): error TS2304: Cannot find name 'noCandidateMessage'.
  (no gateway tests executed because compilation failed)
node --test Kernel/SDK/tests/*.test.js           -> 982 tests, 982 pass, 0 fail, EXIT=0
node --test tests/9router-catalog.test.js        -> 6 tests, 0 pass, 0 fail, 6 SKIP (no explicit root)
NINEROUTER_ROOT=/mnt/sda3/work/projects.old/9router node --test tests/9router-catalog.test.js
                                                 -> 6 tests, 6 pass, 0 fail, EXIT=0
node --test Kernel/API/test/video-route.test.js   -> 7 tests, 7 pass, 0 fail
pnpm --filter @omnihilbras/kernel-api exec tsc -p tsconfig.json
                                                 -> one error: service.ts(5030,23) TS2304
pnpm release:audit                               -> exit 1: "v3.98.0 has no npm version"
  (178 tags, 265 npm versions, 178 GitHub releases; recorded gaps for 3.0.0–3.49.0,
   3.70.0 and 3.96.0)
node --test tests/no-secrets.test.js tests/browser-storage.test.js tests/gateway-routes.test.js
                                                 -> all three files green in the 497 passes above
```

The two red repo-suite tests and the gateway compile error are diagnosed in §13. Two of the three are
regressions in the uncommitted working tree; the release-trail failure exists at HEAD as well.

Counting commands run here:

```
OH provider cards: rg -o "id: '[a-z0-9-]+'" src/data/providers.ts | ... | sort -u | wc -l -> 69
9R registry entries: find open-sse/providers/registry -maxdepth 1 -name '*.js' ! -name index.js | wc -l -> 148
OH SDK directories: find Kernel/SDK -mindepth 1 -maxdepth 1 -type d | wc -l -> 57
9R OAuth modules: find src/lib/oauth -name '*.js' | wc -l -> 57
9R test files: find tests -name '*.test.js' | wc -l -> 456
9R dashboard sections: find 'src/app/(dashboard)/dashboard' -mindepth 1 -maxdepth 1 -type d | wc -l -> 16
```

---

## 1. Verdict

Neither tree is a superset of the other, and the loop's stop condition is not met.

- OH is ahead on **credential encryption at rest, browser secret hygiene, per-provider validation
  strategies, tool-contract honesty, redacted observability, a single CI gate that runs, and release
  bookkeeping conventions**. Since the earlier cycle-1 report it has also closed several functional
  gaps: `smart`/`fusion` virtual models are committed, video is a real xAI job lane, Responses streams
  carry the full lifecycle set, `/v1/fetch` exists, request details are redacted and bounded, MCP
  negotiates Streamable HTTP `2025-11-25`, and the 9router catalog guard runs when given an explicit
  root.
- 9R remains ahead on **declared provider breadth (148 registry ids vs 69 OH cards), special-provider
  OAuth/CLI wires, the operator dashboard's configurators and editors, richer capability family
  defaults, and dashboard login/SSO**. It is behind on credential storage (plaintext SQLite
  `data TEXT NOT NULL`, `9router/src/lib/db/schema.js:43`; usage `apiKey` column at `:120`) and on CI
  (no root `test` script, `9router/package.json:9-21`; no workflow runs tests).
- The **current working tree is red**: the gateway does not typecheck, and two repo guards fail.
  Release discipline has regressed for the second time in this loop: `v3.96.0` points at a commit
  whose manifest says `3.98.0`, and `3.98.0` is tagged and GitHub-released but absent from npm.
- Both trees are **unmeasured on live requests**: no live provider key was used. Every "works" below
  means implemented and covered by scripted/local tests.

### Scorecard (scale from `docs/reports/9router-parity-scorecard.md:24-25`)

| # | Criterion | 9R | OH | OH ≥ 9R? | Evidence |
| --- | --- | --- | --- | --- | --- |
| 1 | Working provider coverage on live requests | 3 | 3 | = | §6; 148 vs 69 declared, no live calls either side |
| 2 | Credential validation | 3 | 4 | yes | §8; declared strategies beside factories |
| 3 | Model-ID / upstream-ID / capability mapping | 4 | 4 | = | §5; both full-id then stripped; 9R regex family defaults richer |
| 4 | Tool calling breadth and reliability | 4 | 4 | = | §7; OH cloaking (untracked) + asserted refusals + MCP bridge |
| 5 | Failover and multi-account rotation | 4 | 4 | yes | §3; smart/fusion committed; 9R capacity adapter unmatched |
| 6 | Streaming / protocol surfaces | 4 | 3 | **no** | §7; video/fetch/systemone now served, but some Responses event families absent |
| 7 | Web-session / free-tier / special providers | 4 | 3 | **no** | §6; 148 vs 69 ids; OH stronger on OpenCode tier |
| 8 | Observability | 3 | 4 | yes | §10; redacted request details, no content fields |
| 9 | Dashboard and operator surfaces | 4 | 3 | **no** | §9; no CLI-tool configurator, editors or drag-and-drop combos |
| 10 | Security at rest and in browser | 2 | 4 | yes | §11; 9R plaintext credentials; OH guards green |
| 11 | Test/CI gate that runs and fails | 2 | 3 | yes | §12; OH gate exists but is red (2 repo failures + compile error) |
| 12 | Release discipline and audit trail | 2 | 1 | **no** | §13; repeated tag/version defect + 3.98.0 npm gap |

Rows 6, 7, 9 and 12 keep the loop running, plus the working-tree compile break in §13.

---

## 2. Architecture

**OH.** Plain Node `http` service, no web framework. Every request gets a 32-hex request id before
any handler (`Kernel/API/src/server.ts:207-209`); guard order is loopback `Host` → 421
(`server.ts:210-212`), exact CORS origin → 403 (`:216`), cross-site check → 403 (`:225`), then one
auth context from allowlisted origin and per-launch token (`:230`). Loopback binding is asserted
outside containers (`server.ts:295-297`). Build order is SDK → TokenSaver → Tools → API → frontend →
CLI (`package.json:24-33`); CI runs the same `pnpm verify` command (`package.json:44`,
`.github/workflows/verify.yml:44`).

**9R.** Next.js 16 standalone with a custom server that monkey-patches `http.createServer`
(`9router/custom-server.js:6-14`) and rewrites `/v1/*` to `/api/v1/*`
(`9router/next.config.mjs:73-112`). The engine claims to be standalone but imports app modules
(`9router/open-sse/handlers/chatCore.js:15`).

**Difference that matters.** OH's network-trust guards live in one place and are asserted; 9R's
depend on which server entry point was used. OH has no equivalent of 9R's standalone embeddable
engine package: a vendor that wants to embed only the router cannot do so from this tree.

## 3. Routing and failover

**OH.** `RoutingEngine.plan()` reads health, limiter and latency as injected questions
(`Kernel/API/src/core/routing-engine.ts:24-48`). `resolveRoute()` filters enabled and credentialed
connections, sorts by quota tier → priority → name, rotates balanced/fastest candidates, pins a named
account, and skips named reasons (`unhealthy`, `rate-limited`, `model-cooling-down`, `no-models`;
`Kernel/API/src/core/routing.ts:658-705`, skip reason union at `:6`). A provider pin is a fence: a pin
with no usable connection is refused rather than billed elsewhere (`routing.ts:876-883`). An explicit
provider prefix may only be taken by a connection whose id or slug owns it (`:677`, `:848`). Failure
wording distinguishes real quota/capacity refusals from other errors (`:422-465`). `RequestExecutor`
enforces deadlines, breaker and attempt ledger, and hedging is a separate policy (`hedge-policy.ts`).

Virtual combos are now first-class: strategy union `priority | round-robin | fastest | smart |
fusion` (`Kernel/API/src/core/virtual-models.ts:16,123-149`), `smart` requires a concrete router model
and does one real router turn with bounded session stickiness (`service.ts:379-381,4523-4611`),
`fusion` requires a judge model, anonymises panel answers and enforces quorum/grace/hard timeouts
(`service.ts:4615-4750`). 9R's equivalents are `fallback | round-robin | smart | fusion`
(`9router/src/sse/handlers/chat.js:109-165`) with an anonymised judge panel
(`9router/open-sse/services/combo.js:714-890`) and account rotation rules
(`9router/open-sse/services/accountFallback.js:9-75`).

**Remaining gap (medium).** 9R has a capacity adapter that adds candidate models when the requested
one lacks a required capability (`9router/src/sse/handlers/chat.js:167-178`). OH has no equivalent:
a request for a model without a capability fails instead of being routed to a capable sibling.

## 4. Provider onboarding and capabilities

**OH.** One private SDK package per provider with `adapter/` and vendored `lib/` (57 directories),
and a typed registration table carrying factory plus validation strategy
(`Kernel/API/src/core/service.ts:737-865`; strategies also in
`Kernel/API/src/core/own-provider-adapters.ts:61-121`). 69 catalog cards are catalog metadata only;
`tests/provider-cards.test.js` and `tests/provider-card-merge.test.js` assert that cards carry no
measured claims and that the merge changes only values the gateway actually reported.

**9R.** Declarative registry entries generate a static import index
(`9router/open-sse/providers/registry/index.js:1-80`) and 43 executors over `BaseExecutor`
(`9router/open-sse/executors/base.js:11-204`). Adding a provider is cheaper, but the knowledge is
spread across index, registry, models, capabilities, executor and tests.

**Gap (high).** 148 9R registry ids vs 69 OH cards. Missing high-value ids include `cursor`, `zed`,
`gemini-cli`, `grok-cli`, `commandcode`, `mimo-free`, `perplexity`, `together`, `fireworks`, `vertex`
and `bedrock`. 9R also has 57 OAuth modules (e.g. `cursor`, `antigravity`, `gemini-cli`, `xai`,
`zed`, `windsurf`, `trae`, `iflow`); OH's OAuth flows cover a smaller set. No live verification was
performed on either side, so raw counts are not a claim that all 148 work.

**Gap (medium).** Three shared ids disagree with 9R's product definitions: `xai` (9R has OAuth plus
image/video/search lanes; OH has chat + video), `kimi` (9R coding endpoint), and `glm` (9R Z.ai CLI
poll OAuth plus a second Claude-format transport; OH has an API-key-only slice at
`src/data/providers.ts:1360`, `own-provider-adapters.ts:115-121`).

## 5. Model IDs, upstream IDs and capabilities

**OH.** Prefix stripping splits on the first slash and only for a connected provider
(`Kernel/API/src/core/routing.ts:658-677`), `bareModelFor` removes only the dispatched provider's
prefix (`:688-695`), and `lookupModelId` normalises dots/dashes for comparison only (`:705`). The
full-id-then-bare-then-normalised search is used for per-model tool narrowing
(`Kernel/API/src/core/modelCapabilities.ts:8-28`, called at `routing.ts:66-67`). Catalog-declared
upstream ids are persisted and sent on dispatch (`service.ts:983-997`).

**9R.** `getModelUpstreamId` additionally rewrites thinking suffixes and tier variants
(`9router/open-sse/config/providerModels.js:95-133`), and family defaults are regex-driven
(`9router/open-sse/providers/capabilities.js:573-584`).

**Gap (low).** OH does not implement tier/suffix upstream-id rewriting and has fewer family defaults.
The working tree deliberately defers tier mapping because no OH catalog row currently states a tiered
upstream id; adding unmeasured context windows would be a truthfulness regression.

## 6. Web-session and free-tier providers

**OH.** Descriptors carry provider-owned instructions and paste/check routes for ChatGPT, Qwen,
DeepSeek, Gemini, Grok, Perplexity, Token Harbor and DuckDuckGo (`src/lib/webSessionProviders.ts:17,
63,111,142,179,220,257,296,329`). The OpenCode Console/Go free tier is integrated beyond 9R:
runtime discovery, opt-in install, `/proc`-based adoption of the gateway's own orphan, streamed
`session.text.delta`/`session.reasoning.delta`, a deny-first read-only tool allow list, and documented
read exposure (`Kernel/API/src/core/opencode-runtime.ts:24-55,180-242`, `opencode-service.ts`).

**9R.** Web executors for `chatgpt-web`, `deepseek-web`, `gemini-web`, `muse-web`, `uc-web`,
`veoaifree-web`; special/provider CLI wires such as `cursor.js`, `commandcode.js`, `antigravity.js`,
`mimo-free.js`, `zed.js`. Its `opencode` and `opencode-zen` executors have no equivalent
install/adopt/tool-scope story.

**Gap (high).** The 79-id breadth difference (§4) is concentrated here. Copying 9R's browser
impersonation, anti-bot and MITM stack is explicitly out of scope; the parcels in §15 take only the
wire knowledge, not the spoofing.

## 7. Tool calling and streaming protocols

**Tools.** OH's single table declares `tools`, `toolChoice` and `web` per id
(`Kernel/Tools/src/caps.ts:27-30,127-151`); `normalizeToolsRequest` refuses forced calls without
definitions; `applyToolContract` refuses declared-but-unserved tools before a provider call
(`Kernel/API/src/core/service.ts:3775-3805`). Deterministic call-id healing and local read-only tools
are asserted. Claude tool cloaking with suffixed names, unavailable decoys and a restore map is
present in the **uncommitted** `Kernel/Tools/src/toolCloaking.ts:19-30` and wired at
`service.ts:3848-4016`, echoing 9R's `open-sse/utils/claudeCloaking.js:58-169` without its forged
billing header or TLS impersonation. The supervised MCP plugin bridge spawns only registered ids with
`shell:false` (`Kernel/API/src/routes/mcpPlugins.ts:7,107-143`). `/v1/mcp` negotiates MCP
`2025-11-25` with a `2024-11-05` fallback and an `Accept` check
(`Kernel/API/src/routes/mcp.ts:8-23,100-113`).

**Streaming.** Failover is decided before the first byte; mid-stream failure emits `event: error`
without a false `[DONE]` (`Kernel/API/src/routes/inference.ts`). Responses SSE now emits
`response.created`, `response.in_progress`, `response.output_text.delta/.done`,
`response.output_item.added/.done`, `response.function_call_arguments.delta/.done`,
`response.reasoning_summary_part.added/.done`, `response.reasoning_summary_text.delta/.done`,
`response.completed` and `response.failed` (`inference.ts:630-811`). Idle/absolute budgets are 360 s
and 1800 s (`Kernel/API/src/core/config.ts:223-224`). `/v1/fetch` is served
(`Kernel/API/src/routes/fetch.ts:1-35`); `/v1/videos/*` is a real xAI asynchronous job lane with a
connection-bound poll (`Kernel/API/src/routes/video.ts:5-14,99-132`,
`Kernel/SDK/xai/adapter/index.ts:11-17,87-118`), and 7 scripted route tests passed here. A native
System One JSON lane exists in the uncommitted `Kernel/API/src/routes/systemone.ts:1-20` wired at
`Kernel/API/src/server.ts:39,143,427`, matching 9R's `src/sse/handlers/systemone.js`.

**Gap (medium): Responses event union.** The official OpenAI streaming event list (§14, internet
finding 3) includes `response.content_part.added/.done`, `response.refusal.delta/.done`,
`response.output_text.annotation.added` and the `response.file_search_call.*` /
`response.code_interpreter_call.*` families, none of which OH emits. A strict client waiting for
those events will see silence even when the turn succeeded.

## 8. Credentials and authentication

**OH.** `api-key | oauth | none` credentials, one `storedCredential()` for writer and reader
(`Kernel/API/src/core/connections.ts:678-694`), AES-256-GCM with scrypt, random salt/IV and atomic
write (`:1371-1382`), 0600 master key. Gateway keys are `ohk_` + 43 random chars, SHA-256 stored and
constant-time compared, with rpm/expiry at the gate (`Kernel/API/src/core/api-keys.ts:99-101,493,499,
510-514`). PKCE S256 is used in Codex, Claude, Claude Code, MiniMax, Qoder and Kiro flows. Validation
strategy is declared beside the factory so a Check button cannot silently validate against a public
`/models` endpoint. The no-secrets, browser-storage and dashboard-honesty guards were green in this
ask's repo suite.

**9R.** Provider connections are plaintext SQLite (`9router/src/lib/db/schema.js:43`), usage history
has an `apiKey` column (`:120`). Dashboard auth is bcrypt + 24 h JWT cookies
(`9router/src/lib/auth/dashboardSession.js`), per-IP progressive in-memory lockout
(`9router/src/lib/auth/loginLimiter.js:1-8,23-27`), OIDC with PKCE S256 (`oidc.js:100-105`) and SAML,
plus HMAC-keyed API keys with model allow-lists.

**Gap (medium): sign-in surface.** OH has no dashboard login, lockout, OIDC/SAML or per-key model
allow-list; workspaces are metadata labels. Acceptable for a loopback single-user gateway, behind 9R
on a shared host. Do not copy 9R's plaintext credential column.

## 9. Dashboard

**OH.** One React Router app at `/dashboard` with Providers, Models, Routing, Keys, Usage, Logs,
Settings, Token Saver, About, provider detail/usage, MITM, proxy pools, tunnels, skills and (in the
uncommitted tree) a translators inspector (`src/dashboardApp.tsx:151,190`, `src/lib/routes.ts:40-41`).
Card values may only come from measured state (`src/lib/providerCards.ts`), success states set in
timers fail `tests/dashboard-truthfulness.test.js:43-84`, and blur under sticky surfaces fails
`tests/ui-performance.test.js`. The page wrapper is deliberately not keyed on path.

**9R.** 16 top-level dashboard sections and 24 `page.jsx`/`page.js` files, including CLI-tool
configurators for ~30 clients, drag-and-drop combos, Monaco editors, translator inspector, media
providers, proxy pools, MITM, tunnels, PXPIPE, console logs, quota and a skill marketplace.

**Gap (medium).** OH has no CLI-tool configurator, Monaco editors or combo drag-and-drop. The
translator inspector is a read-only GET inventory, not 9R's request/response workbench.

## 10. Observability

**OH.** Usage records have no field that can hold a prompt, response, header or credential
(`Kernel/API/src/core/usage-store.ts:9-31`); a test scans record keys. Each record carries a request
id and an ordered attempt ledger with `dispatched` and error codes (`:33-50`). Redacted request
details are opt-in and bounded to 200 records / 7 days / 512 KiB, storing only request id, model,
provider, sanitised error line, tool names and schema byte counts
(`Kernel/API/src/core/request-details.ts:6-45`, route at
`Kernel/API/src/routes/observability.ts:34`). The Logs page merges 24 h history with a live stream.

**9R.** SQLite request-detail capture stores payloads with a 5 KiB JSON cap and retention trim
(`9router/src/lib/db/repos/requestDetailsRepo.js:7,122-130`) plus a console-log buffer and MITM views.
More debuggable, but it stores content.

**Gap (low).** OH's redacted view cannot diagnose an upstream 400 caused by a specific message shape;
adding that content would break the type-level guarantee, so any such view must stay a separate,
opt-in, bounded record.

## 11. Security summary

OH wins at rest and in the browser; 9R wins on sign-in breadth. The one OH-specific security risk
found in this ask is not in the crypto but in the working tree: a compile error (§13) prevents the
gateway from building at all, so none of the new routes can be shipped until it is fixed. Neither
tree had a live credential used in this comparison. 9R's SSRF guard is applied per call site
(`9router/src/shared/utils/ssrfGuard.js`); OH centralises origin checks in `server.ts:210-225`.

## 12. Tests and CI

**OH.** `pnpm verify` is the single canonical gate (`package.json:44`), run by CI with full history
and tags and `persist-credentials: false` (`.github/workflows/verify.yml:20-44`). Playwright is a
separate job; `release-audit.yml` is scheduled. In this ask the SDK suite was 982/982 green, the
catalog guard 6/6 with an explicit root, the video route 7/7 green, but the repo suite 497/505 with
two failures and the gateway suite did not compile. So the gate exists and runs, but is currently red.

**9R.** 456 `*.test.js` files and Vitest config, but no root `test` script
(`9router/package.json:9-21`), and none of the three workflows runs tests. `CLAUDE.md:43-49`
documents ~938 pass / ~64 fail as the expected baseline and a manual regression script not wired
into CI. OH's guard set is smaller but actually enforced.

## 13. Release discipline — current red gates

1. **Tag/version mismatch at HEAD.** `v3.96.0` resolves to `3e4088f9` (HEAD), whose `package.json`
   says `3.98.0`. `node --test tests/release-trail.test.js` therefore fails: `v3.96.0: its package.json
   says 3.98.0`. The repair commits `67fc9319` and `6a4484d4` fixed `v3.98.0` and `v3.97.0` but left
   `v3.96.0`. The correct repair is to move `v3.96.0` to `bcd6222d` (which carries 3.96.0 and is on
   `main`), not to downgrade any manifest.
2. **Working-tree compile regression.** `pnpm --filter @omnihilbras/kernel-api test` and a direct
   `tsc -p tsconfig.json` both stop at `src/core/service.ts(5030,23): error TS2304: Cannot find name
   'noCandidateMessage'.` The uncommitted `runSystemOne()` uses the constant exported by
   `Kernel/API/src/core/routing.ts:949` but never imports it; `request-executor.ts:2` does import it.
   No gateway test ran.
3. **Working-tree doc-count regression.** `tests/documentation-counts.test.js:266` fails because
   `docs/architecture/README.md:73,78` states line counts (817, 5130) that the modified files no
   longer have (949, 5237; also `inference.ts` 1758→1766 and `server.ts` 486→490).
4. **npm gap.** `pnpm release:audit` exits 1 with `v3.98.0 has no npm version`; a GitHub release for
   `v3.98.0` does exist (published 2026-11-23). `3.96.0` is a recorded, explained npm gap.

`node scripts/check-version.mjs` passes because the working-tree manifests agree; it does not check
tags. `pnpm verify` would currently fail at typecheck before reaching the repo suite.

---

## 14. Internet findings (facts the trees cannot supply)

1. **`3.98.0` is not on npm.** `https://registry.npmjs.org/@hilbras%2Fomnihilbras/latest` returned
   `"version": "3.97.0"`; `https://registry.npmjs.org/@hilbras%2Fomnihilbras/3.98.0` returned HTTP
   404, as did `/3.96.0`. Actionable: after repairing the tag and the working tree, publish from
   `cli/` and poll `npm view @hilbras/omnihilbras@3.98.0 version`; do not bump to close a bookkeeping
   gap.
2. **The GitHub half of `v3.98.0` is complete.**
   `https://api.github.com/repos/Hilbras/OmniHilbras/releases/tags/v3.98.0` returned a non-draft
   release, `published_at: 2026-11-23T09:58:40Z`. So only npm is missing — this is a two-call audit
   fact, not a missing release ceremony.
3. **OpenAI's Responses streaming union is wider than OH's.**
   `https://developers.openai.com/api/docs/guides/streaming-responses` names
   `response.content_part.added`, `response.content_part.done`, `response.output_text.annotation.added`,
   `response.refusal.delta`, `response.refusal.done`, `response.file_search_call.*` and
   `response.code_interpreter_call.*` in addition to the lifecycle and text events OH emits. Action:
   add the missing event families for a strict client (improvement item 5).
4. **MCP `2025-11-25` is the current transport spec.**
   `https://modelcontextprotocol.io/specification/2025-11-25/basic/transports` names Streamable HTTP
   as current, requires `Accept: application/json, text/event-stream`, `Origin` validation, a
   `MCP-Protocol-Version` header and 202 for notifications. OH implements these
   (`Kernel/API/src/routes/mcp.ts:8-23,100-113`); no action needed.
5. **Codex CLI pin is ahead of 9router.**
   `https://registry.npmjs.org/@openai%2Fcodex/latest` returned `0.171.0`, matching OH's adapter pin;
   9router pins `0.167.1` (`9router/open-sse/providers/registry/codex.js:5`). No action needed; no
   live Codex turn was made.

---

## 15. Ranked, concrete improvement plan

Each item names files, the behavior to add and a proving test. Nothing in this plan was executed by
this report; no source was edited, nothing was committed, tagged, published, or taken through
`pnpm verify`.

1. **Make the working tree compile and the repo suite green before any further parity work (high).**
   Files: `Kernel/API/src/core/service.ts:5030`, `Kernel/API/src/core/routing.ts:949`,
   `docs/architecture/README.md:73,78`. Behavior: import `noCandidateMessage` from `./routing.js`
   in `service.ts` (or use the existing helper that builds the no-candidate error) so `runSystemOne`
   compiles; regenerate the architecture doc's measured-state table from the current files. Proving
   test: `pnpm --filter @omnihilbras/kernel-api test` executes the gateway suite (currently it dies at
   tsc), and `node --test tests/documentation-counts.test.js` passes. Both currently fail.

2. **Repair the release trail, then publish 3.98.0 (high).**
   Files: tags `v3.96.0` and `v3.98.0`, `scripts/audit-release-trail.mjs`,
   `.github/workflows/release-audit.yml`, `package.json:4`, `Kernel/API/package.json:3`,
   `cli/package.json:3`. Behavior: move `v3.96.0` to `bcd6222d` (the commit that carries 3.96.0),
   keep the manifests at 3.98.0, confirm `v3.98.0` points at that commit, publish from `cli/`, and
   poll the registry. Add a pre-tag check that runs the release-trail assertion against the commit
   being tagged so the third occurrence is caught before tagging. Proving test:
   `node --test tests/release-trail.test.js` green, `pnpm release:audit` exit 0, and
   `npm view @hilbras/omnihilbras@3.98.0 version` echoing 3.98.0. All three currently fail.

3. **Commit the parity parcels that currently exist only as untracked files (high).**
   Files: `Kernel/Tools/src/toolCloaking.ts`, `Kernel/Tools/test/toolCloaking.test.js`,
   `Kernel/API/test/tool-cloaking.test.js`, `Kernel/API/src/routes/{systemone,translators}.ts`,
   `Kernel/API/test/translators-route.test.js`, `src/pages/TranslatorPage.tsx`,
   `tests/e2e/translators.spec.ts`. Behavior: after item 1, stage and commit these with their tests
   and spec lines so the next checkout actually has the cloaking, System One and translators
   surfaces; do not leave behavior living in an untracked file. Proving test: the gateway suite
   (item 1) plus the translator Playwright spec (`tests/e2e/translators.spec.ts`) against a fake
   gateway, and `tests/gateway-routes.test.js` green with the new spec lines.

4. **Close the highest-value provider ids (high).**
   Files: new SDK packages, `Kernel/API/src/core/own-provider-adapters.ts:61-121`,
   `Kernel/API/src/core/service.ts:737-865`, `src/data/providers.ts`, `Kernel/Tools/src/caps.ts`.
   Behavior: in order, `cursor`, `gemini-cli`, `zed`, `commandcode`, `mimo-free` — cards with no
   measured claims, declared validation strategies, and the real device/OAuth wires where 9R has
   them (`9router/src/lib/oauth/`). Leave the browser-impersonation, anti-bot and MITM stack out.
   Proving test: one scripted adapter test per id plus `tests/provider-cards.test.js`,
   `tests/tools-caps.test.js` and `tests/provider-oauth-routes.test.js`.

5. **Complete the Responses event union and add a capability adapter (medium).**
   Files: `Kernel/API/src/routes/inference.ts:630-811`, `Kernel/API/src/core/routing.ts`,
   `Kernel/API/src/core/routing-engine.ts`. Behavior: emit `response.content_part.added/.done`,
   `response.refusal.delta/.done`, `response.output_text.annotation.added` and the file-search/code-
   interpreter call events when the upstream stream carries them; add a routing step that, when a
   requested model lacks a required capability and the caller allows it, selects a capable sibling
   in the same combo (9R's capacity adapter at `9router/src/sse/handlers/chat.js:167-178`). Proving
   test: extend `Kernel/API/test/responses-stream.test.js` with a scripted upstream asserting each
   new event, and extend `Kernel/API/test/routing-engine.test.js` with a case where the first target
   lacks vision and a sibling serves the turn.

6. **Add the missing operator surfaces (medium).**
   Files: new `src/pages/CliToolsPage.tsx`, `src/lib/routes.ts`, `src/dashboardApp.tsx:151,190`,
   `docs/SPEC-SDK.md`, reusing the committed translator page. Behavior: a CLI-tool configurator that
   reads only gateway-reported state, and a rebuild of the combos editor with drag-and-drop and
   validation of the virtual-model strategy fields; no timer-set success states and no invented
   values. Proving test: extend `tests/dashboard-wiring.test.js` and
   `tests/dashboard-truthfulness.test.js`, plus one Playwright spec against a fake gateway.

7. **Resolve the `xai`, `kimi` and `glm` id mismatches (medium).**
   Files: `src/data/providers.ts:1003,1360,1535`, `Kernel/API/src/core/own-provider-adapters.ts:93,
   108,115-121`, `Kernel/SDK/xai/adapter/index.ts`, `docs/SPEC-SDK.md`. Behavior: for each id, either
   implement the missing 9R lanes or state in the card which lanes are not served, so a user does not
   assume OAuth/video/coding transport that is absent. Proving test: extend `Kernel/SDK/tests/xai.test.js`,
   `Kernel/SDK/tests/glm.test.js` and `tests/provider-cards.test.js` to assert endpoint/auth agreement
   with each card.

8. **Add dashboard login lockout and SSO (medium, larger scope).**
   Files: new `Kernel/API/src/core/login-limiter.ts`, `dashboard-session.ts`,
   `Kernel/API/src/routes/api-keys.ts`, `src/components/Login.tsx`, `docs/SPEC-SDK.md`. Behavior:
   per-IP progressive lockout, OIDC authorization-code + PKCE S256 with exact redirect matching,
   scoped keys with model allow-lists, loopback binding by default. Proving test:
   `Kernel/API/test/login-limiter.test.js` and `oidc.test.js` with scripted discovery/token
   endpoints, including a case where a non-allowlisted redirect is refused. Do not copy 9R's
   plaintext credential column.

9. **Keep candidate-key checks honest and family defaults bounded (low).**
   Files: `Kernel/API/src/core/own-provider-adapters.ts:61-121`,
   `Kernel/API/src/core/modelCapabilities.ts:8-28`, `tests/provider-validation.test.js`,
   `Kernel/API/test/model-capabilities.test.js`. Behavior: declare `validation:'models'` only with an
   evidence note about an authenticated catalog; otherwise keep `none` and say so in the UI. Add
   family defaults only where upstream publishes them, never guess a context window. Proving test:
   bogus-key cases and a `supports_tools:false` catalog case.

**Explicitly not in the plan:** plaintext credential storage, public-catalog key validation, browser
impersonation/MITM/anti-bot tooling, a red-by-policy test baseline, manifest version drift, killing a
foreign port holder, and any test that presents a scripted transport as a live provider request. The
parity loop's safety note (`tasks/parity-loop/README.md:19-21`) governs all nine items.
