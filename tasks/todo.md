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
