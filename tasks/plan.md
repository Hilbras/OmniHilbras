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

- [ ] Task 1: Create the SDK package and normalized contracts.
  - Acceptance: strict TypeScript types exist for chat, streaming, models, capabilities, errors, and secret lookup.
  - Verify: package typecheck passes and public exports are documented by types.
  - Files: `packages/omnihilbras-sdk/package.json`, `tsconfig.json`, `src/types.ts`, `src/errors.ts`, `src/secret-store.ts`, `src/index.ts`.
  - Scope: Small.

- [ ] Task 2: Add transport, streaming, and provider registry.
  - Acceptance: fetch transport supports JSON, SSE streams, timeouts, cancellation, and normalized errors; registry resolves adapters by ID.
  - Verify: focused unit tests pass with fake fetch implementations.
  - Files: `src/transport.ts`, `src/registry.ts`, `src/streaming.ts`, tests.
  - Depends on: Task 1.
  - Scope: Medium.

### Checkpoint: SDK foundation

- [ ] SDK package builds independently.
- [ ] No real credentials are required for tests.
- [ ] Existing frontend typecheck/build still passes.

### Phase 2: Provider adapters

- [ ] Task 3: Implement the generic OpenAI-compatible adapter.
  - Acceptance: configurable base URL, auth header, model path, chat path, JSON responses, and SSE streaming normalize correctly.
  - Verify: fixture-based contract tests cover success, HTTP errors, malformed responses, and stream termination.
  - Files: `src/adapters/openai-compatible.ts`, fixtures/tests.
  - Depends on: Task 2.
  - Scope: Medium.

- [ ] Task 4: Implement the native OpenAI adapter.
  - Acceptance: bearer auth, model listing, chat completions, and `[DONE]` stream handling are isolated in the OpenAI adapter.
  - Verify: adapter tests use representative OpenAI response and stream fixtures.
  - Files: `src/adapters/openai.ts`, tests.
  - Depends on: Task 3.
  - Scope: Small/medium.

- [ ] Task 5: Implement the native Anthropic adapter.
  - Acceptance: Messages API conversion, system instructions, version headers, model listing, and native SSE event conversion are isolated in the adapter.
  - Verify: adapter tests cover text/tool responses, errors, and stream events.
  - Files: `src/adapters/anthropic.ts`, tests.
  - Depends on: Task 2.
  - Scope: Medium.

- [ ] Task 6: Implement the native Gemini adapter.
  - Acceptance: `generateContent`, model listing, authentication, request conversion, and streaming conversion are isolated in the adapter.
  - Verify: adapter tests cover candidate content, safety metadata, errors, and stream chunks.
  - Files: `src/adapters/gemini.ts`, tests.
  - Depends on: Task 2.
  - Scope: Medium.

### Checkpoint: Provider adapters

- [ ] All four adapters pass fixture-based tests.
- [ ] Provider-specific payloads do not leak into shared gateway types.
- [ ] Existing frontend build remains green.

### Phase 3: Local gateway

- [ ] Task 7: Add gateway service and configuration.
  - Acceptance: local configuration loads provider credentials/endpoints through `SecretStore` and builds a provider registry without provider conditionals in the service.
  - Verify: configuration and service unit tests pass with fake adapters.
  - Files: `apps/gateway/src/config.ts`, `src/service.ts`, tests.
  - Depends on: Tasks 3–6.
  - Scope: Medium.

- [ ] Task 8: Add local HTTP routes and streaming responses.
  - Acceptance: `/health`, `/v1/models`, and `/v1/chat/completions` support JSON and SSE with consistent error envelopes.
  - Verify: integration tests use fake adapters and never contact real providers.
  - Files: `apps/gateway/src/server.ts`, routes, tests, package scripts.
  - Depends on: Task 7.
  - Scope: Medium.

### Checkpoint: Local vertical slice

- [ ] Gateway starts on `127.0.0.1:8787`.
- [ ] A fake transport can exercise every route without credentials.
- [ ] Timeouts, cancellation, and secret redaction are verified.

### Phase 4: Dashboard integration

- [ ] Task 9: Connect provider actions to the local gateway.
  - Acceptance: provider test/add flows call the local API and surface structured success/error states without sending preview-only fake responses.
  - Verify: browser smoke test and frontend build/typecheck pass.
  - Files: dashboard API client and provider pages.
  - Depends on: Task 8.
  - Scope: Medium.

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
