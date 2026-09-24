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

### Phase 5: Cloud readiness

- [ ] Task 10: Define cloud integration boundaries.
  - Acceptance: auth context, tenant context, remote `SecretStore`, and deployment configuration are represented by interfaces without implementing cloud infrastructure.
  - Verify: typecheck and architecture review.
  - Files: SDK/gateway interfaces and documentation.
  - Depends on: Task 8.
  - Scope: Small.

## Risks and Mitations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Provider APIs change independently | High | Keep adapters isolated, use official API documentation, and pin response fixtures per adapter. |
| Streaming formats differ | High | Normalize to `AsyncIterable<ChatChunk>` and test event boundaries explicitly. |
| Secrets leak through logs/errors | High | Central `SecretStore`, redaction helpers, and tests that scan errors/log output. |
| Gateway becomes coupled to one provider | High | Registry and capability contracts; no provider IDs in shared service logic. |
| Local/cloud behavior diverges | Medium | Share the SDK and gateway service; keep auth/storage as outer runtime concerns. |
| Frontend and backend build systems conflict | Medium | Separate workspace packages and checkpoints after each phase. |

## Open Questions

- Whether to publish the SDK under a public package name after the contract stabilizes.
- Whether cloud mode should target a managed Node deployment or an edge-compatible runtime.
- Which additional provider protocol family should be implemented after the first four adapters.
