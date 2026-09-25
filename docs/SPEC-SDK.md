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
- `PUT /v1/connections/:id/resilience` — update one connection's retry, timeout, and rate-limit budget.
- `GET /v1/routing` — live routing state: budgets, recent failures and successes, ejection, last latency, last error.
- `POST /v1/oauth/cline/start` — begin a sign-in; returns the sign-in URL, a session id, and a single-use `state`.
- `GET /v1/oauth/cline/authorize` — build the Cline sign-in URL for a loopback callback.
- `GET /v1/oauth/cline/callback` — where the provider redirects the browser; completes the exchange and reports the outcome.
- `GET /v1/oauth/cline/session/:id` — whether a started sign-in is pending, connected, failed, or expired.
- `POST /v1/oauth/cline/exchange` — exchange a pasted callback URL or code, prove the token against Cline, then save the connection.
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

## Additional Providers

A connection is not limited to the built-in adapters. `PUT
/v1/connections/:id` accepts any provider ID with a caller-supplied `endpoint`,
and the gateway builds an `OpenAICompatibleAdapter` for it on demand, cached by
endpoint. That covers Ollama, vLLM, LM Studio, Together, Groq, and any other
OpenAI-compatible server without a code change, and the request still uses the
shared transport and the encrypted credential vault. `POST
/v1/connections/:id/check` validates a candidate key against a registered
provider before saving.

Endpoints go through `assertSafeProviderRequestUrl`, so a caller cannot point a
connection at a credential-bearing URL. A provider without a `validateCredential`
capability is saved without a pre-flight check and validated on first use, since
probing every provider costs a real request.

## OAuth Connections

Cline is reached through an OAuth authorization-code flow rather than a pasted
API key, and it is the only provider whose wire format is not plain
OpenAI-compatible.

**The credential.** `ProviderCredential` gains an `oauth` variant:
`{ type: 'oauth', value, refreshToken?, expiresAt?, email? }`. It is stored and
encrypted exactly like an API key. `value` is the access token as issued; the
`workos:` prefix Cline requires is a wire detail the adapter adds per request and
never persists.

**The flow.** Cline redirects the browser to a loopback address the gateway
owns, so the sign-in completes on its own and there is normally nothing to paste:

1. `POST /v1/oauth/cline/start` records a session, mints a 256-bit `state`, and
   returns a sign-in URL whose `redirect_uri` and `callback_url` are a loopback
   URL and whose `state` the provider echoes back. A non-loopback redirect is
   refused, so a callback can never be pointed somewhere else.
2. The dashboard opens that URL in a tab. The tab is opened blank inside the
   click that started the flow, because a browser only allows `window.open`
   during a user gesture, and the dialog navigates it once the URL exists.
3. The user approves in the browser. Cline redirects to
   `GET /v1/oauth/cline/callback`, which is the one route exempt from the
   cross-site guard, because a top-level navigation from the provider sends
   `sec-fetch-site: cross-site` and no `Origin`. The route claims the `state`,
   which is single-use, so a replayed or forged callback is refused instead of
   exchanging an attacker's code into the user's vault.
4. The exchange proves the token with a real `GET /v1/users/me` before anything
   is written, then discovers the model catalog and saves the connection. A
   rejected code is reported as an authentication failure; an unreachable token
   endpoint stays an upstream failure, so an outage is never misreported as a
   bad sign-in.
5. The outcome is recorded on the session, and the dashboard learns it by
   polling `GET /v1/oauth/cline/session/:id`. A session lives five minutes, so a
   sign-in cannot be resumed after the user has walked away, and a finished
   session is dropped a minute later. The status carries the connection and an
   error message, never a credential.

The callback page reports the outcome and shows no code, because by the time it
renders the exchange has already happened. It lives on the origin that also holds
the local API keys, so it carries `no-store`, `Referrer-Policy: no-referrer`, a
`default-src 'none'` policy with no script, and a message that is both
HTML-escaped and restricted to a plain-text charset.

`POST /v1/oauth/cline/exchange` remains as the fallback for a provider that does
not hand the code to a browser redirect. It accepts a callback URL, a
`code#state` pair, or a bare code, and Cline sometimes encodes the tokens inside
the code as base64 JSON, which is read directly instead of exchanged.

**Refresh.** The adapter renews an expired access token before use, within a
60-second skew, one refresh at a time so concurrent requests share it. The
renewed token is handed back through `onTokensRefreshed`, which the gateway wires
to the vault, so a refresh is persisted instead of repeated per request.

**Token prefixing.** Cline accepts WorkOS JWTs only with an explicit `workos:`
prefix, and rejects non-JWT ClinePass keys (`clp_…`) that carry one. The adapter
applies the prefix only to JWT-shaped tokens and sends everything else verbatim.

## Model Routing and the Client Catalog

A plain OpenAI-compatible client must work with only a base URL, a key, and a
model ID. That constrains two behaviors:

- **Routing.** `POST /v1/chat/completions` resolves the provider in this order:
  an explicit `x-omnihilbras-provider` header or `provider` body field, then the
  saved connection catalog that lists the requested model, then the single
  enabled credentialed connection, then the `openai` default. Resolution is
  provider-neutral and reads connection metadata only; it never inspects a model
  name for provider hints.
- **Catalog.** `GET /v1/models` advertises the saved model IDs of enabled,
  credentialed connections. Live provider listing remains the fallback only when
  no such connection exists, so clients never see paid models the operator did
  not import.

Disabled or credential-less connections take part in neither.

## Provider Catalog and Auth Modes

`src/data/providers.ts` is catalog metadata, not a connection registry. A card
lists a provider, its auth mode, and its group, and stays `available` with `—`
metrics until a gateway connection backs it. The dashboard only reports a
provider as connected when a saved connection and a health result say so.

An auth mode without a flow behind it is presented as unavailable rather than
faked. A provider is added from its own detail page, where the dialog matches the
auth mode: an API-key provider asks for a key, and an `OAuth` provider opens the
sign-in dialog instead. An auth mode with neither flow stays unaddable, so no
connection can be invented for a provider the gateway cannot call.

Cline is the one implemented `OAuth` mode, and it has a working sign-in flow; see
[OAuth Connections](#oauth-connections). Its card still reads `available` with
`—` metrics until a connection is actually saved, because catalog metadata is not
evidence of a connection.

## Connection Reliability

Every connection stores a `resilience` block: `maxRetries` (0–5, default 1),
`timeoutMs` (0–600000, default 0 for the shared default), `requestsPerMinute`
(0–100000, default 0 for unlimited), and `hedgeAfterMs` (0–30000, default 0 for
off). Settings are validated at the store boundary and exposed through `PUT
/v1/connections/:id/resilience`; unspecified fields keep their current value.

Behavior when serving a request:

- Candidates are ordered by priority, then name, and a candidate must own the
  model unless the caller pinned a provider explicitly.
- A retryable failure — timeout, rate limit, provider unavailable, or a
  provider-marked retryable error — spends that connection's retry budget and
  then moves to the next candidate. `INVALID_REQUEST`, `AUTHENTICATION_FAILED`,
  `NOT_SUPPORTED`, `NOT_FOUND`, and `CANCELLED` are terminal: they are neither
  retried nor failed over, because another connection cannot fix them.
- The per-request deadline is enforced by the gateway, not delegated to the
  adapter, so a provider that ignores its abort signal still cannot hold a
  request open.
- Rate limiting uses a sliding window per connection, so a burst cannot
  straddle a minute boundary and double the effective rate. A limited
  connection hands the request to the next route.
- Hedging: when the leading candidate has `hedgeAfterMs` set and another
  candidate can serve the same model, a second request is started after that
  delay while the leader is still in flight. The first success wins and every
  other in-flight request is aborted. The gateway returns as soon as a winner
  exists rather than waiting for the cancelled losers, and the abandoned
  attempts are reported in the trace with `CANCELLED` so a client can see the
  hedge happened. A hedge is never sent when there is no second eligible
  candidate, and a fast leader is never raced.
- Streaming decides its route before the first byte is written, so a stream that
  cannot start returns a normal JSON error. Once bytes are sent, a failure is
  reported as a stream error rather than silently restarting on another route.
- After `failureThreshold` consecutive failures a connection is ejected. It is
  eligible again after a recovery cooldown, so no restart is needed to bring a
  recovered provider back.
- `GET /health` folds live request outcomes into the polled result, and
  background polling can do the same on an interval. `GET /v1/routing` exposes
  the resulting state for the dashboard.
- A non-streaming response includes a `gateway.attempts` trace only when more
  than one attempt was made, so single-route responses are unchanged. Error
  redaction still applies: the aggregate message names providers, never
  third-party response content.

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
- Render every dialog through `createPortal` into `document.body`. The page
  container animates with `transform`, and a `transform` on an ancestor makes
  `position: fixed` resolve against that ancestor instead of the viewport, so an
  in-tree dialog lands at the bottom of the page rather than centred.

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
