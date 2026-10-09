# Implementation Plan: OmniHilbras Provider SDK and Local Gateway

## Overview

Build a publishable TypeScript SDK with provider-neutral contracts and four initial adapters, then expose those adapters through a local HTTP gateway. The SDK remains independent from the React dashboard and is designed for reuse by a future cloud gateway.

## Architecture Decisions

- Use Node.js 24+, TypeScript, pnpm workspaces, native `fetch`, and Web Streams.
- Keep provider-native wire formats inside adapters.
- Use capability-specific contracts so future non-chat providers can be added without changing the gateway core.
- Use the first gateway with Node HTTP primitives and no authentication on loopback.
- Inject credentials through a `SecretStore`; the first implementation reads environment variables and never logs secret values.
- Keep the existing Vite frontend and hash-based dashboard navigation intact.

## Task List

### Phase 1: SDK foundation

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

### Checkpoint: SDK foundation

- [x] SDK package builds independently.
- [x] No real credentials are required for tests.
- [x] Existing frontend typecheck/build still passes.

### Phase 2: Provider adapters

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

### Checkpoint: Provider adapters

- [x] All four adapters pass fixture-based tests.
- [x] Provider-specific payloads do not leak into shared gateway types.
- [x] Existing frontend build remains green.

### Phase 3: Local gateway

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

### Checkpoint: Local vertical slice

- [x] Gateway starts on `127.0.0.1:8787`.
- [x] A fake transport can exercise every route without credentials.
- [x] Timeouts, cancellation, and secret redaction are verified.
- [x] Local hardening rejects non-loopback binds, wildcard CORS, unsafe redirects, and raw provider error bodies.

### Phase 4: Dashboard integration

- [x] Task 9: Connect provider health actions to the local gateway.
  - Acceptance: provider health testing calls the local gateway and surfaces structured success/error states; credential persistence remains preview-only for providers without a management endpoint.
  - Verify: browser smoke test and frontend build/typecheck pass.
  - Files: `src/lib/gatewayClient.ts`, `src/pages/ProvidersPage.tsx`, `src/pages/ProviderDetailPage.tsx`.
  - Depends on: Task 8.
  - Scope: Small/medium.

### Phase 4b: Local provider connections

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

### Checkpoint: Local connection flow

- [x] OpenRouter keys are never written to browser storage.
- [x] Check performs a real gateway-side provider request.
- [x] Save performs a second validation before persistence.
- [x] Existing gateway routes and frontend build remain green.

### Phase 4c: Model import and catalog

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

### Checkpoint: Model import

- [x] Free-model filtering uses provider pricing, not model-name heuristics.
- [x] Model IDs are validated and persisted without credentials.
- [x] Custom model additions survive re-imports and failed additions remain retryable.
- [x] Save remains atomic: failed discovery does not replace a valid connection.

### Phase 4d: Real provider and model tests

- [x] Task 9f: Replace preview model tests with real gateway chat checks.
  - Acceptance: provider tests use live adapter health, model tests send a bounded real chat completion with the saved credential, and latency/success/error states come from the gateway response.
  - Verify: gateway contract test covers provider selection and max-token budget; typecheck/build and browser smoke test cover the real request path.
  - Files: `src/lib/gatewayClient.ts`, `src/pages/ProviderDetailPage.tsx`, `apps/gateway/test/server.test.js`, docs.
  - Depends on: Task 9e.
  - Scope: Small/medium.

### Checkpoint: Real tests

- [x] Model Test no longer uses a client-side timer or synthetic success.
- [x] Tests use the saved gateway credential and never expose it to the browser provider call.
- [x] Test failures and timeouts are visible per model.

### Phase 4e: Gateway API keys

- [x] Task 9g: Add gateway API keys and the dashboard keys page.
  - Acceptance: the gateway mints, pauses, revokes, and authenticates client keys; only hashes are stored; enforcement guards the LLM surface with a dashboard exemption; the dashboard page manages keys without browser secret storage.
  - Verify: gateway store and route tests cover hash-at-rest, one-time reveal, constant-time auth, paused-key rejection, enforcement toggling, and origin exemption; typecheck/build and browser smoke test cover the create/pause/delete flow.
  - Files: `apps/gateway/src/api-keys.ts`, `src/secure-store.ts`, `src/service.ts`, `src/server.ts`, `src/config.ts`, `test/api-keys.test.js`, `src/pages/ApiKeysPage.tsx`, `src/lib/gatewayClient.ts`, `src/components/DashboardShell.tsx`, `src/dashboardApp.tsx`, docs.
  - Depends on: Task 9f.
  - Scope: Medium.

### Phase 4f: Connection reliability

- [x] Task 9h: Add per-connection retry, timeout, rate limits, and health-based failover.
  - Acceptance: each connection stores a validated resilience budget; retryable failures retry then fail over by priority; terminal failures never retry; per-request deadlines and per-connection rate limits are enforced by the gateway; failing connections are ejected and recover automatically; the dashboard exposes the controls and live state.
  - Verify: routing tests cover retry-then-failover, terminal-error short-circuiting, timeout and rate-limit handoff, ejection with cooldown recovery, streaming failover before the first chunk, and background health polling; HTTP tests cover the attempt trace and resilience route; browser smoke test covers the Reliability panel.
  - Files: `apps/gateway/src/routing.ts`, `src/service.ts`, `src/connections.ts`, `src/server.ts`, `src/config.ts`, `test/routing.test.js`, `src/pages/ProviderDetailPage.tsx`, `src/lib/gatewayClient.ts`, docs.
  - Depends on: Task 9g.
  - Scope: Medium.

### Checkpoint: Gateway API keys

- [x] Key secrets are shown once and stored only as SHA-256 hashes.
- [x] `GET /v1/models` and `POST /v1/chat/completions` reject anonymous clients by default.
- [x] The dashboard keeps working without holding a key.
- [x] A client needs only a base URL, key, and model ID: routing resolves the provider from the saved catalog and `/v1/models` advertises the saved catalog.
- [x] Existing connection routes, model tests, and builds remain green.

### Phase 4g: Latency and additional providers

- [x] Task 9i: Add hedged requests and on-demand provider adapters.
  - Acceptance: a slow leading connection is raced against the next eligible one and the first reply wins with the loser cancelled; no hedge is sent when a fast leader answers or no second candidate exists; any provider can be added with a caller-supplied endpoint and served through an on-demand OpenAI-compatible adapter.
  - Verify: routing tests cover hedge-wins, fast-leader-not-hedged, single-candidate skip, leader-wins, failed-race fallback, and on-demand adapter resolution; live check against a deliberately slow endpoint measures the latency difference and the attempt trace.
  - Files: `apps/gateway/src/service.ts`, `src/connections.ts`, `src/server.ts`, `test/routing.test.js`, `src/pages/ProviderDetailPage.tsx`, `src/lib/gatewayClient.ts`, docs.
  - Depends on: Task 9h.
  - Scope: Medium.

### Checkpoint: Connection reliability

- [x] Retries, deadlines, rate limits, and hedge delays are per-connection and validated at the store boundary.
- [x] Retryable failures fail over; auth and validation failures do not.
- [x] A failed connection is ejected and rejoins without a restart.
- [x] Streaming never restarts a request that already sent bytes.
- [x] A slow leader is raced and the hedge wins measurably faster.

### Phase 5: Cloud readiness

- [x] Task 10: Define cloud integration boundaries.
  - Acceptance: auth context, tenant context, a remote credential store, and deployment configuration are represented by interfaces without implementing cloud infrastructure.
  - Verify: `apps/gateway/test/runtime.test.js` (11 tests), including *"THE BOUNDARY: no cloud infrastructure was written"* — which asserts the **absence**, because the tempting way to fail "interfaces only" is to add a remote store nobody uses. `pnpm verify` green.
  - Files: `apps/gateway/src/runtime.ts` (new), `service.ts`, `config.ts`, `connections.ts`, `server.ts`, `routes/route-context.ts`, `docs/architecture/README.md`.
  - Depends on: Task 8.
  - Scope: Small.
  - Findings:
    - **Two exported types called `SecretStore`, meaning different things.** The SDK's is keyed by *provider* and read-only; the gateway's is keyed by *connection* and writable. Reading `SecretStore` in either package meant opening the other to find out which you had. The gateway's is now `ConnectionSecretStore`, named for its key.
    - **The service's credential dependency was `Pick<ConnectionStore, 'get' | 'set' | 'delete'>`** — a type describing the *local file store's origin* rather than the shape the gateway needs, so "could this be remote" had to be answered by reading a constructor. And the `Pick` described a shape the local store never actually satisfied: `get` takes a provider id and `set` does not. That inconsistency is preserved rather than tidied, because re-keying it is a migration to every adapter's refresh callback and not this task's business.
    - **A third credential-store shape existed and was used nowhere**: `WritableSecretStore`, which extends the *provider*-keyed SDK type and so looked like the gateway's writable store while having a different key. Deprecated with a pointer, because a trap left exported is worse than a trap removed.
    - **Auth context replaced a `trusted: boolean`.** That boolean is a real and correct decision expressed as a value with no owner and no name, so nothing above the HTTP layer could ask *who*, and a hosted gateway could not answer "may this reach the LLM surface without a key" differently from a loopback one. The gate now asks `isTrustedDashboard(auth)`.
    - **Tenancy is named and carried, not threaded.** A tenant is a property of a *deployment*, so it is configured once; a multi-tenant deployment scopes a store by construction rather than adding a parameter to thirty methods. Threading a value nothing reads would be decoration shaped like architecture.
    - `readonly` is a type and not a runtime guarantee — asserted by a test, which is the third time this project has been caught by that distinction.

## Risks and Mitations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Provider APIs change independently | High | Keep adapters isolated, use official API documentation, and pin response fixtures per adapter. |
| Streaming formats differ | High | Normalize to `AsyncIterable<ChatChunk>` and test event boundaries explicitly. |
| Secrets leak through logs/errors | High | Central `SecretStore`, redaction helpers, and tests that scan errors/log output. |
| Gateway becomes coupled to one provider | High | Registry and capability contracts; no provider IDs in shared service logic. |
| Local/cloud behavior diverges | Medium | Share the SDK and gateway service; keep auth/storage as outer runtime concerns. |
| Frontend and backend build systems conflict | Medium | Separate workspace packages and checkpoints after each phase. |

### Audit: the risk table, checked rather than believed

The task list above is 50 of 50. Its **risk table** was not audited until the end, and one of its
mitigations was not implemented — and stayed that way for nineteen releases after this sentence was
written, while the plan continued to read as finished:

| Risk | Claimed mitigation | Measured |
| --- | --- | --- |
| Provider APIs change independently (**High**) | pin response fixtures per adapter | **5 of 14 adapters** (18 `.ts` files in `src/providers/`, 16 provider folders, one shared base `openai-compatible` and two helpers nested in them, none counted as adapters) — `kiro-stream.bin` plus `openrouter`, `cline` and `opencode-console` (1.48.0), and `zen` (its public model listing, shape and keys only). The other nine have a stated reason, and **seven of those need a credential this machine does not have**. `clinepass` is the one whose capture would *duplicate* rather than fill a gap — it shares Cline's host and wire format, so the bytes it would pin are the bytes `cline-models.json` already pins. The count is printed by `fixture-coverage.test.js`, so it cannot go stale again without a test failing. |
| Streaming formats differ (**High**) | test event boundaries explicitly | real: frame-level assertions across the adapter tests |
| Secrets leak through logs/errors (**High**) | redaction helpers and tests that scan errors/log output | real: error-output scanning tests exist |
| Gateway becomes coupled to one provider | no provider IDs in shared service logic | real: 12 files carry a zero-provider-id invariant test |
| Local/cloud behavior diverges (**Medium**) | keep auth/storage as outer runtime concerns | real: `runtime.ts` (Task 10) |
| Frontend/backend builds conflict | separate workspace packages | real |

**The contract suite does not substitute for the fixtures, and the two are different jobs.** The
contract proves an adapter satisfies an *invariant*. A pinned capture proves the adapter still
understands *that provider's wire format*. When a provider renames a frame key the contract still
passes, and the first sign is a broken request in production.

That is not hypothetical. DeepSeek Web's tests asserted two hand-written frame shapes, passed, and
shipped — while live traffic used bare-string appends and the adapter was silently truncating every
answer to one character. The tests agreed with their author.

**`packages/omnihilbras-sdk/test/fixture-coverage.test.js` makes the gap enforceable.** Every
adapter must have a pinned capture *or say why it does not*, with a reason long enough to argue
with, and the count is asserted so it cannot drift quietly. Verified by planting a fabricated
capture, which the guard rejected twice over: *"deepseek-web-challenge.json is pinned but no test
reads it"* and *"fixtures on disk (2) and adapters with a capture (1) disagree"*.

**No fixture was manufactured.** A fabricated capture is worse than none: it is indistinguishable
from a real one in review, and it is the exact artefact that hid the DeepSeek bug. Taking the
remaining captures means making live provider requests, which costs money and needs credentials —
so it is a decision for the operator, not a task for an agent.

---

## Open Questions

*Resolved 1.48.0. The first was answered by fact; the second two are decisions, recorded with their
reasoning rather than left as questions, because an open question nobody re-reads is a plan that looks
finished and is not.*

- ~~Whether to publish the SDK under a public package name after the contract stabilizes.~~
  **Answered in fact: yes, and it already is.** Published as `@hilbras/omnihilbras` since 1.0.0, now at
  1.48.0, every release confirmed with `npm view`. The contract stabilized some time ago; the plan
  simply stopped being updated. This is the pattern the rest of this section exists to stop — a plan
  whose own history it does not record.
- **Cloud mode: a managed Node deployment, not an edge-compatible runtime.** Decided against the edge on
  evidence rather than taste. The SDK deliberately uses Node builtins where a runtime demands them — the
  gateway vault is AES-256-GCM over `scryptSync`, the OAuth flows hold PKCE verifiers server-side, and
  the Cline and OpenCode-Console adapters drive browser sessions. Every one of those is unavailable or
  materially slower at the edge, and forcing them out would mean rewriting the credential layer — the one
  part of this codebase with no tolerance for a subtle difference. An edge build remains possible later
  for the *forwarding* path alone, which is stateless, and that is the only split worth making.
- **Next protocol family: nothing new, deliberately.** The next family is not another provider, it is
  **HTTP semantics that already exist and are not yet implemented** — chiefly *streaming request
  cancellation* end-to-end and *retry semantics per failure class* across the whole surface. Both are
  observable by every adapter, so both are worth more than a thirteenth wire format, and neither needs a
  credential to test. Adding a provider is now a catalog entry: 1.43.0 added nine, and 1.45.0 proved the
  gateway serves them with no adapter at all. The scarce resource is no longer providers.
