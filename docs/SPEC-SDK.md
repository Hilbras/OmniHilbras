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
| `provider-openrouter` | OpenAI-compatible data APIs plus authenticated key validation | `sdk-core` |
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
- Local mode rejects non-loopback binds and wildcard CORS; browser access uses an explicit dashboard-origin allowlist.
- Credentials are injected through a `SecretStore` boundary; the first implementation reads environment variables and, for the OpenRouter local flow, persists a validated key in an encrypted gateway-owned vault. Secret values are never logged or returned by the API.
- The SDK does not require a web framework. The local gateway starts with a small Node HTTP adapter and keeps the service layer framework-independent.
- Provider-native payloads stay inside adapters. The normalized SDK contract is the only contract shared by the gateway and routing code.
- The gateway's first public HTTP routes are OpenAI-compatible for client convenience, but adapters are not required to use OpenAI's wire format.
- The first implementation slice contains the four core adapters below, plus the real OpenRouter adapter needed for the initial connection-management flow; the capability-based extension path remains part of the contract, and no fake provider is required.

## SDK Contract

The core package exposes:

- `ChatRequest`, `ChatResponse`, `ChatChunk`, `ChatMessage`, `Model`, and `TokenUsage`.
- `ProviderAdapter` with capability-specific contracts for chat, models, embeddings, images, audio, search, and future media.
- `ProviderCapabilities` to describe which operations a provider supports; unsupported operations return a typed `NOT_SUPPORTED` error.
- `ProviderRegistry` for adapter lookup and capability checks without provider-specific conditionals in the gateway.
- `ProviderError` with stable machine-readable codes and provider metadata.
- `HttpTransport` for timeout, cancellation, JSON requests, and streamed responses. It is a trusted adapter transport, not an arbitrary tenant URL fetcher.
- `SecretStore` for credential lookup; adapters receive credentials only for the duration of a request.

The normalized contract must be provider-neutral. Provider-specific options are namespaced under `providerOptions` and validated by the adapter that owns them; options that an adapter does not implement are rejected rather than silently discarded.

Provider URLs are adapter-owned trusted configuration in local mode. Before exposing tenant-provided endpoints to a cloud gateway, add an explicit hostname allowlist and DNS-rebinding policy.

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

### OpenRouter

- Uses the OpenAI-compatible model, chat, and streaming protocol.
- Uses the authenticated `GET /api/v1/key` metadata route for credential checks; an unauthenticated model catalog request is not sufficient validation.
- Rejects management keys that cannot be used for inference.
- Overrides health checking so revoked credentials become unavailable instead of relying on the public model list.
- Model import supports `free` and `all` policies and defaults to `free` when the request omits a policy. Free mode requires both provider-reported prompt and completion pricing to be zero; all mode imports the text model catalog.

### Other and future providers

The three native adapters are not an exhaustive list. A provider that does not speak the OpenAI, Anthropic, or Gemini protocol gets its own adapter implementing the capability it supports. For example, a search provider implements a search capability, an image provider implements an image capability, and a speech provider implements audio capabilities. The shared registry and gateway do not need to change when a new provider or capability is added.

Provider modules may share small protocol-family helpers, but provider-specific authentication, request conversion, response parsing, and stream parsing remain inside the owning adapter.

## Gateway API

The first local gateway exposes:

- `GET /health` — gateway and configured adapter health.
- `GET /v1/models` — normalized models from configured adapters.
- `GET /v1/connections` — connection metadata without credentials.
- `POST /v1/connections/openrouter/check` — validate a candidate OpenRouter key without saving it.
- `PUT /v1/connections/openrouter` — validate again, discover the selected model policy, then upsert the single local OpenRouter connection.
- `POST /v1/connections/:id/models` — add validated model IDs to a saved connection.
- `DELETE /v1/connections/:id` — remove a local connection.
- `GET /v1/keys` — gateway key metadata plus the enforcement flag; never returns a secret.
- `POST /v1/keys` — mint a key; the response is the only time the secret is returned.
- `PATCH /v1/keys/:id` — pause or resume a key.
- `DELETE /v1/keys/:id` — revoke a key.
- `PUT /v1/settings/require-api-key` — turn LLM-surface enforcement on or off.
- `POST /v1/chat/completions` — normalized gateway chat request/response.
- `POST /v1/chat/completions` with `stream: true` — normalized SSE chunks.
- The dashboard provider test uses live adapter health; each model test uses a bounded real chat completion through the same route.


Gateway errors use one shape:

```json
{
  "error": {
    "code": "PROVIDER_REQUEST_FAILED",
    "message": "The provider request failed.",
    "provider": "anthropic",
    "status": 502,
    "retryable": true
  }
}
```

Connection-management responses are metadata-only and use `Cache-Control: no-store`.
The OpenRouter Save route always performs a fresh server-side validation before
writing the credential, discovers the requested model policy, and writes the
validated model IDs to connection metadata. Manually added model IDs are kept
separately so a later re-import does not erase them; the policy describes the
discovery filter, not the total catalog. Connection metadata is kept in a
separate JSON file; credentials are encrypted with AES-256-GCM in a separate
vault file. The default
vault directory is `$XDG_CONFIG_HOME/omnihilbras` (or `~/.config/omnihilbras`),
with `0700` directory and `0600` file permissions. A generated local key file is
supported for first-run convenience; deployments that need stronger key custody
should provide `OMNIHILBRAS_MASTER_KEY` or replace the store with an OS keychain.
Encryption at rest does not protect against a compromised same-user process. On startup, credentials without a matching credential-bearing metadata record are discarded before the gateway can use them, preventing an interrupted two-file write from activating an unlisted key.

The gateway must validate request boundaries, apply request timeouts, never return raw secrets, and preserve provider error codes in structured metadata.

## Gateway API Keys

Keys authorize access to the LLM surface only; connection and key management stay
reachable from the local dashboard. The contract:

- A key is `ohk_` plus 32 random bytes in base64url. Only its SHA-256 hash is
  persisted, so the secret is unrecoverable after creation and rotation means
  creating a replacement.
- Presented keys arrive in `Authorization: Bearer <key>`, `x-api-key`, or
  `x-goog-api-key`. Query-string keys are rejected so secrets stay out of logs
  and shell history.
- Hashes are compared in constant time across every stored key, and paused or
  deleted keys fail immediately.
- Enforcement defaults to on and guards `GET /v1/models` and
  `POST /v1/chat/completions`. Requests carrying an allowlisted dashboard
  `Origin` are exempt: they are already protected by the origin allowlist and
  the cross-site request check, and the dashboard must keep working without
  holding a key. Anything else — CLI tools, IDE extensions, scripts — must
  present a key while enforcement is on.
- `AUTHENTICATION_FAILED` maps to `401` with a `WWW-Authenticate: Bearer`
  challenge and an actionable message.
- `lastUsedAt` is best effort: it is written at most once per 30 seconds so
  request handling never blocks on disk.

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
- [x] Core adapters are implemented: OpenAI, Anthropic, Gemini, and OpenAI-compatible, with a real OpenRouter adapter for authenticated connection management.
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
- OpenRouter API-key metadata: https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key

Provider APIs change independently, so each adapter's request and response conversion must be updated and fixture-tested when its provider changes.

## Open Questions

- Should the first gateway implementation use only Node's HTTP primitives, or add a framework after the first vertical slice? **Recommendation: Node primitives first.**
- Should model discovery be enabled for every adapter in the first release, or only for providers with a documented model-list endpoint? **Recommendation: capability-based; unsupported operations return a typed `NOT_SUPPORTED` error.**
- Should the normalized SDK eventually be published as a standalone npm package? **Recommendation: design it as publishable from the start, but keep it private until the contract stabilizes.**
