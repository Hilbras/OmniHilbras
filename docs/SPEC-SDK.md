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
- A model test must fail when the model returns no visible output. A well-formed
  envelope with empty content is not a working model, and a `Ping` badge beside a
  model that answers nothing is a false report. A response carrying tool calls
  counts as an answer even with no text.
- **The test budget is 1024 tokens.** Reasoning models spend their budget on
  chain-of-thought before emitting an answer, so a small probe starves the reply:
  `max_tokens: 16` yields `finish_reason: length` with no content and the model
  looks broken. Cost is bounded by what a model generates, not by the cap.
- **A reasoning-only reply is a pass, not a failure.** A model that spends the
  whole budget thinking and emits no text has still proved the connection works.
  When the content is empty but the response carries reasoning — under any of
  `reasoning`, `reasoning_content`, `thinking`, `thinking_content` — the test
  passes and the row is labelled `reasoning only`. Treating this as a failure is
  what made working models look broken here while they behaved elsewhere.
- **A genuinely empty response still fails**, and one truncated by the budget is
  retried once at 2x. A response carrying tool calls counts as an answer.
- **The probe prompt is `hi`.** The test measures whether a model answers, not
  what it can write, so a longer prompt only adds tokens to reason about.

### Why a model can fail here and work elsewhere

Four causes, only two of which are the gateway's:

| Cause | Whose | Example |
| --- | --- | --- |
| Reasoning model outgrows the test budget | gateway, fixed by escalating | `ling-3.0-flash-fin` needs 151 tokens |
| Free-tier quota shared across users | provider | `:free` models answering `429` |
| Provider refuses that model on this key | provider | `thinkingmachines/inkling:free` answering `401` |
| Provider answers with an unusable shape | provider, now explained | `nemotron-3-nano-omni-...-reasoning` answering 4 of 5 requests |

A provider whose API is not one shape is a fifth and is not fixed: OpenCode Zen
routes different models to `/zen/v1/responses`, `/zen/v1/messages`, and
`/zen/v1/chat/completions`, and the generic adapter speaks only the last.

An unusable response names the part that was missing — an empty `choices` array is
reported differently from a choice without a message — because a provider that
answers inconsistently is otherwise indistinguishable from one that is simply
broken.


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

### OpenCode Zen

OpenCode Zen is a hosted gateway from the OpenCode team, OpenAI-compatible at
`https://opencode.ai/zen/v1`, authenticated with a Bearer key from
`opencode.ai/auth` and charged per request. It needs no adapter: the generic route
serves it, and its catalog is public, so the model list imports without a
credential.

**Its API surface is mixed per model.** Per the published table at
`opencode.ai/docs/zen`, GPT, Grok and Muse come from `/zen/v1/responses`, Claude and
Qwen from `/zen/v1/messages`, Gemini from `/zen/v1/models/{id}`, Jev from
`/zen/v1/systemone`, and the rest from `/zen/v1/chat/completions`. `ZenAdapter`
picks the lane per model, translating to and from each wire format:

| Lane | Endpoint | Auth header | Body naming |
| --- | --- | --- | --- |
| `chat` | `/zen/v1/chat/completions` | `Authorization: Bearer` | `max_tokens` |
| `responses` | `/zen/v1/responses` | `Authorization: Bearer` | `max_output_tokens`, content as typed `input_text` parts |
| `messages` | `/zen/v1/messages` | `x-api-key`, plus `anthropic-version` | `max_tokens`, system turns hoisted out of the message list |

**The messages lane does not take a bearer token.** It takes the raw key in
`x-api-key`. Sending `Authorization: Bearer` there is answered with a `401` even when
the key is valid — which is exactly what happened before this was corrected.

Two lanes are **not implemented** and are refused by name rather than guessed at:
Gemini, which Zen serves from its own path, and Jev, a decision model on
`/systemone`. Streaming is refused on the `messages` and `responses` lanes rather
than silently answered without a stream.

Credential validation is presence-and-shape only: Zen's catalog is public, so a live
probe would prove nothing and would bill on every health poll. Health reads the
public catalog instead.

### Why a Zen refusal looks like a bare status code

Zen returns an **empty body to an authenticated caller and a descriptive one to an
unauthenticated one.** With a real key a refusal surfaces here as `HTTP 403 with an
empty response body`; the same request with the sentinel key `Bearer public` returns

```json
{"type":"error","error":{"type":"FreeTierError",
 "message":"Error from provider (Console): OpenCode's free tier can only be used from within OpenCode"}}
```

So a bare status in the dashboard is a provider that chose not to explain itself to a
caller holding a key, not a gateway that lost the message. To read a real reason,
re-issue the request unauthenticated.

### Measured state of the catalog

Measured against the live catalog, which holds **82 models, 11 of them free**:

| Outcome | Models |
| --- | --- |
| Answers | `space-bunny-free` |
| `403`, free tier restricted to the OpenCode client | `mimo-v2.6-flash-free`, `mimo-v2.5-free`, `ling-3.0-flash-fin-free`, `longcat-2.5-preview-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`, `muse-spark-1.2-contributor-free`, `muse-spark-1.3-contributor-free` |
| `400`, upstream reports the model unavailable | `deepseek-v4-flash-free` |
| Refused by name, served from `/zen/v1/systemone` | `jev-1.13-free` |
| `402`, the account holds no credits | the paid models |

**One free model of eleven answers.** The restriction is not a header, a key, or a
stream setting: it survives `x-opencode-client: desktop`, an `opencode/…` User-Agent,
the sentinel `Bearer public`, and `stream: true`, and it is not lifted by a valid key.
Sending those headers anyway was tried and removed, since impersonating the vendor's
client unlocked nothing.

### Where the refusal actually happens

The gate is **not** at Zen's edge, and it is not a credential check. Zen proxies each
model to an upstream provider, and when that provider returns an error Zen relays the
status and prefixes the message with the provider's name. OpenCode's own server does
this in `packages/console/app/src/routes/zen/util/handler.ts`:

```ts
json.error.message = `Error from provider${providerInfo.displayName ? ` (${providerInfo.displayName})` : ""}: ${json.error.message}`
```

The refusal therefore arrives as `Error from provider (Console): …` — the parenthetical
names the upstream provider that refused, and the text is that provider's, not Zen's.

Zen's edge is in fact *open* to these models. Its handler reads the key, treats the
sentinel `public` as no key at all, and admits an anonymous caller whenever the model's
own `allowAnonymous` flag is set, rate-limiting by IP instead of by key:

```ts
const zenApiKey = rawZenApiKey === "public" ? undefined : rawZenApiKey   // handler.ts:107
const rateLimiter = modelInfo.allowAnonymous                            // handler.ts:126
  ? createIpRateLimiter(modelInfo.id, modelInfo.rateLimit, ip, input.request)
  : createKeyRateLimiter(modelInfo.id, modelInfo.rateLimit, zenApiKey, input.request)
```

So an anonymous request is admitted and then refused downstream. The full matrix
confirms the refusal is independent of everything a client controls:

| Axis | Variants tried | Result |
| --- | --- | --- |
| Credential | none, `Bearer `, `Bearer public`, real API key | identical per model |
| Client headers | `x-opencode-client`, `x-opencode-session`, `x-opencode-request`, `x-opencode-project`, `opencode/…` User-Agent | 403 |
| Transport | `stream: true` and `false`, HTTP/2 | 403 |
| Lane | chat, responses, messages, systemone, `zen/go`, `/api/v1`, `zen/v2` | 403 or a lane-specific 500/404 |
| Retries | 5 per model | stable |

Only `space-bunny-free` answers, and it answers anonymously on both the chat and
messages lanes.

### What actually unlocks them: a Console OAuth session

The gate is **credential-scoped, not IP-scoped**, and the credential is the one the
OpenCode client obtains for itself.

OpenCode's client has two credential paths. Signed out, it sends the sentinel
`apiKey: "public"` and keeps only the zero-cost models enabled. Signed in, it holds an
**OpenCode Console** device-flow credential and sends that instead:

```ts
const defaultServer = "https://console.opencode.ai"
const clientID = "opencode-cli"
const hasKey = Boolean(process.env.OPENCODE_API_KEY || connected || item.provider.request.body.apiKey)
if (!hasKey) provider.request.body.apiKey = "public"
```

and the inference credential is the session token, not a key:

```ts
const token = value.type === "oauth" ? value.access : value.key
```

A stored Console credential is recognisable by its **label**: the client renders
`credential.metadata.orgName` as the label, and an org name only exists on a
device-flow credential. `opencode auth list` showing `OpenCode Console  Personal` is
therefore an OAuth session even when the user believes they pasted a key.

**Measured.** A Console session answers the restricted models at zero cost:

```
opencode run -m opencode/mimo-v2.6-flash-free "Reply with exactly OK."
  -> {"type":"text","text":"OK"}  cost 0
```

The same model with an API key is refused on every lane tested, under every header
combination, on both Node and Bun. So the refusal tracks the credential, exactly as the
message says.

**The authenticated lanes are not the Zen ones.** A Console-authenticated request to
`GET console.opencode.ai/api/config` returns the real provider config, and its base URL
is not `/zen/v1`:

| Lane | Models |
| --- | --- |
| `https://opencode.ai/inference/openai/v1` | 54, including all 7 free models |
| `https://opencode.ai/inference/anthropic/v1` | 16, the Claude models |
| `https://opencode.ai/inference/google/v1beta` | 7, the Gemini models |

That config also carries a per-account `x-opencode-org-id` header. Sending the API key
with that header, on that lane, streaming or not, still earns a `403` — the org id is
not the gate either. Those lanes are worth using regardless: they return real billing
answers, where `/zen/v1` on a paid model returns a bare `402`.

### OpenCode Console: the credential that works

The restricted free models are reachable, and the credential that reaches them is an
**OpenCode Console session**, not an API key. The provider signs in with the same device
flow the OpenCode client runs for itself.

| Step | Call |
| --- | --- |
| Request a code | `POST console.opencode.ai/auth/device/code` with `client_id: opencode-cli` |
| Read the approval | `POST console.opencode.ai/auth/device/token` with the device-code grant |
| Identify the account | `GET console.opencode.ai/api/user` and `/api/orgs` |
| Read the live config | `GET console.opencode.ai/api/config` |

A pending poll answers **HTTP 400** with `error: authorization_pending`, so the status has
to be read from the body rather than treated as a failure. `expires_in` is 600 seconds and
`interval` is 5.

**The verification URI is relative, and it belongs to the web host, not the API host.**
The Console serves its API from `console.opencode.ai` and its pages from `opencode.ai`, so
joining `/console/device` to the API host yields `/console/console/device`, which renders
a blank page and presents as a sign-in that did nothing. It must be joined to
`https://opencode.ai`.

**The device page requires a Console session.** Unauthenticated, it redirects to
`/console/login?next=/console/device?user_code=…&reason=device`, carrying the device query
through, so signing in returns to the approval with the code already filled in. The dialog
says so, because a blank console page otherwise reads as a broken flow.

`OpencodeConsoleAdapter` then serves the catalog from the lanes the server names rather
than one fixed base URL:

| Lane | Models | Dispatch |
| --- | --- | --- |
| `/inference/openai/v1` | 54, all 7 free models | `OpenAICompatibleAdapter` |
| `/inference/anthropic/v1` | 16, the Claude models | `AnthropicAdapter` |
| `/inference/google/v1beta` | 7, the Gemini models | refused by name |

Two details worth stating, because both were bugs before they were tests:

**The lane adapters take a bare token and reject an OAuth credential.** Rather than widen
their contract for one caller, the access token is handed across as an `api-key`
credential at the adapter boundary. The org id rides on the adapter config, which is the
only place either adapter accepts extra headers.

**A request resolves the credential more than once** — once to read the lanes, once to
send — so a renewal is memoised against the token it replaced. Without that, one request
burns two refresh grants and the second invalidates the first.

A session is renewed when the access token is within a minute of expiry, and the renewed
credential is written back to the vault so it outlives the request that triggered it.
Validation reads `/api/user`, which is free and never bills.

**Two header names, for two different calls.** This was the cause of a connection that
saved with zero models. Measured:

| Call | Header | Without it |
| --- | --- | --- |
| `GET /api/config` | `x-org-id` | `400 {"code":"org_required","message":"x-org-id is required"}` |
| inference (`/inference/*`) | `x-opencode-org-id` | tolerated, but the org is still required upstream |

The org id itself comes from `GET /api/orgs`, which needs only the bearer token, and the
config then echoes back the same value for inference. So the read order is fixed: orgs
first, then config. An adapter that reads the config without an org fails every time, and
a credential saved before the org was captured would fail forever, so the org is looked up
from the account when the credential does not carry one.

**A correction.** v0.9.2 of this document claimed the config issues a `wrk_` workspace id
while the orgs list carries `org_` ids, and that the inference lane refuses the latter
with `403 Workspace access denied`. That was wrong, and the measurement behind it was
faulty: the test built an `org_` id by swapping the prefix onto a `wrk_` value, which
invented an organization that does not exist. The refusal was real; the conclusion drawn
from it was not. The config issues an `org_` id and it matches the orgs list. Two things
here cost real time because a plausible-sounding measurement was believed without being
re-examined.

**The Anthropic lane must not keep its trailing `/v1`.** `AnthropicAdapter` appends
`v1/messages` to the base it is given, and the config's lane already ends in `/v1`, so
passing it as-is asks for `/inference/anthropic/v1/v1/messages` — a `404`. Measured: the
doubled path answers `404`, and the corrected path answers `402 Insufficient account
funds`, which is the endpoint working. The OpenAI lane has no such problem, because the
compatible adapter appends the whole chat path.

**A connection can be re-scanned.** `POST /v1/connections/:id/models/refresh` re-reads a
saved connection's catalog and stores the result, keeping custom models. Without it a
connection saved with no models has no way back short of signing in again, which for a
device flow means another browser approval.

### How a refusal is reported

Two rules, and getting either wrong costs an operator an afternoon.

**A 403 is a refusal, not an authentication failure.** Only a 401 is a credential failure
on status alone. `AUTHENTICATION_FAILED` is a *terminal route code*, so treating every 403
as one meant a single refused request ejected the whole connection and took every working
model with it — a refused free model could take down a connection serving seventy others. A
provider that knows a particular 403 *is* an auth failure says so itself: Cline and
OpenRouter both raise `AUTHENTICATION_FAILED` deliberately rather than relying on status.

| Status | Code | Message |
| --- | --- | --- |
| 401 | `AUTHENTICATION_FAILED` | Provider authentication failed. |
| 403 | `PROVIDER_REQUEST_FAILED` | The provider refused the request. |
| 429 | `RATE_LIMITED` | The provider rate limit was reached. |
| 408, 504 | `PROVIDER_TIMEOUT` | The provider request timed out. |
| ≥500 | `PROVIDER_UNAVAILABLE` | The provider is temporarily unavailable. |
| other 4xx | `PROVIDER_REQUEST_FAILED` | The provider rejected the request. |

**The error body must be read.** The transport used to cancel it unread and hand the
classifier `undefined`, so `providerErrorDetail` was never given anything to work with and
*every* refusal on *every* provider arrived with no reason attached. It is now read on both
the request and stream paths, bounded to 64 KB, and parsed as JSON when it is JSON.

This is what finally explained the Console refusals. On `/zen/v1` Zen withholds the body
from a caller holding a key, so a bare status is all there is — but on `/inference/*` with
a Console session the body is present, and the reason is the provider's own:

```
The provider request failed. OpenCode's free tier can only be used from within OpenCode
```

The dashboard reads `providerMessage` in preference to the neutral `message`. That field is
only sent to a trusted local dashboard origin, which is the operator who needs it; API
clients still receive a provider-neutral message.

**A device code is single-use, so the exchange is claimed before the Console is called.**
The poll that receives the token kills the grant. The dashboard polls every second and
saving a connection is slower than that, so two polls overlap; without a claim the losing
poll spends the dead code, is told `The device code is invalid`, and overwrites a success
that had already happened. The symptom is unmistakable once seen: the Console says
*Device authorized* and the dashboard immediately says *the device code is invalid*. A
pending claim is released so the next poll may try again; a completed one is not.

**The dialog starts one sign-in, not one per render.** `onConnected` and `onClose` arrive
as inline arrows, so their identity changes on every render, which rebuilds the callback
that starts the flow. A plain `useEffect(begin, [begin])` therefore requests a fresh
device code on every render and sends the browser to whichever was minted last while the
poll watches another. A ref guard makes the start happen exactly once. For a redirect flow
the same mistake is merely wasteful; for a device flow it is fatal.

**A catalog that will not read must not discard a session the user just approved.** A
device-flow sign-in has already proven the credential, so model discovery is allowed to
fail there: the connection is saved with no models and the reason is carried on the
sign-in status, rather than the whole sign-in failing on a catalog read. Discovery
failures anywhere else still throw.

### The one variable left is the egress IP

No request shape works around it — and that is now tested against 9router's own
request rather than a hand-written one. 9router keeps a dedicated keyless executor at
`open-sse/executors/opencode.js` whose `buildHeaders` hardcodes the sentinel
`Authorization: Bearer public` and requires both ids to match OpenCode's canonical
format (`OPENCODE_SESSION_RE`, 30 characters, `ses_` + 12 hex + 14 base62, and the
`msg_` equivalent for the request id), alongside `x-opencode-client: desktop` and
`x-opencode-project: global`. Reproducing that exactly — canonical ids, the sentinel
key, the OpenCode user agent — still returns `403` on every restricted model from an
ordinary egress address. The request shape is therefore not the differentiator.

What remains is the address the request leaves from, and both projects say so
in their own UI. 9router's OpenCode Free page offers a **Proxy Pool** and describes it
as a way to "bypass IP-based limits", defaulting to `None (direct)`. Zen's handler is
consistent with that reading: the free tier is keyed on the client address, read from
the `x-real-ip` request header and enforced with `createIpRateLimiter` (`:104-127`).

**This section is superseded.** Reading further showed the gate is the credential, not
the address, and a Console OAuth session reaches these models from an ordinary
connection with no proxy at all. The proxy-pool behaviour in 9router's UI remains
unexplained, but it is not the mechanism: the same request that a proxy cannot fix is
fixed by signing in. Kept for the record because the reasoning was sound and the
conclusion was not.

Treat the restricted models as unavailable to an API key, and reachable only through a
Console sign-in.

A side observation from reading that handler, worth reporting to OpenCode rather than
exploiting: the rate-limiting address is taken from a request header, `x-real-ip`
(`:104-105`). If the edge does not overwrite it, a caller can choose its own rate-limit
bucket. It is a weakness in their deployment, not a route to these models.

### The other two projects do not reach these models either

Both advertise a keyless OpenCode free lane, and both would hit the refusal above.

**OmniRoute never calls Zen for this.** Its `open-code` MITM target installs a root
certificate and routes `opencode.ai` DNS into itself so the real OpenCode CLI connects
to OmniRoute instead. The handler then rewrites the model and forwards to OmniRoute's
own router — `payload.model = mappedModel` then `this.fetchRouter(payload, …)` in
`src/mitm/handlers/openCode.ts`. It is a model-swap shim, not a path to Zen's free
tier. Its provider blurb nonetheless reads "public OpenCode endpoint with Kimi, GLM,
Qwen, MiMo, MiniMax models … No signup or API key needed" in
`src/shared/constants/providers/noauth.ts`, which is catalog copy describing the one
request shape that receives a 403.

**9router's free lane is aspirational and stale.** `registry/opencode.js` sets
`noAuth: true`, `forceStream: true` and `baseUrl: "https://opencode.ai"` as a
placeholder, then hardcodes four models — one of which, `union-alpha`, is absent from
the catalog and refused by every lane. Its own connection test already knows the lane
can be down: it probes `https://opencode.ai/zen/v1/models` with `Authorization: Bearer
public` and reports `OpenCode free tier unavailable` when that fails.

A "works in 9router" or "works in OmniRoute" report about these models should be read
as *"that project advertises them"*, not *"that project served them"*. The
`mimo` name collision described above is a third possibility and the cheapest to
check.

### A model name that looks the same and is not

`mimo-v2.6-flash-free` on Zen and `xiaomi/mimo-v2.6-flash` on OpenRouter are
different models from different vendors, and the ids are close enough to be mistaken
for one another. The same holds for `mimo-v2.5-free` against `xiaomi/mimo-v2.5`.
Measured on both: the OpenRouter pair answers with the paid Xiaomi route, while the Zen
free pair refuses with `403`. A report that "Mimo works in my other gateway" is
consistent with having been served `xiaomi/mimo-v2.6-flash` there, so the model id and
the provider both need checking before concluding a route is broken.

A refusal that looks like a routing failure is worth re-testing under the other
provider's id before it is treated as one.

**Every free model is on the path this gateway already speaks.** Measured on the
free tier: `space-bunny-free` answers normally, while `nemotron-3-ultra-free`,
`mimo-v2.6-flash-free` and `ling-3.0-flash-fin-free` are refused with a bare `403`
and an empty body — from the same key, on the same endpoint, all listed as free.
That is a refusal at the provider, not a routing fault here. Zen documents that
admins can disable individual models for a workspace, and the Nemotron free models
are NVIDIA trial endpoints. Nothing in this gateway can change the answer.

A refusal that arrives with no body is reported as one, rather than as silence:
`HTTP 403 with an empty response body`. Silence reads as a gateway problem, and a
stated refusal does not.

A connection is not limited to the built-in adapters. `PUT
/v1/connections/:id` accepts any provider ID with a caller-supplied `endpoint`,
and the gateway builds an `OpenAICompatibleAdapter` for it on demand, cached by
endpoint. That covers Ollama, vLLM, LM Studio, Together, Groq, and any other
OpenAI-compatible server without a code change, and the request still uses the
shared transport and the encrypted credential vault. `POST
/v1/connections/:id/check` validates a candidate key against a registered
provider before saving.

The dashboard reaches that route through `putGatewayConnection`. Adding a
provider other than OpenRouter used to report success without writing anything:
the modal handed the API key over for OpenRouter alone, so every other provider
reached the page with no key, and the page only implemented the OpenRouter save.
A card could therefore look connected with no credential behind it. The key is now
passed for any provider that asks for one, and every other provider is saved
through the generic route.

### Several connections per provider

Credentials are addressed by **connection id**, not by provider id, so one provider
can hold several connections — two Cline accounts, a spare OpenRouter key. The
connection id comes from the request when given, and otherwise reuses the
provider's existing connection, so a plain save still updates in place.

Three things follow, and each is a trap worth naming:

- **The stored credential map is never read by provider id.** Falling back to a
  provider-keyed entry would hand one connection's secret to every other
  connection of the same provider. The only provider-keyed lookup left is the
  environment credential store, which is where `PROVIDER_API_KEY` lives.
- **The orphan sweep compares connection ids.** A stored key matching no
  credential-bearing connection is discarded. For a single-connection provider the
  two are the same string, which is why an existing vault still resolves after
  the change with no migration.
- **Health is a provider-level signal** and is checked with that provider's first
  credentialed connection. Per-connection health is not reported.

Requests resolve the credential through the connection that serves them: routing
already produced a `connectionId` per candidate, and a direct provider call
resolves the owning connection. Reading by adapter id would have used whichever
credential happened to be written last.

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
   returns a sign-in URL. A non-loopback redirect is refused, so a callback can
   never be pointed somewhere else.
2. The dashboard opens that URL in a tab. The tab is opened blank inside the
   click that started the flow, because a browser only allows `window.open`
   during a user gesture, and the dialog navigates it once the URL exists.
3. The user approves in the browser, and Cline redirects to
   `GET /v1/oauth/cline/callback/:sessionId`, which is the one route exempt from
   the cross-site guard, because a top-level navigation from the provider sends
   `sec-fetch-site: cross-site` and no `Origin`.
4. The exchange proves the token with a real `GET /v1/users/me` before anything
   is written, then discovers the model catalog and saves the connection. A
   rejected code is reported as an authentication failure; an unreachable token
   endpoint stays an upstream failure, so an outage is never misreported as a
   bad sign-in.
5. The outcome is recorded on the session, and the dashboard learns it by
   polling `GET /v1/oauth/cline/session/:id`. A session lives five minutes, so a
   sign-in cannot be resumed after the user has walked away, and a finished
   session is dropped a minute later. The status carries an error message or the
   whole connection record — never a credential.

A connected status carries the **complete** record, the same metadata the
connections route returns. A trimmed subset looks sufficient and is not: the
provider page reads `resilience` and `modelPolicy` off it, and a missing
`resilience` throws on the first access and blanks the page.

Two rules follow, because that page renders the resilience panel as soon as any
connection is set — there is no intermediate state where a partial record is
safe:

- **The gateway is the source of truth.** After a sign-in the page re-reads the
  record from the connections route rather than adopting whatever shape the
  sign-in handed over, so a payload change cannot reach the UI.
- **A required field is never read unguarded.** The resilience panel falls back
  to the documented defaults when a record arrives without a resilience block,
  so an incomplete record degrades to "no tuning" instead of throwing during
  render. A render-time throw here takes down the whole page, not one panel.

**The session id travels in the redirect path, not in `state`.** Cline hands the
sign-in to WorkOS AuthKit, which starts a session of its own and never echoes a
caller-supplied `state` back, so a flow correlated by `state` alone can never
match. The session id therefore goes in the path of `redirect_uri`, which the
provider must honour verbatim in order to redirect at all. A `state` is still
minted and sent, and is still checked whenever it does come back, so a provider
that echoes it gets the stronger guarantee for free.

Two invariants follow, and both are pinned by tests:

- **The same redirect is used twice.** The `redirect_uri` sent to the token
  endpoint must equal the one the authorize request carried, so the session is
  created with its final redirect rather than patched afterwards. Getting this
  wrong makes the provider reject an otherwise valid code.
- **A session is claimed once.** Claiming is tracked by an explicit flag, not by
  the absence of a `state`, because `state` is optional. A replayed or forged
  callback is refused rather than exchanging an attacker's code into the user's
  vault. A callback that carries a *wrong* `state` spends nothing, so a user
  whose provider crossed the value can retry.

A callback that identifies no session is not exchanged, and its message points
at the paste box rather than only telling the user to start over.

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

**A failed renewal is a sign-in problem, whatever shape the refusal takes.** The
refresh endpoint refuses with a plain 4xx, which surfaced as
`PROVIDER_REQUEST_FAILED` for what is really an expired session. It is now reported
as an authentication failure reading "the Cline session expired and could not be
renewed, sign in again", keeping Cline's own wording when there is any.

**A health check carries a reason.** `healthCheck` returns a message rather than a
bare `unavailable`, because the symptom alone is unactionable: an expired token, a
revoked token, an unreachable endpoint, and a cancelled probe all look identical
otherwise. `clineFailureReason` maps the error to a short, safe explanation.

**Token prefixing.** Cline accepts WorkOS JWTs only with an explicit `workos:`
prefix, and rejects non-JWT ClinePass keys (`clp_…`) that carry one. The adapter
applies the prefix only to JWT-shaped tokens and sends everything else verbatim.

**Client identification.** Every Cline request carries the header set Cline's own
clients send: `HTTP-Referer: https://cline.bot` (the public site, not the app
host, because that is what Cline attributes a request by), `X-Title`, `User-Agent`,
`X-CLIENT-TYPE`, `X-PLATFORM`, `X-PLATFORM-VERSION`, `X-CLIENT-VERSION`,
`X-CORE-VERSION`, and `X-IS-MULTIROOT`. A request that omits them is answered with
a 4xx that reads like a bad request rather than an unrecognised client.

**The chat envelope.** A non-streaming chat completion comes back wrapped as
`{"success":true,"data":{ …choices… }}`, and a failure as `{"success":false, …}`
inside a 200 response. Reading the wrapper as an OpenAI response is a parse
failure rather than a result, and the failure shape is invisible. The compatible
adapter takes an optional `unwrapResponse` for exactly this, scoped to
non-streaming: a provider whose *streaming* format differs needs its own adapter,
not a hook that reshapes a live event stream. The Cline unwrapper returns the
inner body and raises `{"success":false, …}` as a `ProviderError` carrying Cline's
own reason.

**Expiry units.** Cline reports the expiry in epoch seconds, the unit a JWT `exp`
uses, and not always in milliseconds. A seconds value handed straight to `new Date`
lands in 1970, which makes a valid token look expired and sends every request down
a refresh that then fails. Both the decoder and the adapter's refresh check
normalise the unit, so a value below `1e12` is read as seconds.

### Cline endpoints

Cline serves its whole API under `/api/v1`, so the adapter's base URL is
`https://api.cline.bot/api/v1`. Getting that wrong is silent and fatal: the
generic `models` path then resolves to `api.cline.bot/models`, which Cline
answers with `401 Unauthorized: Please make sure you're using the latest version
of Cline and re-authenticate your Cline account.` — an error that reads like a
credential problem rather than a wrong URL.

Two of these endpoints are deliberately used for different jobs:

| Endpoint | Authenticates? | Used for |
| --- | --- | --- |
| `GET /api/v1/users/me` | yes, `401` without a valid token | proving a sign-in before it is stored |
| `GET /api/v1/models` | **no, `200` to an unauthenticated request** | the model catalog and chat traffic |

The catalog is public, so it cannot tell a good token from a bad one and is never
used as the credential check. A sign-in is proved against the account endpoint,
which is the only one that actually checks.

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

A provider page loads its saved connection for **every** provider, matched on
`providerId` plus `hasCredential`. Restricting that to the first provider that
shipped with a flow makes every other provider report "No connection" on a fresh
load, however it was added, which reads as data loss rather than as a display
bug.

A provider page filters its own model list. A provider can carry hundreds of
models — Cline alone contributes 458 — so searching within one provider is the
only practical way to find one. The field sits directly above the list, matches
the whole model ID and the part after the vendor prefix, shows `Showing N of M`,
and has a clear control. An empty result says how many models were searched, so
"no match" is distinguishable from "nothing imported".

`Test all` acts on the models the list is showing and says so — `Test 8 shown`
when a filter is active — rather than quietly running a bulk test over the whole
catalog the operator cannot see.

The model list is also narrowed and ordered by test result. A result filter
(`All` / `Untested` / `Passed` / `Failed`) counts what it would show, and a sort
orders by name, fastest, or slowest. Untested models sort last in either latency
order, because they have no latency and a list of blanks at the top reads as a
broken sort. **The result filter is suspended during a bulk run**: applying it
would empty the list as each model flipped to testing, taking the rows out from
under the workers and making progress unreadable.

Failures stay on the row that failed. There is deliberately no aggregate failure
panel — a failed model's reason is on its own row, and the `Failed` filter is one
click away. A separate summary duplicates that and costs screen space on a page
whose list is already the main content.

The providers page also searches models as well as provider names. A model matches on
its whole ID and on the part after the vendor prefix, so `claude-sonnet` finds
`anthropic/claude-sonnet-5`. Only imported models are searchable — a connection's
`modelIds` or a catalog entry — and a model hit keeps its provider card visible so
the result is actionable. Results are grouped by provider, capped per provider,
and labelled with whether that provider is actually serving: `serving`, `saved ·
needs attention`, or `not connected`. A saved connection is never reported as "not
connected", because that hides a credential the operator has.

**Health is recorded from the reported status, not from the absence of a throw.**
An adapter may return `unavailable` instead of raising, and treating that as a
success made routing report a healthy provider with zero failures while `/health`
said unavailable — corrupting the failure counting that drives ejection.

A provider's own wording reaches the operator through `providerMessage` on the
error envelope, but **only** for an allowlisted local dashboard origin. API
clients get the provider-neutral message, so a provider's internal detail is never
exposed to a consumer of the gateway endpoint.

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
