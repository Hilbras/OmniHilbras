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

- [ ] Task 10: Define cloud integration boundaries.
  - Acceptance: auth context, tenant context, remote `SecretStore`, and deployment configuration are represented by interfaces without implementing cloud infrastructure.
  - Verify: typecheck and architecture review.
  - Files: SDK/gateway interfaces and documentation.
  - Depends on: Task 8.
  - Scope: Small.
