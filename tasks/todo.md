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
