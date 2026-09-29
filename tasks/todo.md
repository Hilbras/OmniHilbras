# OmniHilbras SDK Tasks

- [x] Task 1: Create the SDK package and normalized contracts.
  - Acceptance: strict TypeScript types exist for chat, streaming, models, capabilities, errors, and secret lookup.
  - Verify: package typecheck passes and public exports are documented by types.
  - Files: `packages/omnihilbras-sdk/package.json`, `tsconfig.json`, `src/types.ts`, `src/errors.ts`, `src/secret-store.ts`, `src/index.ts`.
  - Scope: Small.

- [x] Task 2: Add transport, streaming, and provider registry.
  - Acceptance: fetch transport supports JSON, SSE streams, timeouts, cancellation, and normalized errors; registry resolves adapters by ID.
  - Verify: focused unit tests pass with fake fetch implementations.
  - Files: `src/transport.ts`, `src/registry.ts`, `src/streaming.ts`, tests.
  - Depends on: Task 1.
  - The real ids are `gpt-5.6-luna-free`/`-thinking` and the `gpt-5-6`/`gpt-5-5` families; dots and hyphens are one model.
  - Scope: Medium.

- [x] Task 3: Implement the generic OpenAI-compatible adapter.
  - Acceptance: configurable base URL, auth header, model path, chat path, JSON responses, and SSE streaming normalize correctly.
  - Verify: fixture-based contract tests cover success, HTTP errors, malformed responses, and stream termination.
  - Files: `src/adapters/openai-compatible.ts`, fixtures/tests.
  - Depends on: Task 2.
  - Scope: Medium.

- [x] Task 4: Implement the native OpenAI adapter.
  - Acceptance: bearer auth, model listing, chat completions, and `[DONE]` stream handling are isolated in the OpenAI adapter.
  - Verify: adapter tests use representative OpenAI response and stream fixtures.
  - Files: `src/adapters/openai.ts`, tests.
  - Depends on: Task 3.
  - Scope: Small/medium.

- [x] Task 5: Implement the native Anthropic adapter.
  - Acceptance: Messages API conversion, system instructions, version headers, model listing, and native SSE event conversion are isolated in the adapter.
  - Verify: adapter tests cover text/tool responses, errors, and stream events.
  - Files: `src/adapters/anthropic.ts`, tests.
  - Depends on: Task 2.
  - Scope: Medium.

- [x] Task 6: Implement the native Gemini adapter.
  - Acceptance: `generateContent`, model listing, authentication, request conversion, and streaming conversion are isolated in the adapter.
  - Verify: adapter tests cover candidate content, safety metadata, errors, and stream chunks.
  - Files: `src/adapters/gemini.ts`, tests.
  - Depends on: Task 2.
  - Scope: Medium.

- [x] Task 7: Add gateway service and configuration.
  - Acceptance: local configuration loads provider credentials/endpoints through `SecretStore` and builds a provider registry without provider conditionals in the service.
  - Verify: configuration and service unit tests pass with fake adapters.
  - Files: `apps/gateway/src/config.ts`, `src/service.ts`, tests.
  - Depends on: Tasks 3–6.
  - Scope: Medium.

- [x] Task 8: Add local HTTP routes and streaming responses.
  - Acceptance: `/health`, `/v1/models`, and `/v1/chat/completions` support JSON and SSE with consistent error envelopes.
  - Verify: integration tests use fake adapters and never contact real providers.
  - Files: `apps/gateway/src/server.ts`, routes, tests, package scripts.
  - Depends on: Task 7.
  - Scope: Medium.

- [x] Task 9: Connect provider health actions to the local gateway.
  - Acceptance: provider health testing calls the local gateway and surfaces structured success/error states; credential persistence remains preview-only for providers without a management endpoint.
  - Verify: browser smoke test and frontend build/typecheck pass.
  - Files: `src/lib/gatewayClient.ts`, `src/pages/ProvidersPage.tsx`, `src/pages/ProviderDetailPage.tsx`.
  - Depends on: Task 8.
  - Scope: Small/medium.

- [x] Task 9a: Add a secure local connection store.
  - Acceptance: connection metadata is stored separately from encrypted credentials; files use restrictive permissions and an injectable in-memory implementation supports tests.
  - Verify: focused storage tests cover encryption-at-rest, round trips, atomic writes, and no plaintext secret in the metadata file.
  - Files: `apps/gateway/src/connections.ts`, gateway tests.
  - Depends on: Task 7.
  - Scope: Medium.

- [x] Task 9b: Add OpenRouter validation and save routes.
  - Acceptance: the gateway validates credentials against OpenRouter on both Check and Save, stores only a valid key, and returns metadata without secrets.
  - Verify: gateway integration tests use a fake provider transport and assert validation-before-save, status codes, and redaction.
  - Files: `apps/gateway/src/config.ts`, `src/service.ts`, `src/server.ts`, gateway tests.
  - Depends on: Tasks 9a and 8.
  - Scope: Medium.

- [x] Task 9c: Connect the dashboard modal to the connection API.
  - Acceptance: OpenRouter Check and Save call the loopback gateway, errors remain in the dialog, and saved connection metadata is reflected without browser secret storage.
  - Verify: typecheck/build, gateway tests, and browser smoke test.
  - Files: `src/lib/gatewayClient.ts`, `src/components/AddProviderModal.tsx`, `src/pages/ProvidersPage.tsx`, `src/pages/ProviderDetailPage.tsx`.
  - Depends on: Task 9b.
  - Scope: Medium.

- [x] Task 9d: Add model discovery and import policy to OpenRouter connections.
  - Acceptance: Save accepts a free-only/all-models policy, fetches models server-side with the saved credential, filters free models by provider pricing, validates IDs, persists the selected model list, and preserves manually added IDs across re-imports.
  - Verify: adapter/service/gateway tests cover pricing parsing, both policies, malformed provider responses, metadata limits, concurrent mutations, and no-secret responses.
  - Files: `packages/omnihilbras-sdk/src/adapters/openrouter.ts`, `apps/gateway/src/service.ts`, `apps/gateway/src/server.ts`, tests.
  - Depends on: Tasks 9a–9c.
  - Scope: Medium.

- [x] Task 9e: Add model import controls and model catalog persistence to the dashboard.
  - Acceptance: OpenRouter connection dialog has an active/inactive free-model import toggle; Save triggers the correct import; detail pages show imported models and persist custom model IDs only after the gateway confirms them.
  - Verify: typecheck/build and browser smoke test for both toggle states, edit-policy preservation, and failed/successful model additions.
  - Files: `src/components/AddProviderModal.tsx`, `src/lib/gatewayClient.ts`, `src/pages/ProviderDetailPage.tsx`, `src/pages/ProvidersPage.tsx`.
  - Depends on: Task 9d.
  - Scope: Medium.

- [x] Task 9f: Replace preview model tests with real gateway chat checks.
  - Acceptance: provider tests use live adapter health, model tests send a bounded real chat completion with the saved credential, and latency/success/error states come from the gateway response.
  - Verify: gateway contract test covers provider selection and max-token budget; typecheck/build and browser smoke test cover the real request path.
  - Files: `src/lib/gatewayClient.ts`, `src/pages/ProviderDetailPage.tsx`, `apps/gateway/test/server.test.js`, docs.
  - Depends on: Task 9e.
  - Scope: Small/medium.

- [x] Task 9g: Add gateway API keys and the dashboard keys page.
  - Acceptance: the gateway mints, pauses, revokes, and authenticates client keys; only SHA-256 hashes are stored; enforcement guards `/v1/models` and `/v1/chat/completions` by default with an allowlisted-dashboard exemption; the dashboard page manages keys without browser secret storage.
  - Verify: gateway store/route tests cover hash-at-rest, one-time reveal, constant-time authentication, paused-key rejection, enforcement toggling, and origin exemption; typecheck/build and browser smoke test cover create, pause, resume, and delete.
  - Files: `apps/gateway/src/api-keys.ts`, `src/secure-store.ts`, `src/service.ts`, `src/server.ts`, `src/config.ts`, `test/api-keys.test.js`, `src/pages/ApiKeysPage.tsx`, `src/lib/gatewayClient.ts`, `src/components/DashboardShell.tsx`, `src/dashboardApp.tsx`, docs.
  - Depends on: Task 9f.
  - Scope: Medium.

- [x] Task 9h: Add per-connection retry, timeout, rate limits, and health-based failover.
  - Acceptance: each connection stores a validated resilience budget; retryable failures retry then fail over by priority; terminal failures never retry; deadlines and rate limits are enforced by the gateway; failing connections are ejected and recover automatically; the dashboard exposes the controls and live state.
  - Verify: routing tests cover retry-then-failover, terminal-error short-circuiting, timeout and rate-limit handoff, ejection with cooldown recovery, streaming failover before the first chunk, and background health polling; HTTP tests cover the attempt trace and resilience route; browser smoke test covers the Reliability panel.
  - Files: `apps/gateway/src/routing.ts`, `src/service.ts`, `src/connections.ts`, `src/server.ts`, `src/config.ts`, `test/routing.test.js`, `src/pages/ProviderDetailPage.tsx`, `src/lib/gatewayClient.ts`, docs.
  - Depends on: Task 9g.
  - Scope: Medium.

- [x] Task 9i: Add hedged requests and on-demand provider adapters.
  - Acceptance: a slow leading connection is raced against the next eligible one and the first reply wins with the loser cancelled; no hedge is sent when a fast leader answers or no second candidate exists; any provider can be added with a caller-supplied endpoint and served through an on-demand OpenAI-compatible adapter.
  - Verify: routing tests cover hedge-wins, fast-leader-not-hedged, single-candidate skip, leader-wins, failed-race fallback, and on-demand adapter resolution; live check against a deliberately slow endpoint measures the latency difference and the attempt trace.
  - Files: `apps/gateway/src/service.ts`, `src/connections.ts`, `src/server.ts`, `test/routing.test.js`, `src/pages/ProviderDetailPage.tsx`, `src/lib/gatewayClient.ts`, docs.
  - Depends on: Task 9h.
  - Scope: Medium.

- [x] Task 9j: Test every model concurrently from the provider page.
  - Acceptance: a Test all control sends one real bounded request per model through a bounded worker pool, with selectable concurrency, live progress, per-model results identical to a single test, a Stop control, and a summary with median latency and failure count.
  - Verify: browser smoke test covers the progress indicator, bounded in-flight count, per-model ping badges, and the completion summary.
  - Files: `src/pages/ProviderDetailPage.tsx`, `src/lib/gatewayClient.ts`.
  - Depends on: Task 9f.
  - Scope: Small/medium.

- [x] Task 9k: Collapse the dashboard into one React Router entry.
  - Acceptance: the dashboard is a single app mounted at `/dashboard` with real paths, the duplicate `provider.html`, `providers.html`, and `routing.html` entries are removed, navigation uses `Link`, and old `.html` URLs redirect to their replacement.
  - Verify: typecheck/build, dev-server rewrite, redirect table, and browser navigation between routes.
  - Files: `src/dashboardApp.tsx`, `src/components/DashboardShell.tsx`, `src/components/ProviderCard.tsx`, `src/pages/ProvidersPage.tsx`, `src/pages/DashboardOverview.tsx`, `src/pages/ProviderDetailPage.tsx`, `src/lib/routes.ts`, `vite.config.ts`, `public/_redirects`, docs.
  - Depends on: Task 9g.
  - Scope: Small/medium.

- [x] Task 9l: Implement the Cline OAuth sign-in flow.
  - Acceptance: the Cline card's Add connection opens the sign-in in the browser and finishes on its own — `POST /v1/oauth/cline/start` mints a single-use `state` and a session, Cline redirects the browser to `GET /v1/oauth/cline/callback`, the gateway claims the state, proves the token with a real account request, imports the model catalog, and saves an encrypted `oauth` credential. The dashboard learns the outcome by polling `GET /v1/oauth/cline/session/:id`. `POST /v1/oauth/cline/exchange` stays as the fallback for a provider that does not hand the code to a browser redirect. An expired token is renewed before use and written back to the vault.
  - Verify: 38 gateway tests cover the session lifecycle, single-use state, replay and forged-state refusal, the full browser round trip, a provider error with markup, a rejected code reaching the dashboard instead of a timeout, and the cross-site exemption staying narrow. 6 SDK tests cover `workos:` prefixing that leaves non-JWT keys verbatim, one-shot refresh with persistence, and missing-token handling. Browser check confirms the tab opens on Cline's real sign-in page, the dialog centres, and a real rejected code reports `Cline did not accept that sign-in. Try again.` with no connection stored.
  - Files: `packages/omnihilbras-sdk/src/adapters/cline.ts`, `src/types.ts`, `src/index.ts`, `test/cline.test.js`, `apps/gateway/src/oauth.ts`, `src/service.ts`, `src/server.ts`, `src/connections.ts`, `test/oauth.test.js`, `test/oauth-routes.test.js`, `test/cline-sessions.test.js`, `src/components/OauthConnectDialog.tsx`, `src/pages/ProviderDetailPage.tsx`, `src/lib/gatewayClient.ts`, `src/data/providers.ts`, docs.
  - Depends on: Task 9g.
  - Scope: Medium.

- [x] Task 46: Phase 2 — extract `ApiKeyManager`.
  - Acceptance: key policy is a separate concern with its own tests; the public surface and every user-facing string are unchanged.
  - Verify: 10 `ApiKeyManager` tests; the 13 pre-existing `api-keys` tests pass **unchanged**, including the enforcement path.
  - Findings: **I reworded two user-facing messages while moving the code, and a test caught it.** The original was `The API key is invalid or paused.` and I had written *"That API key was not recognised, or it has been disabled."* Both read better; both are also a behaviour change, and this phase exists explicitly not to make one. Restored verbatim, with a note saying why they were left alone. The lesson generalises: a refactor that quietly rewords what a user reads is the same failure as one that quietly changes what it returns, and only here did a test happen to notice.
  - The store keeps the security properties — random keys, SHA-256, one-time reveal, constant-time comparison. This adds only the two a store cannot decide: **whether enforcement is on at all** (no store means "not configured", not "accept everything", and the distinction is visible in `list()`), and **that a mutation is a unit** — a create racing a remove is a lost update on a file-backed store, and the store has no way to know two operations were meant to be sequential.
  - One test that encodes a fault that has not happened yet: **a lock whose promise chain dies on rejection turns one error into a permanently broken gateway**, because every later key operation then waits on a promise that will never settle. The chain catches.
  - Files: `apps/gateway/src/api-key-manager.ts` (new), `apps/gateway/src/service.ts`, `apps/gateway/test/api-key-manager.test.js` (new).
  - Depends on: Task 45.
  - Scope: Medium.

- [x] Task 45: Phase 2 — extract `HealthManager` out of `GatewayService`.
  - Acceptance: health is a separate concern with its own tests, `service.ts` no longer holds health state, and the public surface is unchanged.
  - Verify: 12 `HealthManager` tests run with no gateway, no stores and no network; all 155 pre-existing gateway tests pass unchanged. `service.ts` 1500 → 1432 lines.
  - Findings: **the extraction immediately caught a gap the contract could not close.** The manager passed an adapter's `unavailable` straight through, so a verdict with no `message` reached the dashboard unchanged — the same fault just fixed in four adapters. The contract catches that at build time, but a manager that merely forwards the omission will keep producing it for anything the contract does not cover, so **the boundary now fills the gap**. Two layers, deliberately: a test that fails, and a runtime that cannot be wrong.
  - The boundary is two questions and nothing else — *which adapters exist*, and *what context should this adapter be asked in* — supplied as closures. Passing the service itself would have made the extraction cosmetic; passing these two makes the manager testable in isolation and makes the coupling visible. If health ever needs a third thing from the gateway, that is the signal a boundary is wrong, not a reason to widen the interface.
  - `HealthRegistry` stays in `routing.ts` and is reached through one accessor. Routing *reads* failure counts to decide ejection and should not know where the counters live, and exposing the registry rather than new counting methods keeps `resolveRoute`'s provider-agnostic signature — which is well tested — untouched. Health keeps sole ownership of writing them, so a failure recorded by a request and one recorded by a sweep cannot disagree.
  - Tests that were impossible before, because health was only reachable through the service: three `report()` calls probe once; three concurrent `refresh()` calls are one sweep; asking about one provider probes one provider; an aborted or missing provider is *named* rather than reported unhealthy; a thrown check keeps the real cause instead of a generic failure. Each of those encodes a fault that shipped.
  - Files: `apps/gateway/src/health.ts` (new), `apps/gateway/src/service.ts`, `apps/gateway/test/health-manager.test.js` (new).
  - Depends on: Task 44.
  - Scope: Medium.

- [x] Task 44: A provider contract, and the four health checks it caught.
  - Acceptance: every adapter that can be driven offline passes a shared contract, and the contract has been seen to fail on the bug it exists to catch.
  - Verify: 56 contract assertions across `openai`, `openrouter`, `openai-compatible`, `anthropic` and `gemini`, all passing; the DeepSeek decoder passes a captured multi-frame stream; a decoder that keeps only the first fragment is **rejected** by the multi-part assertion. 475 tests pass.
  - Findings: **it found a real bug on the first run.** Four adapters — `anthropic`, `gemini`, `openai-compatible`, `openrouter` — reported `unavailable` from a bare `catch {}` with **no message**, so the dashboard could only say "unavailable" and not whether the key was rejected, the endpoint was wrong, or the provider was down. Those need three different things from the user. Six other adapters already did this correctly, so the shape existed to copy; it had just not been applied everywhere. All four fixed.
  - **The division of labour is the design.** The contract owns the invariants; a provider supplies only its `wireFormat` name, so the harness knows about HTTP and nothing about protocols. Asking a provider to describe its own expectations would make this a second copy of its tests; asking it only how to speak its own protocol makes this a contract, because the assertions live in one place and cannot drift per provider.
  - **The centrepiece is deliberately hostile to the DeepSeek failure.** Every completion fixture is multi-part, and the assertion is exact equality, because a test that builds its own input and then asserts against that input only proves the decoder agrees with the author of the test. The contract answer ends in a lone space and has parts sharing prefixes, so per-frame trimming and deduplication each fail. Proven rather than asserted: the shipped decoder returns `"1, 2, 3"` from a captured stream, and a decoder that keeps only the first fragment returns `"1"` and is **rejected**.
  - **Three harness bugs, each of which looked like provider bugs.** (1) The wrapper delegated `request` but stubbed `stream` as an empty generator, so all five providers "failed" streaming. (2) `refuseWith: 401` is the obvious thing to write, and reading only `.status` off a **number** yields `undefined` and then `200` — a refusal test that silently asserted a refusal works, and the provider passed. (3) `/models` also matches Gemini's `:generateContent` URLs, so a chat was answered with a model list and Gemini reported "missing a candidate". A test double that does not implement the interface it stands in for produces failures indistinguishable from real ones, which is worse than no double.
  - Also fixed in the harness, and both are fidelity bugs a harness cannot have: it now implements `HttpTransport` (`{status, headers, data}`, already parsed) rather than returning a `Response`, and it duplicates the transport's status-to-code mapping on purpose, because a double that shares the implementation it stands in for cannot catch a bug in it — and that mapping decides whether a connection gets ejected.
  - **Three injection styles exist**, which is the next architectural seam: most adapters take `{ transport }`, `deepseek-web` takes `{ fetch }`, and `chatgpt-web` takes `{ driver }`. That is why the contract needs a harness per style, and it is worth one seam later — see `docs/architecture/`.
  - Files: `packages/omnihilbras-sdk/test/provider-contract.js` (new), `test/provider-contract.test.js` (new), `test/harness/scripted-transport.js` (new), `packages/omnihilbras-sdk/src/adapters/{anthropic,gemini,openai-compatible,openrouter}.ts` (health reasons), `docs/architecture/README.md`.
  - Depends on: Task 43.
  - Scope: Medium.

- [x] Task 43: Phase 1 — one version stated once, a CI that runs, and an honest architecture map.
  - Acceptance: `pnpm verify` is the release gate, version drift fails CI, the committed probe is gone, and the architecture doc is measured rather than aspirational.
  - Verify: `pnpm version:check` fails on a real mismatch and passes when fixed; `pnpm version:fix` rewrites the derived copies; `.github/workflows/verify.yml` runs version → typecheck → test → build on Node 24 with pnpm 12.5.1 pinned. 419 tests pass.
  - Findings: **there was no CI at all.** `.github/workflows/` was empty, so 419 tests only ever ran when I happened to run them. That is not a safety net, it is a habit — and a habit does not run on someone else's machine, or on a machine too loaded to be paying attention. That is the largest single gap in the release process, and it is invisible until it is named.
  - **Version drift was one line, not a systemic problem.** I reported "six stale versions" and was wrong: five were `127.0.0.1` inside URLs and legitimate history. The real drift is `README.md` line 6, which advertised **0.2.0** while the project was at **1.12.2** — a hundred minor versions, unnoticed. `scripts/check-version.mjs` now checks the three manifests, the README line, the `X-CLIENT-VERSION` constant, and the latest tag, and it **fails** rather than generating: a generator is itself something that can go wrong silently, whereas a failing check cannot. The README match is anchored to the line's own shape, because a loose regex "fixes" the bump table's `0.2.0 → 1.0.0` examples and the URLs.
  - Removed the committed `apps/gateway/qwen_probe3.mjs` and added `tools/` for experiments. A throwaway probe in the gateway's source tree is how production and throwaway stop being distinguishable.
  - `docs/architecture/README.md` documents the architecture **as measured**, and two of its findings contradict what an outsider would assume. `routing.ts` is 186 lines with **zero** provider ids — routing is already provider-agnostic. `service.ts` is 1500 lines with **12**, and they are not scattered: six of them are one factory, `resolveAdapter`. So the Core is far cleaner than the "Core is full of provider conditionals" framing suggests, and the real gap is narrower and sharper: the Core has **no lifecycle concept at all** (`lifecycle`, `revoke`, `onboard`, `provision` — zero occurrences). Stateless providers already need no Core changes, because nine connections are live and the OpenAI-compatible ones take the generic branch untouched. What does not fit is a credential that must be created, refreshed and revoked — a Cline session, an OAuth grant — because there is nowhere for that to live. One `CredentialLifecycle` contract would absorb every hand-wired branch, which is a refactor's size rather than a rewrite's.
  - Files: `scripts/check-version.mjs` (new), `.github/workflows/verify.yml` (new), `docs/architecture/README.md` (new), `package.json`, `README.md`, removed `apps/gateway/qwen_probe3.mjs`.
  - Depends on: Task 42.
  - Scope: Medium.

- [x] Task 42: The cookie field was disabled with no way to enable it, and the catalog overclaim.
  - Acceptance: a provider with no risk notice gets a typeable field, Qwen carries the caution its own dialog promises, and the model list is labelled as the moving thing it is.
  - Verify: on `qwen-web` the caution and its checkbox render, the textarea is enabled once ticked, `Ask Qwen` enables on input, and the probe resolves in 1.4 s. 419 tests pass.
  - Findings: **a gate that could not be opened.** The textarea was `disabled={!acknowledged}`, while the checkbox that sets `acknowledged` renders **only when `riskNotice` is set**. Qwen had no notice, so it got a permanently disabled field and no visible way to unlock it — which reads as a broken dialog, not as a lock. The gate and the thing that can open it have to be the same condition: `disabled={mustAcknowledge && !acknowledged}`. This was latent for every provider without a notice, not something I introduced with Qwen.
  - Qwen also **needed** the notice. A Qwen session cookie is a whole-account session, and the dialog's own footer already says *"treat this like a password: it may access your signed-in web account"* — it was promising a warning it had no way to show.
  - **Then the probe reported seven models where it had reported three.** Repeated requests from here returned the same three every time; cookies were ruled out (none, `cna`, `isg`, and a pasted pair all agreed), and the gateway probe agreed with the direct one. So Qwen's guest catalog **varies**, and the "it answers three" I shipped in v1.12.0 was an overclaim. That is the second overclaim in a row on the same fact — first ten invented ids, then a hard "three" — and both came from treating an observed value as a constant. `QWEN_WEB_MODELS` is now a **dated snapshot** with `QWEN_WEB_MODELS_OBSERVED_AT`, and the dialog is the authority because it always shows the live list.
  - Files: `src/components/WebCookieConnectDialog.tsx`, `src/data/providers.ts`, `packages/omnihilbras-sdk/src/adapters/qwen-web.ts`, docs.
  - Depends on: Task 41.
  - Scope: Small.

- [x] Task 41: Make the Qwen dialog look like it works, because it did not.
  - Acceptance: the probe cannot wait forever, a slow answer reads as progress rather than a dead button, and the disabled button says what it wants.
  - Verify: the three questions are asked concurrently (`models` still precedes `turn`, since the turn names a model from it); a stalling transport returns an answer in ~120 ms with a reason rather than hanging; the disabled primary button carries "Paste the credential above first."; the in-flight state names the three questions and the 20 s ceiling. 419 tests pass.
  - Findings: **it worked, and looked broken.** The probe answers in about a second, and the dialog did eventually show the result — but "Ask Qwen" sat there with nothing to say, so a wait reads exactly like a dead button. Measured, not assumed: the gateway answers in 0.7–1.8 s by curl and the browser's own fetch took 1.2–1.5 s, so the network was never the problem. The delay was the **browser's main thread being starved** on a machine at load 17–42, which delays the promise callback rather than the request.
  - Three fixes, none of which depend on that diagnosis being right. **A 20-second budget**, so a stall becomes an answer instead of an indefinite spinner — and the answers gathered so far are returned rather than discarded, because a slow auth origin with a fast refusal on the turn is still a useful answer and throwing it away would be its own dishonesty. **The three questions now go out together** instead of in sequence, which was three round trips to another continent for no reason: the auth origin and the model catalog are independent, and only the turn waits for a model id. **The waiting state says what is being asked and how long it may take**, which is what turns a spinner into progress.
  - Also: the disabled primary button was silently greyed, which is read as a broken feature. It now carries "Paste the credential above first." And the field said `auth cookie` as both its label and its placeholder — words that do not say where the value comes from. It says `Cookie header from auth.qwen.ai` and shows what to copy.
  - Files: `packages/omnihilbras-sdk/src/adapters/qwen-web.ts`, `src/components/WebCookieConnectDialog.tsx`, `src/lib/webSessionProviders.ts`, tests, docs.
  - Depends on: Task 40.
  - Scope: Small.

- [x] Task 40: Give Qwen a real flow, and find out the one thing that was unknown.
  - Acceptance: the Qwen card is connectable, the dialog asks the three questions that matter, and it reports the provider's own answers. Nothing is saved unless a turn is actually served.
  - Verify: live through the dialog with a guest cookie — *"A turn was refused · Qwen refused the turn: FAIL_SYS_USER_VALIDATE, RGV587_ERROR::SM… · Credential at auth.qwen.ai: Unauthorized — 401 Unauthorized · 3 models served to guests"*; `POST /v1/web-cookie/qwen/check` returns the same; 417 tests pass.
  - Findings: **Qwen signals every refusal in the body and never in the status code — on both origins.** `auth.qwen.ai/api/v2/auths/` answers a guest with **HTTP 200** and `{"success":false,"data":{"code":"Unauthorized","details":"401 Unauthorized"}}`, and the turn answers 200 with `ret:["FAIL_SYS_USER_VALIDATE",…]`. A check that trusted the status reported a guest cookie as `authenticated: true`; the first version of this probe did exactly that and the live run caught it. Refusals are now read out of the body.
  - The card moved from `status: 'planned'` to **`available`**. `planned` meant "there is nothing behind this button" and the page disables it, which was right while the only thing Qwen could be asked was a guess. There is a flow behind it now. A card with a flow but no connection is `available` with `—` metrics, which is the project rule, and the dialog is where the blocker is explained and testable.
  - **I invented the model catalog and the probe caught it.** I wrote ten plausible ids — `qwen3.7-flash`, `qwen3.7-coder-plus`, `qwen3.7-vl-plus` and so on. The live endpoint answers **three**: `qwen3.7-plus`, `qwen3.8-max`, `qwen3.8-omni-flash`. Guessing a catalog is the same fault as guessing a capability: the card would have advertised models that do not exist and offered turns guaranteed to fail, with nothing on the page to say why. Qwen publishes no context length there, so none is claimed.
  - Also fixed: the DeepSeek dialog still said *"Or let OmniHilbras read it — a window opens"*, referring to the sign-in window removed in v1.10.0. It now explains what an empty `userToken` means instead.
  - **What is still unknown, and cannot be resolved here:** whether Alibaba's gate applies to an *authenticated* request. The card says so and the probe asks it. If the answer is no, this is a working provider; if yes, it stays a catalog entry — and either way nobody will have to take a guess on trust.
  - Files: `packages/omnihilbras-sdk/src/adapters/qwen-web.ts` (new), `apps/gateway/src/service.ts`, `apps/gateway/src/server.ts`, `src/components/WebCookieConnectDialog.tsx`, `src/lib/webSessionProviders.ts`, `src/data/providers.ts`, tests, docs.
  - Depends on: Task 39.
  - Scope: Medium — a new surface and a new route.

- [x] Task 39: Retract the ChatGPT console one-liner, and re-test the Qwen gate.
  - Acceptance: the dialog never tells the user to use the Console for ChatGPT, and the error distinguishes "signed in, copied from the Console" from "not signed in".
  - Verify: the dialog offers only the Network and Application routes and no `copy(document.cookie)`; a header containing `__Secure-next-auth.callback-url` is told the cookie is HttpOnly and pointed at the Network tab, while a header with no NextAuth cookie is told the browser is not signed in. 411 tests pass.
  - Findings: **`copy(document.cookie)` cannot work, for anyone, ever.** NextAuth sets `__Secure-next-auth.session-token` `HttpOnly`, and `document.cookie` cannot read an HttpOnly cookie. I put it in v1.10.1 as the "fastest" path and it was the *only* path offered. What made it worse than simply not working is the shape of the failure: the header it returns is a plausible-looking set of chatgpt cookies with no session token, which reads exactly like being signed out — so it sent a signed-in user to sign in again. `__Secure-next-auth.callback-url` is *not* HttpOnly, so a signed-in browser still leaks part of the family, and that is now the discriminator: a sibling means signed in and copied from the wrong place, no sibling means signed out. The two need opposite instructions, and "sign in" is the wrong one half the time. Tracked from the raw cookie names, because the allowlist drops `callback-url` before the check runs.
  - **Qwen: the gate is real, unconditional for a guest, and not a clearance flow.** Re-tested against the live site (app v0.4.4, model list now `qwen3.7-plus`). The turn endpoint answers **HTTP 200** with `{"ret":["FAIL_SYS_USER_VALIDATE","RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试"],"data":{"url":"…/_____tmd_____/punish?x5secdata=…"}}`. Visiting that challenge URL returns 200, displays "Please connect them in order", **grants no cookie**, and the retry is refused with a freshly minted challenge. So it is a human puzzle, not something a client can satisfy. `/api/v1/chat/completions` is 404 — the v2 path is the only one. Also confirmed: asking the turn from inside the page **kills the renderer**, so a probe has to be made from Node with the harvested cookies and a byte cap.
  - The one untested hypothesis is the same one that unblocked DeepSeek: **a signed-in Qwen session may not be gated.** That needs a credential only the user has. The card stays `planned` with the reason updated to the measured verdict.
  - Files: `packages/omnihilbras-sdk/src/adapters/chatgpt-web.ts`, `src/lib/webSessionProviders.ts`, `src/data/providers.ts`, tests, docs.
  - Depends on: Task 38.
  - Scope: Small.

- [x] Task 38: Stop painting white tiles behind white logos.
  - Acceptance: no bundled logo is invisible on its card, in either theme, and the classification cannot go stale.
  - Verify: ChatGPT Web and Qwen Web render on a dark tile instead of white-on-white; `tokenharbor.svg` (`#16191e`) and `ollama.png` (pure black) get a light tile so they are visible in dark mode; 151 assets indexed as light, 63 as dark, no overlap; `pnpm build` regenerates the index. 409 tests pass.
  - Findings: **`ProviderMark` hard-coded `backgroundColor: logo ? '#ffffff' : …`**, so any light mark was a white glyph on a white tile. `chatgpt.svg` is `fill="#fff"`, and `qwen.svg` is `fill="#ffff"` — a four-digit hex meaning white at full alpha, which a naive `#rgb` check misses entirely. It was never only those two: **151 of the 157 bundled assets are light**, including `anthropic`, `openai`, `gemini`, `google`, `openrouter` and `kiro`, and **63 are dark**. One tile colour satisfies one group and hides the other, in whichever theme it did not match.
  - The classification is **generated from the asset files by a Vite plugin, not hand-written**. A hand-written list goes stale the moment a logo is added, and a stale entry fails *silently* — an invisible logo rather than an error — and there is no app test runner to catch it. `buildStart` reads every SVG and PNG and writes `src/lib/logoPolarity.generated.ts`, so `pnpm dev` and `pnpm build` both keep it true.
  - **SVGs and PNGs need different rules, and the difference is the interesting part.** An SVG's fills are sparse, so the test is on the extremes: any fill above 0.72 luminance needs a dark tile, and failing that any below 0.15 needs a light one. An average hides exactly the part that matters — `tokenharbor.svg` is a single `#16191e` path that averages to a harmless mid-tone while being invisible on a dark card. A PNG's pixels fill the whole box, so the average is right and the extremes are not: `openai.png` is a black knot on a white field whose brightest pixel is always 1, and only the average says it belongs on a dark tile.
  - Rasters needed a decoder — `pngjs` and `@types/pngjs`, dev-only. Before adding it I measured the eight PNGs the catalog actually uses: `openai`, `anthropic`, `gemini` and `mistral` are light, `ollama` is pure black, `opencode` is dark, `cline` and `openrouter` are mid. Four of the eight were broken in one theme or the other.
  - Files: `vite.config.ts` (`logoPolarity` plugin), `src/lib/logoPolarity.generated.ts` (generated), `src/components/ProviderMark.tsx`.
  - Depends on: Task 37.
  - Scope: Medium — a build step, a dependency, and a component.

- [x] Task 37: Make the provider cards fit the space they are actually given.
  - Acceptance: no provider name, status, or metric is clipped at any content width, and the card count follows the container rather than the viewport.
  - Verify: 0 of 13 cards have a truncated name; "ChatGPT Web" needs 200 px and gets 200 px; Qwen Web's reason shows two full lines where it showed 176 px of 905; the simple and advanced grids are both 2 × 344 px with 0 overflowing elements at an 800 px viewport; column counts across content widths 360 → 1920 px: 1, 1, 2, 2, 2, 3, 3, 4, 5, 5, 6. 409 tests pass.
  - Findings: **breakpoints could not express the problem, and that is why the fix is not a breakpoint.** The sidebar is 252 px from `lg` up and off-canvas below it, so the same viewport width yields a content area 252 px narrower on one side of that breakpoint than the other — and collapsing the sidebar changes it again. Any fixed column count is therefore wrong somewhere. The grid is now `repeat(auto-fit, minmax(272px, 1fr))`, so a card is never rendered narrower than it can show its name and status, and it gains a column as soon as there is room for one. Measured: 360→1, 640→2, 900→3, 1200→4, 1440→5, 1920→6.
  - I first "fixed" it with `md:grid-cols-3` and **made it worse** — three cards in 225 px at an 800 px viewport truncated *every* name, "OpenCode Console" needing 129 px in 75. The measurement is what caught it; the reasoning had not.
  - Two clipping bugs that were never about the grid. **The name shared a row with the caution badge**, badge `shrink-0` and name `truncate`, so an "Account session" badge took the space and "ChatGPT Web" got 93 px of text in 82. The badge moved to the status line, where it reads better anyway. And **a planned provider's reason sat in a hard `max-w-[11rem]` box** — 905 px of sentence in 176 px. It now has its own full-width row, clamped to two lines, with the whole reason still on `title`.
  - Also: the advanced card's Models stat is a composite string — "77 models · all import" — needing 158 px in a 121 px cell, so it ellipsised to "77 models · all i…", which reads as a rendering fault rather than as a number. It wraps now. Two lines is honest; a clipped policy is not.
  - Files: `src/pages/ProvidersPage.tsx`, `src/components/ProviderCard.tsx`.
  - Depends on: Task 36.
  - Scope: Small — a layout fix, but three separate clipping faults.

- [x] Task 36: DeepSeek Web returned only the first character of every answer.
  - Acceptance: a real turn returns the whole answer, and a stream cut off mid-generation is an error rather than a clean `stop`.
  - Verify: "Count from 1 to 10" returns `'1, 2, 3, 4, 5, 6, 7, 8, 9, 10'` (29 chars) where it returned `'1'`; "In one short sentence, what is a hash table?" returns 144 chars; "What is 17 times 3?" returns `51`; a body with no `response/status: FINISHED` is refused. 407 tests pass.
  - Findings: **the decoder was reading a frame shape DeepSeek does not send.** The real reply to "Count from 1 to 5" is: one whole-response frame carrying the first fragment, then `{"p":"response/fragments/-1/content","o":"APPEND","v":","}`, then a run of frames whose value is a **bare string** and most of which carry **no path at all** — `{"v":" "}`, `{"v":"2"}`, `{"v":","}`. The decoder matched only `p === "response/fragments"` (the live path is the indexed form) and only fragment *objects* (every continuation is a string), so it kept the opening character and discarded the rest.
  - The failure was invisible because it looked like a working model. Every answer came back one character long with `finish_reason: stop`, so "working" for a prompt that asked for the word `working` passed, and a green tick appeared. It took a real conversation to surface it: **"Count from 1 to 10" answering `1` is not a terse model.** The lesson is the same one as everywhere else in this area — a check that only proves the thing it was written to prove will happily pass while the feature is broken.
  - Two more things the stream requires, both found by capturing a live body rather than reasoning about it: **`FINISHED` is a status word with a string value.** A decoder that appends every string value writes the literal word `FINISHED` onto the end of the answer, which is what the reference implementation does. It is consumed as status here. And a body that closes **without** `response/status: "FINISHED"` was cut off mid-generation — an expired session, a dropped connection — and is now refused with that named, instead of being returned as a fragment wearing `finish_reason: stop`.
  - Files: `packages/omnihilbras-sdk/src/adapters/deepseek-web.ts`, tests (a captured stream is kept as a fixture, because the shape is the whole point).
  - Depends on: Task 35.
  - Scope: Small — a fix, but one that had been hiding a completely broken provider.

- [x] Task 35: A chat on each provider page, for actually talking to a model.
  - Acceptance: every provider page ends with a conversation against one of its own models, and a real turn streams back.
  - Verify: `deepseek-web` shows 14 models, answers "What is a hash table used for?" in 10.2 s, shows a second turn that carries the first in history, and labels the turn "no streaming". 401 tests pass.
  - Findings: **`/health` was re-probing all thirteen providers on every single request**, not just on the 60 s background sweep. Two things were wrong with that, and the second one is the interesting one. It was slow — 8.45 s per call. Worse, it was a *head-of-line blocker*: the browser allows six connections per origin, the page asked for health on load, and a sweep that outlived the poll interval queued the next behind it, so health requests monopolised the pool and ordinary requests to the same gateway queued behind them. A chat turn that answers in six seconds took over a minute, which looks exactly like a model that hangs. `health()` now serves the last sweep and stores it; concurrent callers share one sweep rather than each starting their own. Four consecutive calls: 2.9 s (cold), then 3 ms, 15 ms, 4 ms. `checkedAt` is reported so the caller can see the report's age instead of being handed something that implies it was just measured.
  - Also: **not every provider can stream.** DeepSeek Web declares `streaming: false` and the gateway answers a streamed request `501 NOT_SUPPORTED`. The panel retries it as one request and reports `streamed: false`, so the answer appears and the turn is labelled **"no streaming"** — a provider that cannot stream is not a provider that cannot answer, and showing a refusal would have been wrong. Tested against a provider that streams as well as one that cannot.
  - Deliberately **not** offered when it cannot work: a provider with no connection, or one the gateway cannot serve at all, gets a sentence explaining why instead of a control that can only fail. And a failed turn is dropped from the replayed history rather than sent back as an assistant message — teaching a model to refuse by showing it its own refusal is a subtle way to corrupt every later turn.
  - Files: `src/components/ProviderPlayground.tsx` (new), `src/lib/gatewayClient.ts` (`streamGatewayChat`), `src/pages/ProviderDetailPage.tsx`, `apps/gateway/src/service.ts` (health snapshot).
  - Depends on: Task 34.
  - Scope: Medium — a new surface and a new gateway behaviour.

- [x] Task 34: Test one provider, not thirteen — and stop a hung read from saying "not connected".
  - Acceptance: "Test provider" answers in about a second with the provider's own reason for any failure, and a slow or failed connection read says so instead of "No connection yet".
  - Verify: `GET /v1/health/deepseek-web` returns in 8 ms of gateway time (478–823 ms of real DeepSeek round trip) against 8.45 s for `GET /health`; the badge reads Checking… → Connected; "Test provider" reports `Ping 816 ms`; an unknown provider returns 404 naming it. 401 tests pass.
  - Findings: **three more layers of the same fault, all of them reporting rather than behaviour.** (1) "Test provider" called `getGatewayHealth()`, which probes every active adapter, to answer a question about one provider — thirteen probes to render one card, and on a loaded machine long enough that the button looked permanently stuck. There is now `GET /v1/health/:providerId`, and the test asserts the other adapter is *never probed* rather than merely that the response shape is right. (2) `loadConnection` had `.catch(() => undefined)` and no timeout, so a request that **hung for 60 seconds** left the page on its initial `false` and it said **"Not connected"** about a connection that existed, with an **Add connection** button inviting a second one. Three states now — loading, ready, failed — and a 10 s ceiling, because a read that stalls is not evidence of anything. (3) The health check then reported **"healthy in 0 ms"**, which was the *cached* access token: `accessToken()` caches for an hour, so the check proved nothing while looking like a check. `validateCredential` now passes `fresh: true`. This is the exact fault the area keeps making — a confident answer with nothing behind it.
  - Also: an unknown provider is `NOT_FOUND` naming itself, not `unavailable`. "This provider is down" and "you never connected it" are different problems, and the first sends the user to fix a credential that was never the issue.
  - Files: `apps/gateway/src/service.ts` (`probeAdapter`, `healthForProvider`), `apps/gateway/src/server.ts`, `packages/omnihilbras-sdk/src/adapters/deepseek-web.ts`, `src/lib/gatewayClient.ts`, `src/pages/ProviderDetailPage.tsx`, tests, docs.
  - Depends on: Task 33.
  - Scope: Medium — a new route.

- [x] Task 33: Register DeepSeek Web for health, and give it a health check.
  - Acceptance: "Test provider" works on a DeepSeek connection, and health says healthy rather than "not connected".
  - Verify: `GET /health` reports `deepseek-web -> healthy`; a real turn through the gateway returns `'working'` in 7.9 s (proof of work solved); `GET /v1/connections` shows `deepseek-web | hasCredential: True | models: 14`. 397 tests pass.
  - Findings: **two** separate defects, both silent. `activeAdapters()` registers a real adapter for `chatgpt-web` but not for `deepseek-web`, so the DeepSeek connection fell through to a generic OpenAI-compatible adapter pointed at `chat.deepseek.com` — which is not an OpenAI endpoint — and health reported `unavailable` with an **empty message**. Routing was unaffected, because `resolveAdapter` was already correct, so the provider worked while reporting that it did not. Then, once registered, it reported `Health checks are not supported.`: `DeepSeekWebAdapter` had no `healthCheck` at all. Fixed at both levels, and the health check is a **credential check** (`users/current`) rather than a completion, so it costs one round trip and no proof of work — which is what makes it cheap enough for every poll.
  - Also: **`apps/gateway/test/deepseek-web-check.test.js` was never committed.** It ran locally, so the numbers in several releases counted tests that were not in the repository, and four of them had gone stale when `checkChatGptWeb` started verifying against a live page. Rewritten to assert what is true offline, and now tracked. The real lesson is not the missing `git add` — it is that "397 tests pass" was never a statement about the repository.
  - Files: `apps/gateway/src/service.ts`, `packages/omnihilbras-sdk/src/adapters/deepseek-web.ts`, `apps/gateway/test/deepseek-web-check.test.js` (now tracked), docs.
  - Depends on: Task 32.
  - Scope: Small.

- [x] Task 32: Refuse the signed-out `userToken`, and make copying it one line.
  - Acceptance: `{"value":null}` is refused by name, and the fastest extraction step is a copyable console line.
  - Verify: `parseDeepSeekUserToken('{"value":null}')` throws `AUTHENTICATION_FAILED`; `{"value":"real"}` and a bare token still work; an object with no `value` key is still used as-is. The DeepSeek dialog offers one link, one clickable snippet — `copy(JSON.parse(localStorage.userToken).value)` — and one `Connect` button. 390 tests pass.
  - Findings: probed the live site, and **`userToken` is `{"value":null,"__version":N}` when nobody is signed in** — that is the signed-out placeholder, and it is what the page actually stores. The parser fell through to "treat the raw string as the token", so that null wrapper became a **credential**: it looked valid, was accepted, and the failure surfaced much later as DeepSeek refusing a session nobody could explain. Deciding on **presence of the `value` key** rather than its emptiness matters: `{"other":"x"}` is some other object pasted by mistake and is used as-is, while `{"value":null}` is the signed-out state and is named as such. The old sign-in window had the identical hole — it read the null wrapper and declared itself signed in immediately, which is why the window "opened the home page and nothing happened". Also: extraction is now a **console one-liner** rather than a DevTools navigation, because the navigation is where people go wrong — a mis-click yields a cookie object or the signed-out placeholder, and neither is obvious at the point of failure. `copy(document.cookie)` for ChatGPT Web, `copy(JSON.parse(localStorage.userToken).value)` for DeepSeek.
  - Files: `packages/omnihilbras-sdk/src/adapters/deepseek-web.ts`, `src/components/WebCookieConnectDialog.tsx`, `src/lib/webSessionProviders.ts`, tests, docs.
  - Depends on: Task 31.
  - Scope: Small.

- [x] Task 31: Remove the separate-browser sign-in entirely. One button, and it opens in your browser.
  - Acceptance: the connect dialog has one sign-in control, it opens the provider in a new tab in the current browser, and nothing in the gateway launches a browser.
  - Verify: the DeepSeek dialog shows one link — `Open chat.deepseek.com`, `target="_blank"` — and the only button is `Connect`. `POST /v1/oauth/chatgpt/start` and `GET /v1/oauth/deepseek/status` are now `404`; `POST /v1/web-cookie/deepseek/connect` is `400` on an empty body and `POST /v1/connections` is `200`. 388 tests pass.
  - Findings: the user reported the window "opens the home page of DeepSeek and nothing happens" — **it was broken**, not merely surprising: the flow navigated but never detected the sign-in, so it sat there indefinitely. On top of that it was a second button next to the paste path, so the dialog offered two ways to connect and one of them silently failed. Two buttons, one broken and unexplained, is worse than one honest path, so the window flow is **removed rather than demoted**: both sign-in modules, both session stores, four service methods, four routes and thirteen tests are gone. The persistent profile is still used for *turns* when it happens to be signed in — it is just no longer how a connection is made. The trade-off, stated plainly: a pasted credential is replayed into the gateway's browser on each turn rather than the browser keeping it fresh, so the Cloudflare clearance can go stale and an edge challenge is somewhat more likely than with a signed-in profile. That is the cost of the user's choice, and it is the right trade for "do not open a window I did not ask for".
  - Files: `src/components/WebCookieConnectDialog.tsx`, `src/lib/webSessionProviders.ts`, `apps/gateway/src/service.ts`, `apps/gateway/src/server.ts`, `apps/gateway/src/index.ts`, deleted `chatgptWebSignIn.ts` / `deepseekWebSignIn.ts` and their tests, docs.
  - Depends on: Task 30.
  - Scope: Medium.

- [x] Task 30: Say why a separate window opens, and offer signing in inside the browser instead.
  - Acceptance: the reason is stated *before* the click, and there is a link that opens the provider in the user's own tab.
  - Verify: the DeepSeek dialog now contains "A separate browser window will open on your desktop…" and a `Sign in inside this browser instead` link pointing at `https://chat.deepseek.com`, `target="_blank"`. 401 tests pass.
  - Findings: the complaint was "it does not open a new tab in the browser I am using, it opens another browser" — and the copy was silent about it, so a required behaviour read as a bug. **The window cannot be removed**: the session is read out of a browser profile OmniHilbras owns (`launchPersistentContext` against `~/.config/omnihilbras/<provider>/<hash>`), and a tab in the user's own browser is a different browser whose cookies and localStorage are not readable from here. So the fix is to say that first and give the other route a real link: sign in inside this browser, copy the `userToken` from localStorage, paste it. The extraction guides now also open with "With … open and signed in **in this browser**", because the copy path is now a first-class route rather than a fallback. What was genuinely wrong was not the window but the silence.
  - Files: `src/components/WebCookieConnectDialog.tsx`, `src/lib/webSessionProviders.ts`, docs.
  - Depends on: Task 29.
  - Scope: Small.

- [x] Task 29: Stop calling a CORS refusal "offline".
  - Acceptance: a 403 from the gateway is reported as a refusal with its own wording, not as an outage.
  - Verify: on `http://localhost:5173` the badge reads `Gateway online` with 13 cards. The refusal case was reproduced by hand — `Origin: http://localhost:4173` is answered `403 CORS_ORIGIN_DENIED` while `:5173` gets `200` — and the two are now distinct states with distinct wording. 401 tests pass.
  - Findings: **the cause of four "restart the servers" requests was a stray `vite preview` I had left running on :4173** during browser verification, and a `pkill` that matched the wrong pattern missed it. The gateway was up the whole time and correctly refusing an origin that is not its dashboard; only the browser could not read the 403, so it looked like a dead server. Two lessons, both about my own process: leaving a server running after a verification attempt, and reporting a refusal as an outage. The second is the durable fix — `Gateway refused this page` / `this page's origin is not allowed` now says what is actually true, so the next person does not restart a correct server.
  - Files: `src/lib/useGatewayStatus.ts`, `src/components/DashboardShell.tsx`, docs.
  - Depends on: Task 28.
  - Scope: Small.

- [x] Task 28: Make the gateway badge tell the truth, and make an offline page recover by itself.
  - Acceptance: the badge reflects a real probe, and a page whose only request failed reloads itself when the gateway returns — with no manual refresh.
  - Verify: with the gateway stopped the sidebar read `Gateway offline` in red and `not answering · pnpm dev:gateway`; with it restarted, **without a reload**, it read `Gateway online`, `localhost:8787 · local mode`, 13 cards. The provider list also painted 13 cards immediately instead of after ~24 s. 401 tests pass.
  - Findings: **the badge was the literal string "Gateway online"** — it asserted rather than asked, so during an outage the dashboard reported the one thing that was false, and looked correct afterwards so nobody had cause to distrust it. And a page that failed its only request made **no further requests**, so nothing could ever notice the gateway coming back; the offline message was the last thing the tab ever said and the only exit was a manual reload. Both are fixed by a 4 s poll of `/v1/connections`, which answers in ~5 ms. A caveat worth writing down: the poll had to use the **absolute** gateway base — a relative `/v1/connections` reaches Vite, which answers 200 with the app's own HTML, so the badge would have reported the gateway as up for as long as it was down. Separately, `/health` (24 s, probes every provider) was awaited **before** the connections on the list, so the list sat empty for 24 seconds on every load; connections now set first and health refines them.
  - Files: `src/lib/useGatewayStatus.ts` (new), `src/lib/gatewayClient.ts`, `src/components/DashboardShell.tsx`, `src/pages/ProvidersPage.tsx`, `src/pages/ProviderDetailPage.tsx`, docs.
  - Depends on: Task 27.
  - Scope: Medium.

- [x] Task 27: Stop the provider list opening the API-key modal for a web-session provider.
  - Acceptance: Connect on a web-session card goes to the page that can actually sign you in, and no path opens the API-key modal for a provider with no API key.
  - Verify: 401 tests pass; typecheck and build clean. **The browser click-through could not be completed** — the dev server's module fetches keep failing with `ERR_NETWORK_CHANGED` on this network and the built bundle serves the marketing site at `/dashboard/providers`, so both routes to verifying it were blocked. The change is three lines and unambiguous, but it is unverified in the browser and should be checked by hand.
  - Findings: `AddProviderModal` collects an **API key**, and `resolveProviderOption` falls through to `providerCatalog` for anything it does not recognise — so clicking Connect on DeepSeek resolved to a catalog entry and opened an API-key dialog for a provider that has no API key. The user saw a dialog for a different provider entirely. The dialog that knows how to sign in (`WebCookieConnectDialog`) only ever rendered on the **detail** page; the list had no idea it existed. Fixed at two levels: the list's Connect now navigates to the provider's page for a web-session provider, and `openAdd` itself refuses one, so no future caller can repeat it. `isWebSessionProvider` is exported from the modal so the check is available rather than re-derived.
  - Files: `src/pages/ProvidersPage.tsx`, `src/components/AddProviderModal.tsx`.
  - Depends on: Task 26.
  - Scope: Small.

- [x] Task 26: Fix the last three hardcoded provider strings, and add the Qwen card honestly.
  - Acceptance: no provider-specific string lives in the dialog, and the Qwen card exists without offering an action that cannot work.
  - Verify: the DeepSeek dialog reads "Sign in with DeepSeek" and contains no occurrence of "ChatGPT"; its paste section reads "Or paste a userToken instead"; the Qwen card reads "Not built yet" with the reason and has no Connect button. 401 tests pass.
  - Findings: **five** provider-specific strings were hardcoded in the dialog, not one. I had claimed the class of bug was fixed after moving the sign-in blurb, and then left the button label, the waiting message, the no-display message, the paste section label and the field label — so DeepSeek's dialog said "Sign in with ChatGPT" and offered to paste a "session cookie". Fixing the one I noticed did not fix the class, which is the actual lesson. **The Qwen card exists and is honestly marked**: `status: 'planned'`, a required `unavailableReason` naming the TMD captcha, and **no Connect button in either card view** — the simple list card and the advanced card each had their own button, and the first one guarded was not the one the list renders. Also found, not fixed: **`GET /health` takes 24 seconds** because it probes all twelve providers on every call, and `ProvidersPage` awaits it *before* setting connections, so the whole list waits on it. Pre-existing and separate.
  - Files: `src/components/ProviderCard.tsx`, `src/components/WebCookieConnectDialog.tsx`, `src/lib/webSessionProviders.ts`, `src/pages/ProviderDetailPage.tsx`, `src/data/providers.ts`, docs.
  - Depends on: Task 25.
  - Scope: Medium.

- [x] Task 25: Add DeepSeek Web, and work out that Qwen Web is not worth a card.
  - Acceptance: a DeepSeek Web card that connects by signing in or by pasting a `userToken`, and a request path with no browser in it.
  - Verify: `POST /v1/oauth/deepseek/start` returns 201; an invalid `userToken` is refused with **DeepSeek's own answer** — `PROVIDER_REQUEST_FAILED`, "DeepSeek rejected the sign-in: Authorization Failed (invalid token)" — and no connection is created; 14 models; both cards render and the DeepSeek dialog names `chat.deepseek.com`; 401 tests pass.
  - Findings: the request path is plain HTTP with a bearer credential, so **no browser is in it at all** — a browser is involved only in obtaining the credential, once. `userToken` authorises `users/current` and **nothing else**; sending it at the completion endpoint gets a 401 that looks exactly like an expired session, so the two are exchanged and the access token cached. The credential is in **localStorage, not a cookie**, so `context.cookies()` returns nothing useful and the connection looks signed out forever; it is stored sometimes as `{"value":"…"}` and sometimes bare, so both are read. The endpoint takes one flat `prompt`, so history is flattened with turns labelled — a bare join of `["You are terse.", "2+2?"]` loses which was which. The SSE append frames often arrive with **no `type`**, so `thinking_enabled` from the last whole response decides the reasoning/content split; treating every append as the answer is how a model that thinks first answers with its reasoning. **Qwen Web: the catalog is open (three models, 1M ctx, visitor access, unminified `POST /api/v2/chat/completions`) and the turn is refused by Alibaba's TMD anti-bot**, which returns a captcha that must be rendered in a browser; a guest has no XSRF cookie either. A catalog and no card. Two findings kept: calling the endpoint from inside the page **kills the renderer**, because buffering an endless SSE stream with `response.text()` does — which is why a Qwen driver must read incrementally with a cap. The generalised dialog still shipped a **hardcoded ChatGPT sentence telling DeepSeek users a chatgpt.com window was about to open**, caught by looking at the rendered dialog rather than the code; that is why every provider now supplies its own note.
  - Files: `packages/omnihilbras-sdk/src/adapters/deepseek-web.ts`, `adapters/deepseek-pow.ts`, `apps/gateway/src/deepseekWebSignIn.ts`, `src/service.ts`, `src/server.ts`, `src/lib/webSessionProviders.ts`, `src/components/WebCookieConnectDialog.tsx`, `src/data/providers.ts`, tests, docs.
  - Depends on: Task 24, and the proof-of-work work in commit 8f9db84.
  - Scope: Big.

- [x] Task 24: Sign in to ChatGPT Web in a browser window, and make the profile the fast path.
  - Acceptance: one button signs in and saves a working connection; the manual paste survives as a fallback; a turn afterwards still answers.
  - Verify: `POST /v1/oauth/chatgpt/start` returned `headed: true`; the first status poll returned `connected` with plan `Free` and a connection carrying 13 models; the next poll correctly reported the session already completed; two live turns then returned `'working'` (20s, 97s). 371 tests pass.
  - Findings: the profile **already held the session on disk** — a 72 KB cookie store in `~/.config/omnihilbras/chatgpt-web/` — so keeping it is not a new security model, discarding it is. The fragility is entirely in moving the credential *by hand*, and all of it goes away: which cookie, the `Cookie:` prefix, the numbered chunks, the truncated header, and an unknown plan. The session is now read out of the browser that created it, so the Cloudflare clearance the edge set is the one that gets kept. **The profile became the fast path and the vault the fallback** — injecting stored cookies on every turn would overwrite a fresher session (the clearance rotates) with a stale copy, which is how a working provider starts failing for no visible reason. A poll is **claimed before the page is read**, or two concurrent polls save two connections from one sign-in; sessions are swept because a leaked window is a signed-in session left open on a desktop. The **terms position is unchanged** and the warning stands. Also fixed: `btn-primary`/`btn-secondary` **were not real classes** — nothing in the stylesheet defines them, so the connect buttons here and every button in `KiroConnectDialog` had been rendering unstyled since they were written; and there was **no `:disabled` styling anywhere**, so an unclickable button looked identical to a clickable one.
  - Files: `apps/gateway/src/chatgptWebSignIn.ts` (new), `src/chatgptWeb.ts`, `src/service.ts`, `src/server.ts`, `src/components/WebCookieConnectDialog.tsx`, `src/components/KiroConnectDialog.tsx`, `src/index.css`, `apps/gateway/test/chatgpt-web-signin.test.js` (new), docs.
  - Depends on: Task 23.
  - Scope: Big.

- [x] Task 23: Build the ChatGPT section properly — the 13-card catalog, the credential guide, and a check that checks.
  - Acceptance: the catalog matches the reference's product surface, every card resolves, and a check catches a revoked session.
  - Verify: the connection reports 13 models; `POST /v1/web-cookie/chatgpt/check` returns `verified: true` for the real session and `AUTHENTICATION_FAILED` for a deliberately invalid one; both free models still answer `'working'`; 366 tests pass.
  - Findings: **the plan must not narrow the catalog.** `resolveChatGptWebSelection` never consults it — it maps an id onto a selection and lets the page refuse — so gating the catalog was a second, different rule, and a wrong gate is not symmetric: a model shown that cannot be used costs one visible failure, while a model hidden that can be used hides something that works. Also: **the reference's own page advertises ids its resolver refuses** (effort-suffixed ones), so the cards and the resolver are now one table with a test asserting every card resolves; **Pro must not ask for thinking** — `reason` is a hint the page does not honour there, and deriving it as `effortIndex > 0` sent it anyway, so the rule moved into the SDK; `gpt-5.5-pro-extended` is an **alias of pro**, not a distinct request, and ChatGPT exposes no wire model for it. The **parser refused the Cookie header** the guide told you to paste, while its own error said "paste the cookie header instead" — now accepted, allowlisted, with the token reassembled from its numbered chunks and a cut-short set refused by name. A **check that only parses accepts a dead session**, so it opens the page — and measured against a real and a fake session, **every DOM marker is identical**, so the only signal is the plan badge in the page text, polled for 15s. Every driver failure now carries a real cause (a challenge is `PROVIDER_UNAVAILABLE`, a sign-in wall is `AUTHENTICATION_FAILED`) because both arrived as `INTERNAL_ERROR`. And gating discovery on `policy === 'all'` made a free-only connection **unrefreshable**.
  - Files: `packages/omnihilbras-sdk/src/adapters/chatgpt-web.ts`, `apps/gateway/src/chatgptWeb.ts`, `apps/gateway/src/service.ts`, `apps/gateway/src/server.ts`, `src/components/WebCookieConnectDialog.tsx`, `src/pages/ProviderDetailPage.tsx`, tests, docs.
  - Depends on: Task 22.
  - Scope: Big.

- [x] Task 22: Make a ChatGPT turn through ChatGPT's own request path, which is what actually works.
  - Acceptance: a real turn returns a real answer through the gateway, on a real session.
  - Verify: `POST /v1/chat/completions` with `x-omnihilbras-provider: chatgpt-web` returns 200 and `content: "working"` for "Reply with the single word: working", and `"4"` for "What is 2+2?" — three consecutive successes in 20s, 24s and 37s. 8 gateway tests on the pure half, 341 total.
  - Findings: **typing into the composer does not work.** The request is accepted, a placeholder appears, and the page sits at "Think" indefinitely — signed in, plan known, composer accepting keystrokes, the send button enabled, the message posted. The composer path is simply not how a programmatic client makes a turn. What works is the page's own path: its Sentinel requirements, its proof-of-work and Turnstile tokens, its request client, and `POST /f/conversation`. The module is found by scanning the page's assets for **semantic markers** and reading the minified names out of the trailing `export{…}` block; all four markers are in one 2.6 MB chunk today, which imports directly and yields 4 074 exports. Three things had to be found rather than assumed: the asset is imported **directly**, because a generated blob module re-exporting from it fails with a bare "Failed to fetch dynamically imported module" that names no cause; only a first-party `/cdn/assets/*.js` URL is ever fetched, since the candidate list comes off a live page and is untrusted input; and the delta stream is JSON Patch **objects** whose `append` concatenates — reading it as a replace keeps only the last fragment, and reading the value out of JSON Patch's third slot writes `undefined` at every path, both of which read as a model that answered nothing. Also: the temporary-chat URL triggers the first-use onboarding modal and failed to navigate, so the plain landing page is used. **Not perfectly reliable** — a fetch inside ChatGPT's own code can fail on the network and gets exactly one retry; anything else is raised as a real failure so a broken session is not retried into looking intermittent. Attachments are not implemented.
  - Files: `apps/gateway/src/chatgptFirstParty.ts`, `src/chatgptWeb.ts`, `apps/gateway/test/chatgpt-first-party.test.js`, `packages/omnihilbras-sdk/src/adapters/chatgpt-web.ts`, docs.
  - Depends on: Task 21.
  - Scope: Big.

- [x] Task 21: Replace the invented ChatGPT model ids with the observed ones, and fix catalog refresh.
  - Acceptance: the catalog carries ids the web tier actually serves, and a refresh can remove a model.
  - Verify: `listModels()` for a free session returns `auto, auto-thinking` and the paid family is refused by name; a refresh on the live connection drops the stale `gpt-5.2` ids and the result survives a reload from disk. 42 ChatGPT Web tests, 329 total.
  - Findings: **every model id in the first catalog was invented** — `gpt-5.2`, `gpt-5.1`, `gpt-5-mini` — and none of them exist. The real ones are untidy, which is why tidy guesses were so easy: `gpt-5-6`, `gpt-5-6-thinking`, `gpt-5-6-pro`, `gpt-5-5`, `gpt-5-5-thinking`, `gpt-5-5-pro`, recorded upstream as "observed from first-party ChatGPT Pro and Free UIs". **And then it got it wrong a second way**: the first correction published `auto` as a model id, but `auto` is the string the *page* is given when an account is free and has no picker — not something a client can ask for. `resolveSelection` maps a client id onto a **UI selection** (a model label plus an effort index), and that is what the page is driven with; anything outside the set throws, so an unresolvable id is now refused before a browser launches while a known one is left to the page, since `resolveSelection` never consults a plan. Two more real bugs surfaced because the stale ids survived a refresh that returned 200: `updateModels` **unioned instead of replacing**, and its additive path files every addition as a *custom* model, so a withdrawn model is kept forever and becomes impossible to remove; and the persistent store's `updateModels` and the in-memory one had drifted, the latter quietly lacking `replace`. With the right model and the right access, **a turn still does not complete** — the page renders only `request-placeholder-request-WEB:…-0` and sits at "Think". Reading the answer is the remaining work, and the reference does it by driving ChatGPT's own JS module rather than selectors.
  - Files: `packages/omnihilbras-sdk/src/adapters/chatgpt-web.ts`, `test/chatgpt-web.test.js`, `apps/gateway/src/connections.ts`, `apps/gateway/src/service.ts`, docs.
  - Depends on: Task 20.
  - Scope: Medium.

- [x] Task 20: Unblock access to chatgpt.com, and correct the diagnosis.
  - Acceptance: the page loads and a turn is submitted, instead of a 403 at the edge.
  - Verify: measured on one machine, one session, one engine, varying one thing at a time — default UA gives 403 with `Just a moment...`, a real Chrome UA gives 200 with a composer present, and headed/full-Chromium make no difference. The composer accepts `pressSequentially` and the send button then reports `aria-disabled="false"`. 324 tests pass.
  - Findings: **the 403 was Playwright's default headless user agent, which substitutes `HeadlessChrome/151.0.7922.34` into the real Chrome string.** The address was never the problem, and the earlier "this is environmental, try a residential connection" note was wrong. Setting a real user agent, with a matching locale and timezone, fixes access outright. Three further things were needed to get a turn submitted, none obvious: a **persistent profile**, because the first-use "Temporary Chat" modal otherwise reappears every request holding focus and intercepting Send; **real keystrokes**, because the composer is ProseMirror and `fill()` sets the DOM without the input events React watches, leaving the send button permanently disabled; and clicking through `data-testid="modal-temporary-chat-onboarding"`, which ignores Escape. Also: `waitForFunction` must take a function, since a string is evaluated with `eval` and the page's CSP forbids `unsafe-eval`; and waiting for the stop button to disappear is the wrong completion signal, because the button stays in the DOM after a turn ends, so that wait never returns.
  - **Still not working:** no turn has produced an answer. The request posts, the page renders only `data-message-id="request-placeholder-request-WEB:…-0"` with no text, and sits at "Think" indefinitely, on a free-plan account. The reference project completes turns on this same machine by discovering ChatGPT's own JS module at runtime and performing an explicit model *selection*, never hardcoding a selector — which is the most likely place the remaining difference lies. Access is solved; completion is not. The card says so.
  - Files: `apps/gateway/src/chatgptWeb.ts`, `packages/omnihilbras-sdk/src/adapters/chatgpt-web.ts`, docs.
  - Depends on: Task 19.
  - Scope: Big.

- [x] Task 19: Make the ChatGPT Web refusal say what it is, instead of looking like a broken model.
  - Acceptance: a model test against a blocked address reports the block, with the reason intact.
  - Verify: `POST /v1/chat/completions` for `chatgpt-web` returns `PROVIDER_UNAVAILABLE` and the full sentence, in place of `Every provider route failed`. Three tests.
  - Findings: the block **was** being detected, but too early to fire. A Cloudflare challenge is not present the instant `goto` returns — the 403 comes back in 0.8s with an empty title and the interstitial only appears a few seconds later — so the pre-flight check saw nothing, the composer wait then ran to its timeout, and the result was reported as a 60-second timeout with no cause. The page is now re-read whenever a wait fails, and a page that loaded without a composer reports its own title and body text rather than nothing. Separately, the driver's failures were plain `Error`s, so crossing the routing layer they collapsed into "Every provider route failed" and the reason was discarded: a refused request was being reported as a broken model. They are now raised as provider errors, with a block classified as an outage and an ordinary page failure left as a request failure.
  - Files: `apps/gateway/src/chatgptWeb.ts`, `packages/omnihilbras-sdk/src/adapters/chatgpt-web.ts`, `test/chatgpt-web.test.js`.
  - Depends on: Task 18.
  - Scope: Small.

- [x] Task 18: Accept the real ChatGPT export, chunk the oversized cookie, and gate the catalog on the plan.
  - Acceptance: a genuine CLI/Codex auth export connects, and a free-plan account is not offered paid models.
  - Verify: a real export is stored with its session cookie, `planType: free` and `expiresAt`, and round-trips all three; a real request reaches the browser and is refused by name as a block page. 34 SDK tests.
  - Findings: **the real export shares no keys with a Playwright storage state.** It is `{ accessToken, sessionToken, expires, account }` with no `cookies` key, so the storage-state parser rejected a genuine session with "That JSON has no `cookies` array" — the bug that was reported. `sessionToken` *is* the session cookie's value. Two fields are now carried through: `expires`, so a dead session is known before a browser launch, and `planType`, which is real entitlement and decides the catalog — a free plan gets 3 models, not the 6 that were invented, and an unrecognised plan gets the full set because a visible failure beats a hidden model. **The session token is ~5 KB and Chrome caps one cookie at 4096 bytes**, so `addCookies` failed the whole batch with `Invalid cookie fields`, which names no field and is not about the fields at all; found by varying one at a time against a real session. NextAuth already chunks oversized session cookies, and the driver now does the same, verified to reassemble byte for byte. `listModels()` also threw without a credential, which would have left a saved connection with no models. **And the answer to whether it works: no.** chatgpt.com serves `Just a moment...` — a Cloudflare interstitial with an empty body — *with a valid session loaded*, so the premise the design rests on is defeated at the edge and the selectors remain unconfirmed. The block is environmental.
  - Files: `packages/omnihilbras-sdk/src/adapters/chatgpt-web.ts`, `test/chatgpt-web.test.js`, `apps/gateway/src/chatgptWeb.ts`, docs.
  - Depends on: Task 17.
  - Scope: Medium.

- [x] Task 17: Give ChatGPT Web the ChatGPT logo, not OpenAI's.
  - Acceptance: the card shows ChatGPT's own mark.
  - Verify: the asset is ChatGPT's blossom path from OpenAI's own asset CDN, not a copy of `openai.svg`; the geometry differs from the OpenAI knot (4091 vs 1554 path characters); the SVG parses with no `<style>`, no script and no external reference; rasterised it renders the six-loop blossom.
  - The first version copied `openai.svg`, which is OpenAI's hexagonal knot — a different company's mark, and the wrong one to label a ChatGPT card with. Two errors, actually: `chatgpt.com` itself is 403 from here, so the mark comes from `cdn.oaistatic.com`. Upstream's file is a 16-unit favicon with a `prefers-color-scheme` block and a white background rect; the geometry is taken and the chrome dropped, so the glyph is white on transparent like every other card mark and there is no embedded stylesheet to collide with the dashboard's.
  - Files: `public/providers/chatgpt.svg`.
  - Depends on: Task 16.
  - Scope: Small.

- [x] Task 16: Add a Web Cookie Providers group with ChatGPT Web, behind a high-severity warning.
  - Acceptance: a new group holds a ChatGPT Web card that connects by pasting an exported session, and the credential warning is acknowledged before anything is stored.
  - Verify: the group renders between API Key and Local with one card; the card badge reads `ACCOUNT SESSION`, not `TERMS`; the dialog shows the warning, four export steps, and a paste field disabled until the box is ticked. `POST /v1/web-cookie/chatgpt/connect` accepts a real-shaped storage state (201, 6 models) and refuses non-JSON, an export with no OpenAI cookies, and a missing field. Only `chatgpt.com`/`openai.com` cookies survive — `notopenai.com` and `chatgpt.com.evil.example` are dropped. A bad paste shows the reason and clears the field. 23 SDK tests.
  - Findings: **the browser half has never seen the real application.** `chatgpt.com` returns its anti-bot block page from the development machine (`Unable to load site … Ray ID:…`), so `#prompt-textarea` and `[data-message-author-role="assistant"]` are ChatGPT's documented test hooks used on the assumption they are current. That is stated on the card, not buried. A stale session and a blocked request both render a real page with no composer, so they are told apart: a sign-in link means re-export, the block page's own wording means the network. The generic API-key modal was also opening underneath the right one, since `auth: 'Web cookie'` is not `isOauth` — suppressed. The reference project hardcodes no selector at all; it discovers ChatGPT's own JS module at runtime and drives their internal API. The version here is the maintainable one and the fragile one, traded knowingly.
  - Files: `packages/omnihilbras-sdk/src/adapters/chatgpt-web.ts`, `test/chatgpt-web.test.js`, `apps/gateway/src/chatgptWeb.ts`, `service.ts`, `server.ts`, `src/components/WebCookieConnectDialog.tsx`, `src/components/ProviderCard.tsx`, `src/data/providers.ts`, `src/pages/ProviderDetailPage.tsx`, `public/providers/chatgpt.svg`, docs.
  - Depends on: Task 15.
  - Scope: Big — a new group, a new auth shape, and a browser dependency in the gateway.

- [x] Task 15: Give the Kiro card its logo, which it never had.
  - Acceptance: the Kiro card and page show Kiro's own mark rather than a letter.
  - Verify: `/providers/kiro.svg` is served as `image/svg+xml` and both the card and the provider page render it as an `<img>` at 1200×1200.
  - The mark is Kiro's own favicon, fetched from the CDN `app.kiro.dev` declares, rather than drawn or approximated: a `#9046FF` rounded square with the white ghost. A `kiro.png` was already tracked in the repo and matched the same artwork, but at 128px raster where the source is a 1200-unit vector, so the vector replaces it and the raster is removed. The card's `color` moved from `#ff6b35` (OmniRoute's Material-icon tint) to the logo's own `#9046ff`, so the fallback letter mark and the badge sit in the brand colour too.
  - Files: `public/providers/kiro.svg`, `src/data/providers.ts`.
  - Depends on: Task 14.
  - Scope: Small.

- [x] Task 14: Fix Kiro inference, and add its five other ways to connect.
  - Acceptance: a real Kiro request returns an answer, and the six sign-in methods are each wired to their own exchange rather than one generic paste box.
  - Verify: `POST /v1/chat/completions` with `x-omnihilbras-provider: kiro` returns real text, `finish_reason: stop`, and a `meters.credit` figure. The framing tests run against `test/fixtures/kiro-stream.bin`, a real captured 7-frame response. Device flow returns 201 with a real AWS code; an unapproved session polls as `pending`; a non-`awsapps.com` start URL is refused before any call; Google/GitHub return a real PKCE URL whose verifier never leaves the gateway; a pasted code is spent at most once. In the browser all six methods are listed and disabled until the risk is ticked, and a failed test row shows the provider's reason.
  - Findings: **v0.11.0's Kiro could not complete a single inference.** The answer is the binary AWS eventstream, not the text framing the first parser was written against — so every request returned 200 and every one failed with `INVALID_RESPONSE`, indistinguishable from a provider that answered nothing. The tests passed throughout because they were built from the same wrong assumption. Three further details, each a wrong guess first: header names carry a leading **colon** (`:event-type`), the payload is **flat** rather than nested under the event name, and there is **no `messageStopEvent` and no `usageEvent`** — a real response is `assistantResponseEvent`, `contextUsageEvent`, `meteringEvent`. `total_length` counts itself, so frames are walked by length. The transport decoded bodies as text, which mangles a binary stream into something that reads as empty, so `HttpRequest` now takes `responseAs: 'bytes'`, bounded like the text path. Kiro meters credits, so `usage` is left unset rather than reported as zero and the cost rides in its own `meters` field. Availability is per account: `400 Invalid model` becomes "Your Kiro plan does not offer X", since that is an entitlement and not a broken connection. Social sign-in cannot return to the gateway at all — the whitelisted redirect is `kiro://` — so the code is pasted back, with the PKCE verifier kept gateway-side. A company start URL is validated against `*.awsapps.com` because it becomes part of an OAuth grant. 25 Kiro tests, 283 total.
  - Files: `packages/omnihilbras-sdk/src/adapters/kiro.ts`, `src/transport.ts`, `src/types.ts`, `test/kiro.test.js`, `test/fixtures/kiro-stream.bin`, `apps/gateway/src/kiro.ts`, `service.ts`, `server.ts`, `src/lib/kiroAuth.ts`, `src/components/KiroConnectDialog.tsx`, `src/pages/ProviderDetailPage.tsx`, docs.
  - Depends on: Task 13.
  - Scope: Big — the published Kiro surface is replaced, and `HttpRequest` and `ChatResponse` change shape.

- [x] Task 13: Add Kiro to OAuth Providers, with a working sign-in and a non-dismissible terms warning.
  - Acceptance: the card carries a standing caution shown in both card views, on the page, and in the sign-in dialog, where nothing is sent to AWS until it is acknowledged. The sign-in is AWS's device flow and the catalog is served from CodeWhisperer's streaming service.
  - Verify: `POST /v1/oauth/kiro/start` returns 201 with a real AWS device code and `view.awsapps.com/start/#/device`; an unapproved session polls as `pending`; an unknown session is 404. In the browser the dialog shows the warning with an unticked box and no code, and only after ticking it does a real AWS code appear with a manual-link fallback. Kiro is not OpenAI-compatible — it is CodeWhisperer's streaming service, taking a `conversationState` envelope and answering with an AWS eventstream — so it needs its own adapter, with a system turn folded into the user content because the envelope has no system role, and unknown model ids refused before a request is spent. Two defects found by testing against live AWS: the device authorization needs a `startUrl` or AWS answers `400 Start URL is required`; and a pending grant arrives as HTTP 400 with the state in the body, which the provider transport had flattened to its human description, so the sign-in reported failure while the user was still approving it. OAuth token endpoints now read their bodies directly, as the Console poll already did. 15 SDK tests cover the envelope, the eventstream framing, the bare-body fallback, and the refusals.
  - Files: `packages/omnihilbras-sdk/src/adapters/kiro.ts`, `test/kiro.test.js`, `apps/gateway/src/kiro.ts`, `service.ts`, `server.ts`, `src/data/providers.ts`, `src/components/ProviderCard.tsx`, `src/components/OauthConnectDialog.tsx`, `src/pages/ProviderDetailPage.tsx`, `src/lib/gatewayClient.ts`, docs.
  - Depends on: Task 12.
  - Scope: Medium.

- [x] Task 12: Add the TokenHarbor card, with the endpoint checked first.
  - Acceptance: the card resolves to TokenHarbor and to no other provider, appears in the add-provider dropdown, and borrows no other provider's logo.
  - Verify: `GET https://tokenharbor.ai/v1/models` answers `401 {"error":{"message":"Invalid or revoked API key. Rotate your key at https://tokenharbor.ai/dashboard.","type":"invalid_api_key"}}` and `POST /v1/chat/completions` answers the same, so the service is live, the route is `/v1`, and it wants a bearer key — which is what the generic adapter sends. `/api/v1` 404s and `/models` returns HTML, so only `/v1` is the API. Added to the catalog and, separately, to the add-provider dropdown: those are two lists, and although the v0.9.6 resolver makes the card authoritative for *resolution*, the dropdown still reads its own. Verified in the browser: the card renders, the dialog is titled "Add TokenHarbor API Key" and mentions no other vendor, and the dropdown lists TokenHarbor. The card colour `#3859ff` is taken from their stylesheet; they publish no theme-color and the terracotta on their page belongs to an Anthropic section they embed. The logo was supplied as a page snippet and is committed as `public/providers/tokenharbor.svg`. Two things were corrected in it: the `currentColor` fill, which resolves to black through an `<img src>` and would depend on how the file is embedded, is written out as the darkest ink from their own stylesheet; and the Tailwind size class and `img` role, which belong to the page rather than the artwork, are removed. There is a `tokenrouter` asset in the catalog for a different, unrelated service, which this deliberately does not reuse — that would be the same class of mistake as sending a key to the wrong vendor.
  - Files: `src/data/providers.ts`, `src/components/AddProviderModal.tsx`, docs.
  - Depends on: Task 11.
  - Scope: Small.

- [x] Task 11: Filter models by price, modality and context, from the catalog's own metadata.
  - Acceptance: models carry the prices, context windows and modalities their provider published, normalised to one unit; every filter is offered only where the provider published the field it filters on; and an absent field is never read as a zero.
  - Verify: `Model` gains `inputModalities`, `outputModalities` and `pricing`. OpenRouter supplies `context_length`, `architecture.input_modalities` and `pricing.prompt`/`completion` — which its adapter already read for its own free and text-output checks and then discarded — and OpenCode Console supplies `limit.context`, `modalities` and `cost`. The two quote in different units, per-token strings against per-1M numbers, so both are converted to per-1M at the edge with separate converters; guessing the unit would render a price a million times out. Measured live: OpenRouter 452 of 458 priced, 458 with context and modalities, 21 free, 288 accepting image; Console 77 of 77 on all three, 8 free, 64 accepting image. Metadata is captured during discovery, so a save or a models refresh costs no extra provider request, and it is stored compactly and validated on read. In the browser the filters narrow correctly — 8 free, 43 at 1M context, 64 accepting image, all matching the independent SDK measurement — and on Cline, which publishes nothing, the price, modality and context filters are absent, no badges appear, and search, result and sort remain. Two bugs the tests caught: `Number('')` is 0, so an empty price string read as free; and the slowest-first sort put untested models at the top, which the pre-existing rule had deliberately avoided.
  - Files: `packages/omnihilbras-sdk/src/pricing.ts`, `modelFilters.ts`, `types.ts`, `adapters/openrouter.ts`, `adapters/opencode-console.ts`, `test/pricing.test.js`, `test/model-filters.test.js`, `apps/gateway/src/connections.ts`, `service.ts`, `src/pages/ProviderDetailPage.tsx`, `src/lib/gatewayClient.ts`, `package.json`, docs.
  - Depends on: Task 10m.
  - Scope: Medium.

- [x] Task 10m: Never let a provider id resolve to a different vendor.
  - Acceptance: a card resolves to its own option and endpoint whether or not the dialog's list knows it, and an unknown id resolves to the neutral custom option rather than to a named vendor. A key must never be transmitted to a provider the operator did not name.
  - Verify: adding the NaraRouter card without adding it to the dialog's own option list made the dialog fall back to `providerOptions[0]`, which is OpenAI — so the dialog was titled "Add OpenAI API Key", carried `https://api.openai.com/v1`, and a NaraRouter key was validated against and transmitted to OpenAI, which replied with its own "Incorrect API key provided" shape. Verified fixed in the browser: the dialog is titled "Add NaraRouter API Key", references NaraRouter and not OpenAI, and the check request goes to `/v1/connections/nara-router` and returns NaraRouter's own `A valid API key is required.` The stale "Preview mode: this provider connection is not sent to the gateway yet" copy is corrected too, since the key demonstrably does reach the loopback gateway. `src/` has no test runner, so this is browser-verified rather than covered by an automated test.
  - Files: `src/components/AddProviderModal.tsx`, `src/data/providers.ts`, docs.
  - Depends on: Task 10l.
  - Scope: Small.

- [x] Task 10l: Stop discarding the provider's explanation, and stop treating a 403 as an auth failure.
  - Acceptance: a refusal names the provider's reason on every provider, and a refused request cannot eject a connection that is otherwise healthy.
  - Verify: two defects with one cause visible between them. First, the transport cancelled the error body unread and passed `undefined` to the classifier, so `providerErrorDetail` never had anything to work with and every refusal on every provider arrived with no reason — the body is now read on both the request and stream paths, bounded to 64 KB and JSON-parsed when it is JSON. Second, a 403 mapped to `AUTHENTICATION_FAILED`, which is a terminal route code, so one refused free model ejected the connection and took seventy working models with it; only a 401 is an auth failure on status alone, and Cline and OpenRouter already raise it deliberately. Measured live on `/inference/openai/v1` with a Console session: refused model now reports "OpenCode's free tier can only be used from within OpenCode", the following request on the same connection answers 200, and the pattern repeats. The dashboard tooltip carries the provider's words, taken from `providerMessage`, which is only sent to a trusted local dashboard origin. Seven tests cover the status mapping, and the body-extraction case fails against the old behaviour.
  - Files: `packages/omnihilbras-sdk/src/transport.ts`, `test/status-mapping.test.js`, `src/lib/gatewayClient.ts`, docs.
  - Depends on: Task 10k.
  - Scope: Medium.

- [x] Task 10k: Send `x-org-id` to the config endpoint, un-double the Anthropic lane, and add a model re-scan.
  - Acceptance: the Console config is read with the header it demands, a credential without an org recovers on its own, the Claude lane reaches the endpoint, and a connection saved with no models can be repaired without signing in again.
  - Verify: the connection saved with 0 models because `GET /api/config` answered `400 {"code":"org_required","message":"x-org-id is required"}` — the config call wants `x-org-id` while inference wants `x-opencode-org-id`. Measured: no header 400, `x-org-id` 200 with 77 models, `x-opencode-org-id` 400. The adapter now looks the org up from `/api/orgs` when the credential has none, so a credential saved before the org was captured recovers instead of failing forever; the stored connection went 0 to 77 models. The Anthropic lane was a second doubled path: `AnthropicAdapter` appends `v1/messages` to a base already ending in `/v1`, so Claude asked for `/v1/v1/messages` and got 404; corrected it now answers 402 Insufficient account funds, which is the endpoint working. `POST /v1/connections/:id/models/refresh` re-reads a saved catalog and keeps custom models. Also corrects a v0.9.2 claim: the config issues an `org_` id matching the orgs list, not a `wrk_` one, and the `403 Workspace access denied` measurement that suggested otherwise came from an id invented by swapping prefixes onto a real value.
  - Files: `packages/omnihilbras-sdk/src/adapters/opencode-console.ts`, `test/opencode-console.test.js`, `apps/gateway/src/opencodeConsole.ts`, `service.ts`, `server.ts`, docs.
  - Depends on: Task 10j.
  - Scope: Medium.

- [x] Task 10j: Claim the device exchange, and start the sign-in once per dialog.
  - Acceptance: two overlapping polls cannot spend the same single-use device code, and a re-render cannot mint a second one. Both are proven by tests that fail without the fix.
  - Verify: a device code dies the moment the token is issued, and the dashboard polls every second while saving a connection takes longer, so two polls overlap. The losing poll was told `The device code is invalid` and overwrote a success — matching the reported symptom exactly, where the Console showed "Device authorized" and the dashboard showed "The device code is invalid". The exchange is now claimed before the Console is called and a pending claim is released so the next poll may retry. Separately, `onConnected` and `onClose` are inline arrows, so their identity changes each render, which rebuilt the start callback and requested a fresh device code on every render while the browser was sent to whichever was minted last. A ref guard makes it start once. Four service-level tests drive the real method against a stubbed Console that treats the grant as dead after use; the overlapping-poll test was confirmed to fail with the claim removed and pass with it restored. In the browser, twelve forced re-renders produce exactly one start call.
  - Files: `apps/gateway/src/service.ts`, `apps/gateway/test/opencode-console-race.test.js`, `src/components/OauthConnectDialog.tsx`, docs.
  - Depends on: Task 10i.
  - Scope: Small.

- [x] Task 10i: Take the org id from the Console config, and stop a catalog read failing a sign-in.
  - Acceptance: the org id sent with inference requests is the one the Console's own config hands out, a sign-in the user approved is not thrown away because the catalog would not read, and a failure names the provider's reason instead of a generic refusal.
  - Verify: the config issues a `wrk_` workspace id and the orgs list carries `org_` ids, and the live lane answers `403 Workspace access denied` for the `org_` form while `wrk_` and an absent header both answer `200`. `/api/orgs` is also `401` for an API key, so it is read for the org name only. Separately, the transport's generic 4xx message was being shown instead of the provider's words, so a real reason never reached the user; the provider detail is now surfaced the way the Cline sign-in already does. Model discovery is tolerated for this provider only, so a session the user just approved is kept and the reason is carried on the sign-in status. 14 gateway tests, including one that pins the workspace-id-over-orgs-list ordering and one that an unreadable config degrades to the orgs list rather than losing the org.
  - Files: `apps/gateway/src/opencodeConsole.ts`, `apps/gateway/test/opencode-console.test.js`, `apps/gateway/src/service.ts`, `src/components/OauthConnectDialog.tsx`, docs.
  - Depends on: Task 10h.
  - Scope: Small.

- [x] Task 10h: Fix the Console verification URL, which pointed at the API host.
  - Acceptance: the device page opens on the Console web host, and the dashboard says what to expect when the browser has no Console session.
  - Verify: the Console serves its API from `console.opencode.ai` and its pages from `opencode.ai`. `verification_uri` is relative, so joining it to the API host produced `/console/console/device`, which renders a blank page and presents as a sign-in that did nothing. Reproduced live: the doubled path was reached, the corrected URL is not, and an unauthenticated visit correctly redirects to `/console/login?next=/console/device?user_code=…&reason=device` with the device query preserved. 12 gateway tests cover the host split, the leading-slash case, a missing device code, pending-as-400, `slow_down`, a refusal in the Console's words, the org the client would pick, a token with no account lookup, a token with no access token, single-claim sessions, expiry, and a malformed session id.
  - Files: `packages/omnihilbras-sdk/src/adapters/opencode-console.ts`, `apps/gateway/src/opencodeConsole.ts`, `apps/gateway/test/opencode-console.test.js`, `src/components/OauthConnectDialog.tsx`, docs.
  - Depends on: Task 10g.
  - Scope: Small.

- [x] Task 10g: Build the OpenCode Console device-code sign-in, and light up the card.
  - Acceptance: the card signs in through the vendor's own device flow, stores the session per connection, renews it, and serves the catalog from the lanes the server names. Gemini is refused by name.
  - Verify: `POST /v1/oauth/opencode-console/start` returns 201 with a session, a 9-character user code, and an absolute verification URL — the Console returns a relative path, so it is joined to the server. `GET .../session/:id` reports `pending` for an unapproved code, 404 for an unknown session, 400 for a malformed id. In the dashboard the dialog shows the code, links to the code page, and falls back to the manual link when the tab is blocked. 15 new SDK tests cover lane dispatch, the Gemini refusal, renewal with the org preserved, the config-sourced org id, per-session lane caching, and the prefix-stripping of a vendor-prefixed id. Two bugs were found by those tests: a request renewed the session twice because the credential is resolved twice, and a config-supplied org id never reached the header because the adapter read only the credential.
  - Files: `packages/omnihilbras-sdk/src/adapters/opencode-console.ts`, `types.ts`, `test/opencode-console.test.js`, `apps/gateway/src/opencodeConsole.ts`, `service.ts`, `server.ts`, `src/lib/gatewayClient.ts`, `src/components/OauthConnectDialog.tsx`, `src/pages/ProviderDetailPage.tsx`, docs.
  - Depends on: Task 10f.
  - Scope: Medium.

- [x] Task 10f: Add the OpenCode Console card, and correct the two wrong claims.
  - Acceptance: a Console card exists in the OAuth group without disturbing the existing Zen card, an auth mode with no flow behind it disables its connect action and says so, and the IP-scoped and no-third-party claims are withdrawn in favour of the measured credential-scoped result.
  - Verify: `opencode-console` renders under OAuth Providers and `opencode` still renders under API Key Providers. On the new card both Add connection buttons are disabled with the title "OpenCode Console sign-in is not available yet." and the empty state reads "Sign-in for this provider is not available yet."; Cline's buttons stay enabled, since it has a flow. Correction: `opencode run -m opencode/mimo-v2.6-flash-free` answers `OK` at cost 0 on the installed client, whose stored credential is a Console OAuth session — recognisable because the client renders `metadata.orgName` as the label, and an org name only exists on the device flow. A Console-authenticated `/api/config` names the real lanes (`/inference/openai/v1` with all 7 free models, `/inference/anthropic/v1`, `/inference/google/v1beta`) and a per-account `x-opencode-org-id`; the API key with that header is still refused, so neither the org id nor the address is the gate.
  - Files: `src/data/providers.ts`, `src/pages/ProviderDetailPage.tsx`, docs.
  - Depends on: Task 10e.
  - Scope: Medium.

- [x] Task 10e: Retest against 9router's own keyless request, and correct the scope of the finding.
  - Acceptance: the refusal is retested against the reference implementation's own request rather than a hand-written one, and the conclusion is narrowed to what was actually measured.
  - Verify: 9router's keyless executor (`open-sse/executors/opencode.js`) hardcodes `Authorization: Bearer public` and requires canonical 30-character session and request ids (`ses_`/`msg_` + 12 hex + 14 base62) with `x-opencode-client: desktop` and `x-opencode-project: global`. Reproducing that exactly still returns `403` on every restricted model, so the request shape is not the variable. The remaining variable is the egress address: 9router's own page offers a Proxy Pool to "bypass IP-based limits" and Zen keys the free tier on the client address via `createIpRateLimiter` (`handler.ts:104-127`). v0.7.3's "unreachable" is therefore narrowed to "unreachable from an address that is not on the inside". Also recorded: `x-real-ip` is a client-controllable rate-limit input, a weakness in OpenCode's deployment to report rather than exploit.
  - Files: docs only.
  - Depends on: Task 10d.
  - Scope: Small.

- [x] Task 10d: Establish where the Zen free-tier refusal is actually decided.
  - Acceptance: the deciding layer is identified from provider source rather than inferred from symptoms, and the behaviour of the two reference projects that advertise a keyless OpenCode lane is recorded as measured.
  - Verify: OpenCode's own Zen handler prefixes a relayed upstream error with `Error from provider (<displayName>)` (`handler.ts:339`), so the refusal is an upstream provider's, not Zen's. Zen's edge treats `public` as no key (`handler.ts:107`) and admits anonymous callers when the model's `allowAnonymous` flag is set, rate-limiting by IP (`handler.ts:126`, `:699-701`), so these models are open at the edge and refused downstream. The full client matrix is credential-, header-, transport- and lane-independent across 5 retries. OmniRoute never calls Zen for this: its `open-code` MITM target rewrites `body.model` and forwards to its own router (`handlers/openCode.ts:26,29`), while its `noauth.ts` blurb advertises the very request shape that receives a 403. 9router's lane is `noAuth` with a placeholder `baseUrl` and a stale hardcoded model list, and its own test already reports `OpenCode free tier unavailable`.
  - Files: docs only.
  - Depends on: Task 10c.
  - Scope: Small.

- [x] Task 10c: Record the near-identical model id that makes a working route look broken.
  - Acceptance: the confusion between Zen's free `mimo-*-free` and OpenRouter's paid `xiaomi/mimo-*` is documented with both measured, so a "works in my other gateway" report is checked against the model id and provider before it is read as a routing fault.
  - Verify: `xiaomi/mimo-v2.6-flash` and `xiaomi/mimo-v2.5` answer through the configured OpenRouter connection; `mimo-v2.6-flash-free` and `mimo-v2.5-free` refuse on Zen with `403`. The two are distinct vendors' models with near-identical ids.
  - Files: docs only.
  - Depends on: Task 10b.
  - Scope: Small.

- [x] Task 10b: Measure why the restricted Zen free models refuse, and say so plainly.
  - Acceptance: the refusal cause is established by live request, not inference, and recorded in the docs. Client-impersonation headers are not shipped if they unlock nothing.
  - Verify: the live catalog holds 82 models, 11 free. Exactly one free model answers (`space-bunny-free`). Eight refuse with `403`; `deepseek-v4-flash-free` refuses with `400` and an upstream "Model is unavailable"; `jev-1.13-free` is refused by name. The restriction survives `x-opencode-client: desktop`, an `opencode/…` User-Agent, the sentinel `Bearer public`, `stream: true`, and a valid key, so those headers were tried and removed. Zen returns an empty error body to an authenticated caller and a descriptive one to an unauthenticated caller, which is why a refusal surfaces as a bare status. 9router's hardcoded free list is stale: it advertises `union-alpha`, absent from the catalog and refused by every lane.
  - Files: docs only. The v0.7.0 adapter is unchanged.
  - Depends on: Task 10a.
  - Scope: Small.

- [x] Task 10a: Route OpenCode Zen per model to the lane Zen publishes for it.
  - Acceptance: `ZenAdapter` picks chat, responses, or messages per model from the published table, translating each wire format, and refuses the two unimplemented lanes by name. The messages lane authenticates with `x-api-key`, not a bearer token.
  - Verify: 11 new SDK tests cover lane selection including the `qwen3.8-max` exception, both wire formats in and out, error envelopes, the streaming refusal, and a validation that spends no request. Live: `claude-sonnet-5` went from 401 to 402 when the header was corrected, which is what proves the fix; `space-bunny-free` answers through the new adapter; paid models answer 402 (no credits) and restricted free models 403.
  - Files: `packages/omnihilbras-sdk/src/adapters/zen.ts`, `test/zen.test.js`, `src/index.ts`, `apps/gateway/src/service.ts`, docs.
  - Depends on: Task 9z.
  - Scope: Medium.

- [x] Task 9z: Match 9router's model probe, and soft-pass a reasoning-only reply.
  - Acceptance: the probe budget is 1024 tokens with a `hi` prompt, and a response whose content is empty but which carries reasoning under any of the four common field names is a pass labelled `reasoning only` rather than a failure. A genuinely empty response still fails, and a truncated one is retried once at 2x.
  - Verify: measured on the OpenRouter free tier. `inclusionai/ling-3.0-flash-fin`, `liquid/lfm-2.5-2.6b` and `nvidia/nemotron-3.5-lightning` all failed or returned nothing at a 96-token budget and answer cleanly at 1024. `nemotron-3-nano-omni-30b-a3b-reasoning` answers 4 of 5, and its one failure now reports "the provider returned no choices" instead of a bare "invalid response".
  - Files: `src/lib/gatewayClient.ts`, `src/pages/ProviderDetailPage.tsx`, `packages/omnihilbras-sdk/src/adapters/openai-compatible.ts`, docs.
  - Depends on: Task 9y.
  - Scope: Small.

- [x] Task 9y: Stop recording an empty model response as a pass.
  - Acceptance: the model test budget is 96 tokens, and a response with no visible text is a failure carrying a reason rather than a `Ping` badge. A response with tool calls still counts as an answer.
  - Verify: live against OpenRouter free models. `liquid/lfm-2.5-2.6b:free` and `dots-studio/dots-3-note-preview:free` both returned `content: null, finish_reason: length` at 16 tokens and were recorded as passes; at 96 tokens both answer `OK` with `finish_reason: stop`.
  - Files: `src/lib/gatewayClient.ts`, docs.
  - Depends on: Task 9x.
  - Scope: Small.

- [x] Task 9x: Say why a Cline call failed.
  - Acceptance: a Cline health check returns a reason instead of a bare `unavailable`, and a failed token renewal is reported as an expired session rather than a raw 4xx.
  - Verify: 3 new SDK tests. Live: a Cline health check that previously reported only `unavailable` now reads "Cline rejected the token. Sign in again."
  - Files: `packages/omnihilbras-sdk/src/adapters/cline.ts`, `test/cline.test.js`, docs.
  - Depends on: Task 9w.
  - Scope: Small.

- [x] Task 9w: Address credentials by connection, so a provider can hold several.
  - Acceptance: `PUT /v1/connections/:providerId` updates that provider's existing connection, and passing an `id` adds another alongside it. Each connection's credential is stored and read under its own connection id, never a provider id.
  - Verify: 3 new store tests cover two connections of one provider holding distinct credentials, an id-less save reusing the existing connection, and deleting one connection leaving the other's credential intact. Live against OpenCode: two connections (`opencode`, `opencode-backup`) coexist with 82 models each and appear separately in `/v1/routing`; the pre-existing OpenRouter and Cline connections still resolve their credentials after the vault rekey.
  - Files: `apps/gateway/src/connections.ts`, `src/service.ts`, `src/server.ts`, `test/connections.test.js`, docs.
  - Depends on: Task 9v.
  - Scope: Medium.

- [x] Task 9v: Add OpenCode Zen, and fix the save path that made it unreachable.
  - Acceptance: OpenCode Zen appears in the catalog and the add-connection dialog, and saving it stores an encrypted credential and imports the live catalog through the generic route. The API key is handed to the page for any provider that asks for one, not OpenRouter alone.
  - Verify: live against OpenCode — `PUT /v1/connections/opencode` returns a saved connection with 82 real models imported from `https://opencode.ai/zen/v1/models`, and a chat request through the gateway routes to OpenCode and returns its own 401 for a bad key. The connection is deleted afterwards so no fake credential lingers.
  - Files: `src/data/providers.ts`, `src/components/AddProviderModal.tsx`, `src/lib/gatewayClient.ts`, `src/pages/ProviderDetailPage.tsx`, docs.
  - Depends on: Task 9u.
  - Scope: Medium.

- [x] Task 9u: Narrow and order the model list by test result.
  - Acceptance: a result filter (All / Untested / Passed / Failed) with a count per option, and a sort by name, fastest, or slowest. Untested models sort last in either latency order. The result filter is suspended during a bulk run so the list does not empty out from under the workers. Failures stay on their own row; there is no aggregate failure panel.
  - Verify: browser check on the OpenRouter page after a 22-model run — All=22, Untested=0, Passed=15, Failed=7, with 0 console errors; the filter narrows the list and sort control applies. On the Cline page, a search plus the Failed filter shows the 8 failing models out of 458.
  - Files: `src/pages/ProviderDetailPage.tsx`, docs.
  - Depends on: Task 9t.
  - Scope: Small.

- [x] Task 9t: Match Cline's client identification and chat envelope.
  - Acceptance: Cline requests carry the same client-identification header set Cline's own clients send, including `HTTP-Referer: https://cline.bot`, and a non-streaming chat response wrapped in `{"success":true,"data":{…}}` is unwrapped while `{"success":false,…}` is raised with Cline's own reason.
  - Verify: 6 new SDK tests cover the envelope shapes, a chat completion read through the envelope, the full header set, and that a caller-supplied header cannot override the token. Confirmed live that the referer alone changes Cline's answer, so the header set is not cosmetic.
  - Files: `packages/omnihilbras-sdk/src/adapters/cline.ts`, `src/adapters/openai-compatible.ts`, `test/cline.test.js`, docs.
  - Depends on: Task 9s.
  - Scope: Small.

- [x] Task 9s: Filter models inside a provider page.
  - Acceptance: every provider page has a search box above its model list that matches the full model ID and the part after the vendor prefix, shows `Showing N of M`, distinguishes no-match from nothing-imported, and has a clear control. `Test all` operates on the listed models and says `Test N shown` when a filter is active.
  - Verify: browser check on the Cline page with 458 real models — `claude-sonnet` narrows to 8 rows, the bulk button reads `Test 8 shown`, a nonsense query shows "Nothing in 458 models matches", and the clear control resets. 0 console errors.
  - Files: `src/pages/ProviderDetailPage.tsx`, docs.
  - Depends on: Task 9r.
  - Scope: Small.

- [x] Task 9r: Read connections back from the gateway after a sign-in, and guard required fields.
  - Acceptance: a completed sign-in re-reads the authoritative record from the connections route instead of adopting the sign-in payload, and the resilience panel falls back to defaults rather than reading a required field unguarded.
  - Verify: browser check with a connected Cline account renders the provider page with 0 console errors, and every former unguarded read of `connection.resilience` now goes through one guarded local.
  - Files: `src/pages/ProviderDetailPage.tsx`, docs.
  - Depends on: Task 9q.
  - Scope: Small.

- [x] Task 9q: Search models on the providers page, and fix what the search exposed.
  - Acceptance: the providers page search matches provider names and imported model IDs, including the part after a vendor prefix, and reports results grouped by provider with an honest serving state. Health is recorded from the reported status rather than the absence of a throw, and a provider's own wording reaches the operator through the dashboard only.
  - Verify: 1 new gateway test asserts an adapter reporting `unavailable` is recorded as a failure. In the browser against the live Cline account, `claude` reports 3 models across 1 provider, `claude-sonnet` reports 9 across 2, a nonsense query shows the empty state, the clear control resets, and the Cline badge reads `serving`.
  - Files: `src/pages/ProvidersPage.tsx`, `apps/gateway/src/service.ts`, `src/server.ts`, `test/routing.test.js`, docs.
  - Depends on: Task 9p.
  - Scope: Medium.

- [x] Task 9p: Return a whole connection from sign-in, and load any provider's connection.
  - Acceptance: a connected sign-in status carries the complete connection record, and a provider page loads its saved connection for every provider rather than only the first one that shipped with a flow.
  - Verify: a test asserts every connection field and every `resilience` field survives the session status. In the browser with a real Cline account connected, the page reports 1 active connection and 458 models with 0 console errors, where before it blanked on connect and reported no connection on load.
  - Files: `apps/gateway/src/oauth.ts`, `src/service.ts`, `test/oauth-routes.test.js`, `src/components/OauthConnectDialog.tsx`, `src/lib/gatewayClient.ts`, `src/pages/ProviderDetailPage.tsx`, docs.
  - Depends on: Task 9o.
  - Scope: Small.

- [x] Task 9o: Fix the Cline API base URL, expiry units, and swallowed errors.
  - Acceptance: the adapter targets `https://api.cline.bot/api/v1`, an expiry reported in epoch seconds is not read as 1970, and a provider 4xx keeps a short token-free excerpt of what the provider said so the callback page can name the reason.
  - Verify: tests pin every Cline endpoint under `/api/v1`, the resolved `models` and `chat/completions` URLs, the seconds/milliseconds boundary, and that token-shaped strings are stripped from an error excerpt. Confirmed live: `/api/v1/models` answers 200 with the full catalog and no valid token, while `/models` answers 401 with Cline's "re-authenticate" message, which is the failure this fixes.
  - Files: `packages/omnihilbras-sdk/src/adapters/cline.ts`, `src/transport.ts`, `test/cline.test.js`, `apps/gateway/src/oauth.ts`, `src/service.ts`, docs.
  - Depends on: Task 9n.
  - Scope: Small.

- [x] Task 9n: Correlate the sign-in by redirect path instead of `state`.
  - Acceptance: a callback that carries no `state` at all still completes the sign-in, because the session id travels in the path of `redirect_uri`, which the provider must honour verbatim. `state` is still minted, sent, and checked when it comes back. A session is claimed exactly once, a wrong `state` spends nothing, and a callback identifying no session is refused with a message that points at the paste box.
  - Verify: 33 gateway tests including the regression that a state-less callback completes, a crossed state exchanges nothing and can be retried, a replayed path is refused even with the right state, and the `redirect_uri` sent to the token endpoint equals the one the authorize request carried. Confirmed live against the gateway with a state-less callback, which now reports Cline's own rejection instead of an unknown-session error.
  - Files: `apps/gateway/src/oauth.ts`, `src/service.ts`, `src/server.ts`, `test/cline-sessions.test.js`, `test/oauth-routes.test.js`, docs.
  - Depends on: Task 9m.
  - Scope: Small.

- [x] Task 9m: Centre the OAuth dialog and open the browser from the click.
  - Acceptance: the dialog renders through `createPortal` into `document.body` so it centres like the API-key dialog, and the sign-in tab is opened inside the click handler that starts the flow, because a browser only permits `window.open` during a user gesture.
  - Verify: the dialog's DOM depth drops from inside the transformed page container to a direct child of `body`; the browser opens a tab on `authkit.cline.bot` from a single click on Add connection.
  - Files: `src/components/OauthConnectDialog.tsx`, `src/pages/ProviderDetailPage.tsx`, `docs/SPEC-SDK.md`.
  - Depends on: Task 9l.
  - Scope: Small.

- [ ] Task 10: Define cloud integration boundaries.
  - Acceptance: auth context, tenant context, remote `SecretStore`, and deployment configuration are represented by interfaces without implementing cloud infrastructure.
  - Verify: typecheck and architecture review.
  - Files: SDK/gateway interfaces and documentation.
  - Depends on: Task 8.
  - Scope: Small.
