# Spec: OmniHilbras Provider SDK and Local Gateway

**Status:** Approved for initial implementation

## Objective

Build a provider-neutral TypeScript SDK and a local-first HTTP gateway for OmniHilbras. Each provider can use its native authentication and wire protocol, while the gateway exposes a stable internal contract and a small OpenAI-compatible HTTP surface for clients.

The first vertical slice must prove the architecture with native OpenAI, Anthropic, and Gemini adapters plus a generic OpenAI-compatible adapter. These are reference implementations, not a provider allowlist: a provider with a different protocol gets its own adapter without changing the gateway core.

## Capability Map

| Module ID | Responsibility | Depends on |
| --- | --- | --- |
| `sdk-core` | Normalized request/response types, provider contract, transport, streaming, errors, registry, secret boundary | — |
| `provider-openai` | Native OpenAI authentication, models, chat, streaming, and health | `sdk-core` |
| `provider-anthropic` | Native Anthropic Messages API conversion and streaming | `sdk-core` |
| `provider-gemini` | Native Gemini generate/stream API conversion and models | `sdk-core` |
| `provider-openai-compatible` | Configurable adapter for providers exposing an OpenAI-like API | `sdk-core` |
| `gateway-local` | Loopback HTTP server, health, model listing, chat, and SSE streaming | `sdk-core` and provider adapters |
| `dashboard-integration` | Replace preview provider actions with local gateway calls | `gateway-local` |
| `gateway-cloud` | Authentication, tenancy, remote secret storage, and hosted deployment | `gateway-local`; later phase |

Build order:

```text
sdk-core → provider-openai-compatible → provider-openai → provider-anthropic
        → provider-gemini → gateway-local → dashboard-integration
        → gateway-cloud
```

## Technical Assumptions

- Runtime: Node.js 24+ and TypeScript.
- Package manager: pnpm workspaces.
- SDK code is runtime-agnostic and uses standard `fetch` and Web Streams.
- The first gateway binds to `127.0.0.1:8787` and has no authentication in local mode.
- Credentials are injected through a `SecretStore` boundary; the first implementation reads environment variables and never logs secret values.
- The SDK does not require a web framework. The local gateway starts with a small Node HTTP adapter and keeps the service layer framework-independent.
- Provider-native payloads stay inside adapters. The normalized SDK contract is the only contract shared by the gateway and routing code.
- The gateway's first public HTTP routes are OpenAI-compatible for client convenience, but adapters are not required to use OpenAI's wire format.
- The first implementation slice contains the four adapters below; the capability-based extension path remains part of the contract, but no additional fake provider is required in this slice.

## SDK Contract

The core package exposes:

- `ChatRequest`, `ChatResponse`, `ChatChunk`, `ChatMessage`, `Model`, and `TokenUsage`.
- `ProviderAdapter` with capability-specific contracts for chat, models, embeddings, images, audio, search, and future media.
- `ProviderCapabilities` to describe which operations a provider supports; unsupported operations return a typed `NOT_SUPPORTED` error.
- `ProviderRegistry` for adapter lookup and capability checks without provider-specific conditionals in the gateway.
- `ProviderError` with stable machine-readable codes and provider metadata.
- `HttpTransport` for timeout, cancellation, JSON requests, and streamed responses.
- `SecretStore` for credential lookup; adapters receive credentials only for the duration of a request.

The normalized contract must be provider-neutral. Provider-specific options are namespaced under `providerOptions` and validated by the adapter that owns them.

## First Provider Behavior

### OpenAI

- Bearer authentication.
- Chat completions and server-sent event streaming.
- Model listing and connection health.
- Native request/response conversion isolated in one adapter.

### Anthropic

- API-key and version headers.
- Native Messages API request conversion, including system instructions.
- Native SSE event conversion into normalized `ChatChunk` values.
- Model listing/health support.

### Gemini

- API-key authentication using Google's supported header/query mechanism.
- Native `generateContent` and streaming conversion.
- Model listing and health support.

### OpenAI-compatible

- Configurable base URL, API-key header, model-list path, and chat path.
- No provider-specific assumptions beyond the OpenAI-compatible protocol.
- Safe URL and header configuration; no arbitrary credential forwarding.

### Other and future providers

The three native adapters are not an exhaustive list. A provider that does not speak the OpenAI, Anthropic, or Gemini protocol gets its own adapter implementing the capability it supports. For example, a search provider implements a search capability, an image provider implements an image capability, and a speech provider implements audio capabilities. The shared registry and gateway do not need to change when a new provider or capability is added.

Provider modules may share small protocol-family helpers, but provider-specific authentication, request conversion, response parsing, and stream parsing remain inside the owning adapter.

## Gateway API

The first local gateway exposes:

- `GET /health` — gateway and configured adapter health.
- `GET /v1/models` — normalized models from configured adapters.
- `POST /v1/chat/completions` — normalized gateway chat request/response.
- `POST /v1/chat/completions` with `stream: true` — normalized SSE chunks.

Gateway errors use one shape:

```json
{
  "error": {
    "code": "PROVIDER_REQUEST_FAILED",
    "message": "The provider request failed.",
    "provider": "anthropic",
    "details": {}
  }
}
```

The gateway must validate request boundaries, apply request timeouts, never return raw secrets, and preserve provider error codes in structured metadata.

## Project Structure

```text
packages/omnihilbras-sdk/
  src/
    index.ts
    types.ts
    errors.ts
    transport.ts
    registry.ts
    secret-store.ts
    adapters/
  package.json
  tsconfig.json

apps/gateway/
  src/
    server.ts
    service.ts
    config.ts
    routes/
  package.json
  tsconfig.json

src/                         # existing React frontend
public/providers/            # existing provider asset library
docs/                        # specifications and architecture decisions
tasks/                       # implementation plans and task lists
```

## Commands

Target commands after the backend slice is added:

```bash
pnpm install
pnpm dev:gateway
pnpm build
pnpm typecheck
pnpm test
pnpm test:watch
```

The existing Vite commands must continue to build the frontend successfully.

## Code Style

- Use strict TypeScript with explicit input/output types.
- Prefer small functions and discriminated unions over provider conditionals in shared code.
- Keep provider-specific wire details inside adapter modules.
- Validate external responses before exposing them through the normalized contract.
- Never log request headers, API keys, cookies, or raw credential values.
- Use async iterables for provider streams and propagate cancellation through `AbortSignal`.

## Testing Strategy

- Unit-test normalized request/response conversion for every adapter.
- Unit-test error normalization, timeout handling, cancellation, and secret redaction.
- Contract-test the generic adapter against representative OpenAI-compatible responses.
- Integration-test the local gateway with a fake transport; no real provider credentials are required.
- Test streaming chunk boundaries and `[DONE]`/provider-specific termination behavior.
- Add a browser smoke test after the dashboard is connected to the local gateway.

## Boundaries

### Always

- Validate all external input and provider responses.
- Keep credentials behind `SecretStore`.
- Add tests before expanding provider behavior.
- Preserve the existing frontend build and hash-based navigation.

### Ask first

- Adding a new runtime dependency or database.
- Changing the normalized SDK contract in a breaking way.
- Adding cloud authentication, billing, or remote persistence.
- Implementing more than the first provider slice in one change.

### Never

- Commit API keys, cookies, or generated credential files.
- Log raw provider requests when they may contain secrets.
- Force a non-OpenAI provider through OpenAI-specific request code.
- Add provider-specific conditionals to the routing or gateway service.

## Success Criteria

- [ ] A TypeScript SDK package builds independently of the React app.
- [ ] The SDK exposes stable normalized types and a provider registry.
- [ ] Four adapters are implemented: OpenAI, Anthropic, Gemini, and OpenAI-compatible.
- [ ] A provider with a different protocol can be added through a capability-specific adapter without modifying the gateway core.
- [ ] Native streaming works through one normalized `AsyncIterable<ChatChunk>` contract.
- [ ] Provider errors have stable codes and never expose secrets.
- [ ] The local gateway starts on loopback and supports health, models, chat, and SSE streaming.
- [ ] Tests run without real provider credentials.
- [ ] The dashboard can use the local gateway without a document reload.
- [ ] Cloud-specific concerns are represented by interfaces but are not implemented in the first slice.

## Protocol References

The initial adapter implementations are based on these official references:

- Node Fetch and Web Streams: https://nodejs.org/api/globals.html#globalfetch
- OpenAI Chat Completions: https://platform.openai.com/docs/api-reference/chat/create
- OpenAI model listing and bearer authentication: https://developers.openai.com/api/reference/resources/models/methods/list
- Anthropic Messages API: https://platform.claude.com/docs/en/api/messages
- Anthropic streaming events: https://platform.claude.com/docs/en/build-with-claude/streaming
- Gemini GenerateContent: https://ai.google.dev/api/generate-content
- Gemini model listing: https://ai.google.dev/api/models

Provider APIs change independently, so each adapter's request and response conversion must be updated and fixture-tested when its provider changes.

## Open Questions

- Should the first gateway implementation use only Node's HTTP primitives, or add a framework after the first vertical slice? **Recommendation: Node primitives first.**
- Should model discovery be enabled for every adapter in the first release, or only for providers with a documented model-list endpoint? **Recommendation: capability-based; unsupported operations return a typed `NOT_SUPPORTED` error.**
- Should the normalized SDK eventually be published as a standalone npm package? **Recommendation: design it as publishable from the start, but keep it private until the contract stabilizes.**
