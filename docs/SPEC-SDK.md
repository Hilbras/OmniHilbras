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

### Where a provider URL is allowed to point

A connection's `endpoint` is operator-supplied, so it is the one string in the system that decides where a
request carrying a credential actually goes. `assertSafeProviderRequestUrl` (`packages/omnihilbras-sdk/src/url.ts`)
is the single decision point, and it is called in two places: on save, in `routes/connections.ts`, and again
at the transport, in `transport.ts`. Both matter — a connection written before a rule tightened, or a
resolved base URL that drifted, must not bypass the check that admission applied.

The rules, in order:

| Rule | Why |
| --- | --- |
| scheme must be `https:`, or `http:` to a loopback host | cleartext to a remote host would put a credential on the wire in the clear; local Ollama and LM Studio over `http` is the supported exception |
| no `user:password@` in the authority | a secret smuggled into a URL ends up in logs and error messages |
| no query or fragment on a base URL | they are not part of an endpoint's identity, and `resolveProviderUrl` compares against the base |
| not a private, loopback, link-local, or unspecified destination | SSRF: `169.254.169.254` is the cloud instance-metadata endpoint, and reaching it from a gateway that holds provider credentials is the whole attack |

**A private IPv4 address is also private when it is written as IPv6.** `isPrivateHostname` unwraps an
IPv4-mapped (`::ffff:a.b.c.d`) or IPv4-compatible (`::a.b.c.d`) address and judges the embedded IPv4 by the
same rules. This is not theoretical: `https://[::ffff:169.254.169.254]/` was accepted and stored by a
running gateway while the plain form was correctly refused, and it carried a real TCP connection to a
loopback listener. Note that `new URL()` normalises the address to `[::ffff:a9fe:a9fe]` before the guard
sees it, so the hex spelling is the only one that ever arrives.

`isLoopbackHostname` is deliberately **narrower** than `isPrivateHostname` — it is what permits cleartext
`http:`, so it must not accept the mapped form, or arbitrary private hosts become reachable without TLS.

Known gap, recorded rather than fixed: a hostname that resolves to a private address (`localtest.me` →
`127.0.0.1`) is allowed, because deciding that requires resolving at request time — which needs a policy
for DNS failure and adds a lookup to every provider call. That is a design decision, not a missing check.

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

- `GET /health` — gateway and configured adapter health. Each provider entry carries
  **`verified`**: `credential` means the credential was accepted and the catalog or session is
  readable; `inference` means a request actually completed. The field is **required**. A
  health poll runs every 60 seconds on every adapter, so a real completion per poll would be
  a real bill every minute, and a verdict that does not say which question it asked cannot be
  read as a claim about traffic. Two OpenCode connections reported `healthy` with
  `verified: 'credential'` while every model on them was refused by the provider, and the
  dashboard rendered that as "Route health 100%". A consumer that needs the stronger claim
  has to make a request.

  **Every surface that shows a verdict names what it established**, and reads the same report. The
  provider detail page used to read health only when **Test provider** was pressed, so it reported
  "ROUTE HEALTH: Pending" for a connection the providers page was simultaneously showing a poll for —
  two pages, one fact, two answers. The providers summary used to read a hardcoded `92%` labelled
  "last 24 hours", with `GET /health` called on every load and its result merged into the cards and
  then discarded. Both now read the report they display, and both label a credential check as one.
- `GET /v1/models` — normalized models from configured adapters.
- `GET /v1/connections` — connection metadata without credentials.
- `POST /v1/connections/:providerId/check` — validate a candidate API key for any provider without
  saving it. Accepts `{ apiKey }`, and optionally `endpoint` for a proxied or self-hosted provider; a
  supplied endpoint goes through the same address check as a saved one. `/openrouter/check` is this
  route with that provider in the path, not a second route — see below. **The dashboard's Check button
  uses this for every provider**, and reports only what comes back; a check that cannot be performed is
  stated in the UI rather than simulated.
- `PUT /v1/connections/openrouter` — validate again, discover the selected model policy, then upsert the single local OpenRouter connection.
- `POST /v1/connections/:id/models` — add validated model IDs to a saved connection.
- `DELETE /v1/connections/:id` — remove a local connection.
- `GET /v1/keys` — gateway key metadata plus the enforcement flag; never returns a secret.
- `POST /v1/keys` — mint a key; the response is the only time the secret is returned.
- `PATCH /v1/keys/:id` — pause or resume a key.
- `DELETE /v1/keys/:id` — revoke a key.
- `PUT /v1/connections/:id/resilience` — update one connection's retry, timeout, and rate-limit budget.
- `PUT /v1/connections/:id` — save or update a connection. A discovered **model metadata map** (display name, context window, modalities, and per-1M prices) is preserved across a save that does not supply one, and replaced by one that does; it was silently dropped on every save before 1.62.0.
- `GET /v1/routing` — live routing state: budgets, recent failures and successes, ejection, last latency, last error, and `rateLimitWaitMs` (absent when never checked, `0` when checked and free).

  Routing holds two maps keyed by connection id — the recorded waits behind `rateLimitWaitMs`, and the
  timestamps inside each connection's per-minute budget — and **both are released when a connection is
  deleted**, from `RoutingEngine.plan()`, which is the only place in the process where the live set is known
  to be current. Before 1.66.0 neither had a way to forget: dispatching to 2000 connections and then deleting
  all 2000 left 2000 of each retained. Neither was visible — this route filters by the live connections — so
  nothing about the rendered page changed as the maps grew.

  Retention is by **existence**, not age. `SlidingWindowRateLimiter.prune()` already existed and answers a
  different question ("is this timestamp still inside the window?"); it is kept and still needed, since a live
  connection's window grows until pruned. Pruning waits by age would drop a recorded `0` for an
  intentionally idle connection and report it as never checked, which is the distinction `rateLimitWaitMs`
  exists to preserve.
- `GET /v1/settings` — the configuration **this process loaded**, after defaults, parsing and validation.
  Read-only, and it answers `405` to anything else rather than accepting a write that does nothing. Reports
  `host`, `port`, `localOnly`, the four resilience values, `corsOrigins`, `dataDir`, the provider base URLs,
  and two lists: `mutableAtRuntime` (`requireApiKey`, the only one) and `mutableByRestart` (everything else),
  so the dashboard does not present a restart-only value as editable. **No secret is served** — the response
  is built from an explicit field allowlist rather than by filtering, and `assertNoSecrets` then refuses
  (rather than redacts) any credential-shaped key that appears, because a loud failure during review beats a
  quiet one that ships. A service constructed without a loaded configuration reports `settings: null` with a
  reason, because inventing defaults here would duplicate `config.ts`'s own and give one gateway two sets of
  numbers.
- `GET /v1/usage` — recorded per-request usage: totals, the newest records first, and a `cost` object. Rendered by `UsagePage.tsx` at `/dashboard/usage`. Optional query
  parameters `provider`, `model`, `connection`, `since`, `until`, `outcome` (`success`/`failure`/`cancelled`)
  and `limit` (0–10000); an unknown `outcome` or a malformed `limit` is a 400 rather than a filter that
  silently matches nothing. **A record holds no prompt, no response, no headers and no credential** — the
  type has no field capable of holding one, so there is nothing to redact. Token totals sum only over records
  whose provider reported usage, and `tokensUnmeasured` is `true` when *no* record did, so an absence is not
  presented as a measured zero. A gateway started without a usage store answers `recording: false` with empty
  totals rather than zeros that read as "nothing was spent". Behind the admin key when enforcement is on, with
  `/v1/routing`: a record describes what this machine talks to.
- `POST /v1/oauth/cline/start` — begin a sign-in; returns the sign-in URL, a session id, and a single-use `state`.
- `GET /v1/oauth/cline/authorize` — build the Cline sign-in URL for a loopback callback.
- `GET /v1/oauth/cline/callback` — where the provider redirects the browser; completes the exchange and reports the outcome.
- `GET /v1/oauth/cline/session/:id` — whether a started sign-in is pending, connected, failed, or expired.
- `POST /v1/oauth/cline/exchange` — exchange a pasted callback URL or code, prove the token against Cline, then save the connection.
- `POST /v1/oauth/kiro/start` — begin a Kiro sign-in. A company IAM Identity Center tenant supplies its own `startUrl`; a plain Builder ID sign-in omits it and gets the public one.
- `GET /v1/oauth/kiro/session/:id` — whether a Kiro sign-in is pending, connected, failed, or expired.
- `POST /v1/oauth/kiro/import-token` — spend a refresh token the user exported from Kiro. **The pasted
  token is spent once to obtain an access token, and the access token is what is stored**, so the
  long-lived secret a user pastes is not the credential every later request authenticates with. A
  refresh token is bound to the client it was issued to, so an imported one is redeemed against a
  client registered here; AWS refuses a token from another client with `invalid_grant` and that
  answer is passed through rather than reported as a bad paste.
- `POST /v1/oauth/kiro/api-key` — store a long-lived Kiro/CodeWhisperer key **as given**. It has no
  refresh token, so it cannot be renewed and has to be replaced by hand. This is the one credential
  route that stores the pasted secret itself, which is why it is written down separately.
- `POST /v1/oauth/kiro/social/start` — begin a Google or GitHub sign-in. The returned URL redirects
  to a `kiro://` scheme only the Kiro desktop app handles, so the browser cannot return here on its own.
- `POST /v1/oauth/kiro/social/exchange` — exchange the code the user pasted. The code is spent at
  most once: a second attempt against the same session is refused rather than sending an
  already-used code to Kiro.
- `POST /v1/oauth/opencode-console/start` — begin an OpenCode Console device-flow sign-in.
- `GET /v1/oauth/opencode-console/session/:id` — whether a device flow is awaiting approval, connected, or failed.
- `PUT /v1/settings/require-api-key` — turn LLM-surface enforcement on or off.
- `POST /v1/web-cookie/tokenharbor/check` — verify a pasted Token Harbor session cookie against
  `tokenharbor.ai` by reading the account profile, and store nothing. A credential check, not a
  completion: it says whether the session is accepted, not whether a model can answer.
- `POST /v1/web-cookie/tokenharbor/connect` — store the session cookie as a connection after it is
  verified. Accepts the whole `Cookie:` header or the `sb-auth-auth-token` value alone, rejoins its
  numbered chunks, and honours `freeOnly`.
- `POST /v1/oauth/kimi-code/start` — begin a Kimi Code sign-in. Kimi's device flow, so the response
  carries a `userCode` and a `verificationUrl` for the user to approve in their own browser; there is no
  redirect back. Both halves of the flow are **form-encoded**, which is measured: Kimi answers a JSON
  body with `400 client_id is required` even when the parameter is present, and returns a device code
  only from `application/x-www-form-urlencoded`. The session id is shape-checked before it reaches the
  store, and the device id minted at the start is carried on the session so the poll presents the same
  one — Kimi ties the two halves of a grant together by it.
- `GET /v1/oauth/kimi-code/session/:id` — whether the Kimi Code sign-in is pending, connected, failed or
  expired. The device code is never in this response. A well-formed id that does not exist is `404`; an
  id that is not a plausible session id is `400`, refused before any lookup.
- `POST /v1/oauth/claude-code/start` — begin a Claude Code sign-in: the Anthropic **subscription**, reached
  by OAuth, not the metered `anthropic` API key. Returns the URL to open and the session id to poll. The
  flow is authorization-code with PKCE — the verifier is minted here and **never leaves the session**, and
  the session id rides in the redirect **path** so a callback can be tied to its verifier even if Claude
  does not echo `state`. `claude.ai/oauth/authorize` answers a server-side fetch with a Cloudflare
  interstitial rather than a code, so this flow is a browser redirect rather than an API call.
- `GET /v1/oauth/claude-code/callback/:sessionId` — where Claude redirects the browser; completes the
  exchange and reports the outcome on a small HTML page. The raw query is handed over rather than the
  parsed `code`, because Claude repeats the code after a `#` and both halves are needed. Exempt from the
  cross-site guard and from the API-key gate alongside Cline's callback, because a top-level navigation
  carries no `Origin` and could not carry a key either. The
  session is claimed **before** the exchange, since an authorization code is single-use.
- `GET /v1/oauth/claude-code/session/:id` — whether a started Claude Code sign-in is pending, connected,
  failed, or expired. A well-formed id that does not exist is `404`; an id that is not a plausible session
  id is `400`, refused before any lookup. The PKCE verifier is never in this response.
- `POST /v1/chat/completions` — normalized gateway chat request/response.
- `POST /v1/embeddings` — normalized embeddings, one vector per input. `input` is a non-empty
  string or a non-empty array of them; `encoding_format` must be `float` (base64 is refused rather
  than silently returned as floats). `dimensions` is echoed per vector **only when the adapter
  measured it** — it is derived from the vector's own length, so it cannot disagree with the vector,
  and it is omitted when the provider reports nothing. A provider with no embeddings endpoint returns
  `404 NOT_SUPPORTED` naming that provider rather than an empty vector list. Served only by adapters
  that declare `capabilities.embeddings` — `OpenAIAdapter` does, the general `openai-compatible`
  adapter does not, because an OpenAI-shaped base URL is not evidence that the server implemented an
  embeddings endpoint.
- `POST /v1/chat/completions` with `stream: true` — normalized SSE chunks.
- The dashboard provider test uses live adapter health; each model test uses a bounded real chat completion through the same route.
- A model test must fail when the model returns no visible output. A well-formed
  envelope with empty content is not a working model, and a `Ping` badge beside a
  model that answers nothing is a false report. A response carrying tool calls
  counts as an answer even with no text.

**One provider must not be written into a route that already handles every provider.** The
credential check existed twice: a generic `POST /v1/connections/:providerId/check` and a copy
pinned to `openrouter`, registered *ahead* of it. The copy accepted fewer fields, so the same body
was refused for OpenRouter and accepted for Anthropic:

```
openrouter check with an endpoint → 400  Request contains unsupported fields.
anthropic  check with an endpoint → 200  valid
```

Nothing asked for that difference. The copy is gone; the generic route answers for every provider,
and `/openrouter/check` is that route with a provider in the path. The rule that follows: if a route
has to name a provider to work at all, that is the signal to ask what the generic route was missing
— not to add a branch in front of it. A second handler for a case the general one covers is a copy
that is free to disagree, and it will, because the narrower one is the one that gets registered
first.

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

## Publishing: what a consumer actually receives

The SDK is published as `@hilbras/omnihilbras`. Two facts about the artifact are not visible from
inside this repository, and both have caused defects:

- **`@types/node` is a devDependency here and absent from the published surface.** Anything inferred
  from `process.*` or `Buffer` into an emitted declaration becomes a type the consumer may not have. This
  shipped: `clineHeaders` had `'X-PLATFORM': process.platform`, which infers as `NodeJS.Platform`, and
  `tsc` writes that inference straight into `dist/adapters/cline.d.ts`. Packed into a consumer with no
  `@types/node`, it failed to compile — `error TS2503: Cannot find namespace 'NodeJS'`, exit 2.
- **Four independent reasons hid it here:** the SDK typechecks against its own `@types/node`; the root
  `tsconfig.json` sets `skipLibCheck: true`; the dashboard consumes the `workspace:*` link rather than
  the tarball; and nothing compiled the artifact *from outside*.

**The rule that follows: annotate a return type wherever a `process.*` value enters an object that is
returned.** Inference is fine internally and is exactly what leaks. `tests/published-types.test.js`
asserts the general property — no emitted declaration may name `NodeJS.*` or `Buffer` — rather than the
one line, because the next instance would be a different file with a different suffix.

The consumer check that found it is worth keeping: `npm pack`, install the tarball into a project with no
`@types/node`, and compile with `skipLibCheck: false`. Capture `tsc`'s exit code directly — piping to
`head` reports *head's* status, which is zero whether or not the compile failed.

## Gateway API Keys

Keys authorize the LLM surface **and the management surface**; management routes
additionally stay reachable from the local dashboard, which is identified by an
allowlisted browser origin. The contract:

- A key is `ohk_` plus 32 random bytes in base64url. Only its SHA-256 hash is
  persisted, so the secret is unrecoverable after creation and rotation means
  creating a replacement.
- Presented keys arrive in `Authorization: Bearer <key>`, `x-api-key`, or
  `x-goog-api-key`. Query-string keys are rejected so secrets stay out of logs
  and shell history.
- Hashes are compared in constant time across every stored key, and paused or
  deleted keys fail immediately.
- Enforcement defaults to on and guards `GET /v1/models`,
  `POST /v1/chat/completions` and `POST /v1/embeddings`. Requests carrying an allowlisted dashboard
  `Origin` are exempt: they are already protected by the origin allowlist and
  the cross-site request check, and the dashboard must keep working without
  holding a key. Anything else — CLI tools, IDE extensions, scripts — must
  present a key while enforcement is on.

- **Enforcement also guards the management surface** (1.46.0). Until then the
  only consumer of `ctx.auth` in the route layer was `handleInferenceRoute`, so
  the routes that *mint* a key and *disable enforcement* sat outside the gate.
  Measured against a running gateway with no `Origin` and no `Authorization` —
  a plain local process — `POST /v1/keys` returned a full secret and
  `PUT /v1/settings/require-api-key` turned the gate off. The gate now sits at
  the single dispatch point in `server.ts` and covers
  `/v1/connections`, `/v1/keys`, `/v1/oauth`, `/v1/settings`, `/v1/web-cookie`
  and `/v1/routing`. `authorize()` returns early when enforcement is off, so
  local mode and every test that builds a gateway without a key store are
  unchanged.
- **The provider callbacks are the one carve-out from the management gate**
  (1.75.2). `/v1/oauth` is on that list, and a provider's callback is a
  top-level navigation the browser is *sent* to, so it is the one request in the
  product that cannot carry an `Authorization` header. With enforcement on it
  answered `401 AUTHENTICATION_FAILED` — *"This gateway requires an API key…"* —
  which made the sign-in unreachable rather than secure. `GET
  /v1/oauth/cline/callback/:sessionId` and `GET
  /v1/oauth/claude-code/callback/:sessionId` are now exempt, using the *same*
  predicate that already exempts them from the cross-site guard so the two
  exemptions cannot drift apart. What that costs, stated: those two GET paths are
  reachable by an unauthenticated local process. They render an HTML page whose
  only content is a short outcome message; no token is in it or in the response,
  and a callback can only act on a session this gateway minted — the session id
  carries 256 random bits for Cline and 122 for Claude Code — with the provider's
  code as the other half. The routes that carry the result, `/v1/oauth/*/session/*`,
  and the ones that mint credentials, `/*/start` and `/cline/exchange`, stay
  gated. The predicate is GET-only and path-exact, so a `POST` to a callback path
  is refused like any other management route.
- **Known limitation, recorded not papered over.** `kind: 'dashboard'` is derived
  from the `Origin` *header*, which any non-browser client can set, so a local
  process can claim to be the dashboard and skip the gate. Closing that needs a
  per-launch secret the browser presents, which is a design change rather than a
  patch. Until then the gate raises the bar from *any local process* to *a local
  process that also knows the key* — the difference between an accidental
  postinstall script and a deliberate attacker.
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

**The restriction is a request contract, not a key and not a header in isolation.**
Corrected in 1.42.0, after this document claimed otherwise. It previously read:

> The restriction is not a header, a key, or a stream setting: it survives `x-opencode-client: desktop`,
> an `opencode/…` User-Agent, the sentinel `Bearer public`, and `stream: true`, and it is not lifted by a
> valid key.

Each of those was tested **alone**, and the conclusion drawn was that the combination must not matter. It
does. `/home/gin/work/OmniRoute` serves the same free models through the same base URL with
`authType: "apikey"` — a Zen API key, not a session token — and records the four conditions the upstream
requires together:

1. `stream: true` in the body,
2. a non-empty `tools` array, using the official client's placeholder name `_noop`,
3. an `x-opencode-session` header shaped `ses_` + 12 hex + 14 base62 (the shape is checked, the value is
   not),
4. a `User-Agent` carrying `opencode/<version>` with version ≥ 1.17.

Removing any one of the four turns a 200 into a 403. `ZenAdapter` now sends all four for any model whose
id ends `-free`, and streams upstream to satisfy condition 1 — there is no non-streaming path, so a
caller asking for JSON gets the permitted request decoded.

**Measured from a datacenter egress, the contract is necessary but still not sufficient.** All four
applied and the upstream answers 403 `FreeTierError`. The working implementation names the likely reason
twice: the CLI identity headers exist because *"Cloudflare requires [them] on VPS egress"*, and the free
tier *"rejects generic client UAs from datacenter IPs"*. That is a hypothesis, recorded as one — proving
it needs a request from a residential IP. What is not a hypothesis is the error: a free model refused
**after** the contract was applied is not a credential problem, and the message says so rather than
sending the operator to rotate a working key.

Two parts of the contract move, and are therefore configuration rather than constants:
`OMNIHILBRAS_ZEN_PLACEHOLDER_TOOL` (the accepted placeholder name differs per model and changed within a
week) and `OMNIHILBRAS_ZEN_USER_AGENT`. Which models are gated is decided by the `-free` suffix rather
than a list, because the upstream rotates its free lineup — six models were delisted and replaced inside a
week.

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

### Model metadata and filters

A model is more than an id, and the dashboard can only filter on what a provider actually
publishes. `Model` therefore carries optional `inputModalities`, `outputModalities` and
`pricing`, and only the catalogs that state them fill them in:

| Provider | context | modalities | pricing |
| --- | --- | --- | --- |
| OpenRouter | `context_length` | `architecture.input_modalities` | `pricing.prompt` / `completion`, **per token** |
| OpenCode Console | `limit.context` | `modalities.input` | `cost.input` / `output`, **per 1M** |
| Cline, Zen API key, generic | not published | not published | not published |

The two quoting styles are the reason prices are normalised at the edge. OpenRouter
publishes per-token strings (`"0.0000025"`), Zen publishes per-1M numbers (`2.5`), and
converting both to **per 1M** at the adapter means the dashboard never has to know which
provider a model came from. Guessing the unit instead would render a price a million
times out, so the converters are separate and both are tested against the real shapes.

**An absent field is never a zero.** This is the rule the whole feature rests on:

- A model with no published price is **unknown**, not free. A free filter selects models
  that stated zero, and a separate "no price listed" filter finds the rest.
- A provider that says nothing about modalities has not been shown to lack them, so an
  unstated model does not satisfy a modality filter.
- A model with no stated context window does not satisfy a minimum-context filter.
- A filter is **only offered when the provider published the field it filters on**, so a
  minimal catalog does not present three controls that can never match.
- Untested models sort last in *both* latency directions. A column of blanks at the top of
  a "slowest first" list reads as a broken sort.

Metadata is captured while discovery already runs, so a save or a
`POST /v1/connections/:id/models/refresh` costs no extra provider request. It is stored
compactly — short keys, since a full catalog runs to hundreds of entries per connection —
and validated on read like the rest of the metadata file, because it is the one field
that can grow without bound.

The filter rules live in the SDK rather than the dashboard: they are rules about provider
pricing semantics, and that is where they can be tested.

### Kiro, and the caution it carries

Kiro is in the OAuth group with a working sign-in, and it carries a standing warning
because **its terms prohibit third-party proxy and harness use** — which is exactly what
this gateway is. The reference project this was built from flags it the same way:

```ts
subscriptionRisk: true,
riskNoticeVariant: "deprecated",
freeNote: "Free tier: 50 credits/month (~25K–100K tokens). ⚠️ Kiro ToS prohibits third-party proxy/harness use."
```

The warning is not decoration and not dismissible. It appears on the card in both the
compact and full views, again on the provider page, and once more inside the sign-in
dialog, where **nothing is sent to AWS until it is acknowledged**. A caution that only
appears in one place, or that a single click can bypass, is not a caution.

Kiro is not an OpenAI-compatible endpoint, so there is no generic adapter for it. It is
CodeWhisperer's streaming service:

| | |
| --- | --- |
| Sign-in | AWS SSO OIDC **device authorization**, with the public client registered per sign-in |
| Inference | `POST codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse` |
| Framing | `X-Amz-Target: AmazonCodeWhispererStreamingService.GenerateAssistantResponse`, `Accept: application/vnd.amazon.eventstream` |
| Request | a `conversationState` envelope, with the model id on the current message and earlier turns in `history` |
| Response | an AWS eventstream: `:event-type:` metadata lines with `data:` payloads |

Two things about it that are easy to get wrong, and were:

**The device authorization needs a start URL.** AWS answers `400 Start URL is required`
without one, so it is part of the grant rather than a preference.

**A pending grant is an HTTP 400, and the state is in the body** —
`{"error":"authorization_pending","error_description":"Authorization is still pending"}`.
The provider transport deliberately flattens an error body into a human sentence, and the
flattened detail keeps only the description, so the grant reads as a *failure* and the
sign-in dies while the user is still approving it. OAuth token endpoints are therefore
read directly, and inference still goes through the transport where that flattening is
what we want. This is the same shape as the OpenCode Console poll, and the reason both
auth paths bypass the transport.

A system turn is folded into the user content, because the envelope has no system role.
A model Kiro does not offer is refused *before* a request is spent, since an unknown id
comes back as `400 Invalid model` and the catalog has no wildcard to fall back on.

### The binary eventstream, and a parser that was confidently wrong

Kiro's answer is the **binary** AWS eventstream, and the first version of this adapter
parsed a text framing that the service never sends. Every request returned 200 and every
one of them failed with `INVALID_RESPONSE` — indistinguishable, from the outside, from a
provider that had answered nothing. The tests passed the whole time, because they were
built from the same wrong assumption as the parser.

The layout, read off a real captured response:

```
u32 total_length     frame length, INCLUDING these four bytes
u32 headers_length
u32 prelude_crc
headers              name_len u8 | name | type u8 | value
                     type 7 (string) -> value_len u16 | value
payload              total_length - headers_length - 16
u32 message_crc
```

Three things are worth recording, because each was a wrong guess first:

**The header names carry a leading colon.** The bytes are `:event-type`,
`:content-type`, `:message-type`. That is why the text rendering of the same stream shows
`:event-type:` and why a parser written against that text rendering looks for the same
prefix. A parser that strips or omits the colon matches no frame.

**The payload is flat.** A frame carries `{"content":"Hey","modelId":"claude-haiku-4.5"}`,
not a body nested under a key named after the event. The event name is in the header and
nowhere else.

**There is no `messageStopEvent` and no `usageEvent`.** A real response is
`assistantResponseEvent`, `contextUsageEvent` and `meteringEvent`. An adapter that waits
for a stop event waits forever, and one that reports `usage` for Kiro is inventing it.

`total_length` counts itself, so a frame occupies exactly that many bytes and frames can be
walked by length rather than scanned for a separator. A frame claiming an impossible length
ends the walk: a truncated body must not be read as a complete one.

The transport could not carry this at all — it decoded bodies as text, and a UTF-8 decode
of a binary stream mangles its length prefixes and CRCs into something that looks like an
empty response. `HttpRequest` therefore takes `responseAs: 'bytes'`, bounded by the same
limit as the text path.

**Kiro meters credits, not tokens.** `meteringEvent` carries `usage` in credits, and there
is no token count anywhere in the response. `usage` is left unset rather than reported as
zero — an absent field is not a zero — and the credit cost is carried in its own `meters`
field so a metered call is never reported as a free one. `contextUsageEvent` becomes
`contextUsagePercent`.

The captured response is committed as `test/fixtures/kiro-stream.bin` and the framing tests
run against those bytes. A hand-built fixture for a guessed format is what made the original
parser look correct.

### Kiro's six ways in

The reference project this was built from offers six, and they are not variations on one
thing, so the dialog asks first and each method does only what is true of it.

| Method | Exchange |
| --- | --- |
| AWS Builder ID | the device flow above, on the public start URL |
| Your Organization | the same device flow, pointed at the company's own start URL |
| Google / GitHub | PKCE against `prod.us-east-1.auth.desktop.kiro.dev` |
| Import Token | a refresh grant: the pasted token is spent once, the access token is stored |
| API Key | stored as a bearer credential with no refresh token |

Two of these are worth spelling out.

**A company start URL is validated before it is sent anywhere.** Only `https` on
`*.awsapps.com` is accepted. That value becomes the `startUrl` of a device grant, so an
unvalidated one would turn the sign-in dialog into an open redirect carrying a user's
approval. When AWS rejects a well-formed one it says `Invalid start url provided`, and that
is passed through: a user who just typed their organisation's name needs to be told the
name is wrong, not that "it did not work".

**Social sign-in cannot return to this gateway.** The registered redirect is
`kiro://kiro.kiroAgent/authenticate-success` — a custom scheme, because the identity
provider whitelists only that one — so the browser hands the code to the Kiro desktop app
instead of returning here. The code has to be pasted back, and the dialog says so rather
than opening a tab that silently fails. The PKCE verifier stays in the gateway: the browser
only ever holds the challenge, so a pasted code cannot be exchanged without it. A code is
single-use, so the session is claimed before the exchange and released if the exchange
fails, leaving a mistyped code retryable without letting a spent one through twice.

An API key is stored as given, with no refresh token and no invented expiry. It cannot be
renewed, so that connection has to be replaced by hand — a property of the key, stated
rather than hidden.

### Availability is per account, and says so

Kiro answers `400 Invalid model. Please select a different model` for an id the signed-in
plan does not carry. That is an entitlement, not a broken connection, and it is reported as
such: the model name is in the message, so the row reads *"Your Kiro plan does not offer
claude-sonnet-5"* instead of a bare failure. Verified against a live account: the Claude
4.5/4.5-Haiku, DeepSeek, GLM, MiniMax and Qwen ids answer; the Sonnet 5 and GPT-5.6 tiers
do not on this plan.

The risk warning gates **all six** methods, not just the first — a method reached by
scrolling past a checkbox is still a method, and nothing is sent to Kiro or AWS until it is
acknowledged.

### Web Cookie providers, and what they are not

A **Web Cookie** provider is not an integration and not an auth method. There is no ChatGPT
endpoint that accepts a browser session, so the only way to reach a model this way is to
load `chatgpt.com` in a real browser, let its own page run the anti-automation challenges,
type the prompt into the composer, and read the answer out of the DOM.

The credential is therefore not a token scoped to inference. It is **a live session for a
whole OpenAI account** — the thing a `__Secure-next-auth.session-token` grants is everything
the person who exported it can do. That is a different class of secret from every other
credential here, and the card says so in a different colour from a terms flag:

```ts
riskNotice: 'OpenAI's terms do not permit automating chatgpt.com, and the credential here is
a live session for your whole account — not a token limited to inference. …',
riskSeverity: 'high',
```

`riskSeverity: 'high'` is what separates "this provider's terms forbid it" from "this
credential is your account". Rendering both identically would understate the second.

**Nothing is stored before the warning is acknowledged**, and the pasted blob is cleared on
failure. A whole-account session sitting in a textarea next to an error message is how one
ends up in a screenshot.

### The parts that are actually verifiable

The browser lives in the gateway, lazily imported, so the published package stays free of a
browser dependency. The SDK owns the parts that can be reasoned about without one, and those
are tested:

- **A pasted export is filtered, not trusted.** Only `chatgpt.com` and `openai.com` cookies
  survive. A blob that happens to carry a session for another site does not get forwarded
  to OpenAI, and neither does `notopenai.com` or `chatgpt.com.evil.example`.
- **A bare cookie array is accepted**, because that is what a cookie-editor extension
  exports and it is the format people actually have. Anything else says what to paste
  instead of a JSON syntax error.
- **Expired cookies are dropped.** A stale `__Secure-next-auth.session-token` fails like a
  wrong password, and telling somebody their paste was bad when it was merely old is worse
  than useless.
- **A signed-out page is told apart from a blocked one.** A browser with stale cookies still
  renders a page, and it renders it perfectly well; the only honest difference is a missing
  composer beside a sign-in link. Separately, a refused request renders a *different* real
  page, caught by its own wording — because "no composer" alone would send a user off to
  re-export a perfectly good session when the actual problem is the network.
- **The last assistant turn is the answer.** ChatGPT streams into the final node and leaves
  earlier turns on the page, so reading the first assistant element answers a message from
  several turns ago.

### The export format people actually have

A Playwright storage state is not what a ChatGPT account hands you. The real format is the
CLI/Codex auth export, and it shares **no keys** with a storage state:

```jsonc
{
  "accessToken": "<JWT>",
  "sessionToken": "<the __Secure-next-auth.session-token cookie value>",
  "expires": "2026-12-26T17:00:52.429Z",
  "authProvider": "openai",
  "account": { "planType": "free", "structure": "personal" }
}
```

There is no `cookies` key in it, so a parser written for the storage-state shape rejects a
genuine export with *"That JSON has no `cookies` array"* — which is exactly what happened
when a real one was pasted. Four shapes are now accepted: this export, a storage state, a
bare array of cookie objects, and a plain `Cookie` header.

Two fields are carried through, because both are worth more than the cookie alone:

- **`expires`** makes a dead session knowable *before* a browser is launched. Without it,
  every expired session costs a browser launch to discover.
- **`planType` decides the model catalog.** Which models an account is offered depends on
  its plan, and this is real entitlement rather than a guess. A free plan is not offered the
  paid model set, and a model outside the account's set is refused by name with the plan in
  the message. An unrecognised plan gets the **full** set: showing a model a paid account
  cannot use costs a visible failing test, while hiding one a free account can use hides
  something that works.

### A 5 KB cookie, and a 4096-byte browser

A session token is a compact JWE of roughly 5 KB. **Chrome caps a single cookie at 4096
bytes**, so setting one directly fails the entire `addCookies` batch with:

```
Protocol error (Storage.setCookies): Invalid cookie fields
```

Nothing in that message names the value, and every field is valid — the length is not. It
was found by varying one field at a time against a real session: a short value with the
identical fields is accepted.

NextAuth already solves this for the browser, splitting an oversized session cookie into
numbered chunks (`…session-token.0`, `…session-token.1`) that the page rejoins. The driver
writes them the same way, and a cookie that already fits is passed through unchanged. The
chunks reassemble to the original byte for byte, which is checked rather than assumed.

### The 403 was the user agent, not the network

An earlier version of this concluded the block was environmental — an address chatgpt.com
refuses — and told readers to try a residential connection. **That was wrong.** The address
was fine. Playwright's default user agent for a headless browser is the real Chrome string
with one substitution:

```
Mozilla/5.0 (X11; Linux x86_64) … HeadlessChrome/151.0.7922.34 Safari/537.36
                                            ^^^^^^^^^^^^^^^
```

That single substring is enough for the edge to answer **403 with a bot-protection
interstitial**, before any application code runs. Measured on one machine, one session, one
engine, varying a single thing at a time:

| | result |
| --- | --- |
| default UA | **403**, title `Just a moment...`, empty body |
| real Chrome UA | 200, composer present |
| real Chrome UA, headed | 200, composer present |
| real Chrome UA, full Chromium | 200, composer present |

The engine and the mode make no difference. Only the string did. The reference project
launches **headed with a real Chrome binary and `--disable-blink-features=AutomationControlled`**,
which points the same way — but in this case the UA alone was sufficient, and saying
otherwise would be overclaiming.

### Driving the composer

With the page reachable, three things are needed that are not obvious:

**A persistent profile.** ChatGPT shows a first-use "Temporary Chat" modal. With a
throwaway profile it is shown on *every* request, holding focus and intercepting the click on
Send, so a working flow times out. A real browser remembers; so does this one, via a profile
directory keyed on the connection. It is also the difference between a 20-second page load
per turn and an instant one.

**Real keystrokes, not `fill()`.** The composer is a ProseMirror editor. `page.fill()` sets
the DOM without the input events React listens for, so the send button stays
`aria-disabled="true"` and a click on it hangs forever. `pressSequentially` produces what a
person produces, which is what the button is watching for.

**A dismissed modal.** `data-testid="modal-temporary-chat-onboarding"` does not respond to
Escape. It is clicked through.

Waiting for the turn to end by waiting for the **stop button to disappear** is the obvious
signal and it is wrong: after a turn completes the button stays in the DOM, so that wait
never returns and a finished turn is reported as a timeout. Waiting for the answer text to
stop growing is what "finished" looks like on this page.

`waitForFunction` must also be given a **function, not a string** — a string is evaluated
with `eval`, and chatgpt.com's CSP forbids `unsafe-eval`, so a string fails with an EvalError
on a page that has otherwise worked perfectly.

### The model ids, which were invented — twice

The first catalog was `gpt-5.2`, `gpt-5.1`, `gpt-5-mini` and friends: tidy, plausible, and
**none of them real**. The ids the web tier serves are not tidy, which is exactly why the
tidy ones were so easy to invent.

The correction then got it wrong a second way. `resolveSelection` in the reference does not
map a model id to a model — it maps it to a **UI selection**, which is a model label and an
effort index, and it is that selection the page is driven with:

```ts
if (normalized === "gpt-5-6-luna-free")            return { kind: "free", thinkEnabled: false };
if (normalized === "gpt-5-6-luna-free-thinking")   return { kind: "free", thinkEnabled: true };
if (normalized === "gpt-5-6-pro")   return { kind: "picker", modelLabel: "GPT-5.6 Sol", effortIndex: 4 };
if (normalized === "gpt-5-6")       return { kind: "picker", modelLabel: "GPT-5.6 Sol", effortIndex: 0 };
if (normalized === "gpt-5-5-pro")   return { kind: "picker", modelLabel: "GPT-5.5",     effortIndex: 4 };
if (normalized === "gpt-5-5")       return { kind: "picker", modelLabel: "GPT-5.5",     effortIndex: 0 };
// …and anything else throws `received an unsupported model`
```

So the second mistake was publishing **`auto` as a model id**. `auto` is not a model a client
can ask for; it is the model string the *page* is given when the account is free and the
page has no picker to choose from. The user-facing ids are the `gpt-5-6` / `gpt-5-5` family
and the free pair:

| id | selection |
| --- | --- |
| `gpt-5.6-luna-free` | free, no thinking |
| `gpt-5.6-luna-free-thinking` | free, thinking |
| `gpt-5-6`, `gpt-5-6-instant` | GPT-5.6 Sol, effort 0 |
| `gpt-5-6-thinking`, `gpt-5-6-sol` | GPT-5.6 Sol, effort from the request |
| `gpt-5-6-pro` | GPT-5.6 Sol, effort 4 |
| `gpt-5-5`, `gpt-5-5-instant` | GPT-5.5, effort 0 |
| `gpt-5-5-thinking` | GPT-5.5, effort from the request |
| `gpt-5-5-pro` | GPT-5.5, effort 4 |

`normalizedModel` lowercases, strips a `chatgpt-web/` prefix and **folds every dot into a
hyphen**, so `gpt-5.6-luna-free` and `gpt-5-6-luna-free` are one model. Both spellings are
accepted, because refusing a twin for a full stop is refusing it for no reason.

Effort maps the way the reference maps it: `none`/`off`/`minimal`/`low` → 0, absent or
`medium` → 1, `high` → 2, `xhigh`/`max` → 3, and index 4 is the separate `-pro` id. The
reasoning flag is sent as a boolean, never as an effort-suffixed model.

**An id outside the set is refused locally**, before a browser is launched, because nothing
about it could ever resolve. A *known* id is **not** gated on the plan: `resolveSelection`
never consults one, and a plan field read out of an export is weaker evidence than what the
page actually serves. The plan only scopes which ids the dashboard offers.

### A catalog refresh could never remove anything

Two real bugs, found because the stale `gpt-5.2` ids survived a refresh that reported 200:

**`updateModels` unioned instead of replacing.** A rescan computed the correct list and then
unioned it with the existing one — and the additive path files every addition as a
**custom** model. So a model the provider has withdrawn is kept forever *and* becomes
impossible to remove, because by then it is indistinguishable from something the user typed
in. Refreshes now replace the discovered set; adding is still the default, because that is
what the "add model" control means.

**`LocalConnectionStore.updateModels` never persisted.** The in-memory store does not need
to; the persistent one did, and it already did — which is where the two implementations had
drifted apart.

### Driving the turn, which is not a composer

Typing into the composer **does not work**, and no amount of waiting changes that. The
request is accepted, a placeholder appears with `data-message-id="request-placeholder-…-0"`,
and the page sits at its "Think" indicator indefinitely. Everything about the surrounding
page is fine — signed in, plan known, composer accepts keystrokes, the send button enables,
the message posts. The composer path just is not how a programmatic client makes a turn.

What works is the path the page uses for **itself**: its Sentinel requirements, its
proof-of-work and Turnstile tokens, its request client, and `POST /f/conversation`. That
code lives in a hashed chunk under `/cdn/assets/`, its exports are minified, and both change
on every deployment — so it is found by scanning the page's own asset list for **semantic
markers** and reading the names out of the trailing `export{…}` block:

```
Kc(e=!1,t=`none`,n=Oz){return Oz(`finalized`,e,t,n)}   -> finalizeRequirements
Promise.all([ll.getEnforcementToken(t,{forceSync:!0}), …])  -> proofManager, turnstileManager
U8.safePost(`/sentinel/chat-requirements/prepare`, …)  -> requestClient
function Xc(e,t,n,r,i,a){…o[`OpenAI-Sentinel-Chat-Requirements-Token`]…}  -> buildSentinelHeaders
```

Verified against the live page: all four markers sit in one 2.6 MB chunk, and importing it
directly yields 4 074 exports. Nothing is pinned — the markers are behaviour, the names are
read, and when ChatGPT changes its minified output the failure **names itself** rather than
returning nothing.

Three things that had to be found rather than assumed:

**The asset is imported directly.** A generated blob module that re-exports from it fails
with a bare `Failed to fetch dynamically imported module` that says nothing about the cause,
while importing the asset itself works. So the five functions are lifted out of the module
namespace directly, and a missing one is named at install time instead of failing three
calls later as `undefined is not a function`.

**Only a first-party asset is ever read.** The candidate list comes off a live page, so it
is untrusted input: an origin or path outside `/cdn/assets/*.js` is refused before anything
is fetched.

**The delta stream is JSON Patch objects, and `append` concatenates.**

```json
{"p": "/message/content/parts/0", "o": "append", "v": "working"}
```

Reading `append` as a replace keeps only the final fragment; reading the value out of JSON
Patch's third slot writes `undefined` at every path and builds a document full of empty
containers — both of which read as a model that answered nothing. A message with no path is
a new turn, and `content_type` is not always `text`: a `reasoning_recap` is not the answer.

### Health, and two ways it was silently wrong

`GET /health` probes **every** provider, so it takes seconds to tens of seconds, and two
providers were being probed by the wrong adapter without anyone noticing:

**`deepseek-web` was never registered in `activeAdapters()`.** `chatgpt-web` has an entry;
`deepseek-web` did not, so its connection fell through to a generic OpenAI-compatible adapter
pointed at `chat.deepseek.com` — which is not an OpenAI endpoint. Health reported
`unavailable` with an **empty message**, and the dashboard's "Test provider" said *"DeepSeek
Web is not connected to the local gateway"* on a connection that answered in under eight
seconds. Routing was unaffected, because `resolveAdapter` was already correct — which is what
made it so confusing: the provider worked while reporting that it did not.

**`DeepSeekWebAdapter` had no `healthCheck` at all.** Once registered it reported *"Health
checks are not supported."* It now has one, and it is a **credential check** — `users/current`,
one round trip, no proof of work, no session — which is what makes it cheap enough to run on
every poll rather than being a second completion.

Both are the same shape of bug: a missing registration is silent, and the symptom
("not connected") points at the credential rather than at the wiring.

### Health for one provider: `GET /v1/health/:providerId`

`GET /health` probes **every** active adapter, which is right for a status page and wrong for a
provider card. "Test provider" was calling it to answer a question about one provider, so it
waited for thirteen probes first — long enough on a loaded machine that the button looked
permanently stuck. One route, one provider:

```
GET /v1/health/deepseek-web
200 {"provider":{"providerId":"deepseek-web","status":"healthy","latencyMs":816, ...}}
```

**A provider with no active connection is `NOT_FOUND` and names itself**, rather than
reporting `unavailable`. "This provider is down" and "you never connected it" are different
problems, and the first sends the user to fix a credential that was never the issue.

**The DeepSeek health check bypasses the access-token cache.** `accessToken()` caches for an
hour, which is right for the request path and wrong for a check: the dashboard reported
*"healthy in 0 ms"* from a cache entry, which looks like a successful check because something
was returned. It now asks DeepSeek, and reports the real round trip — 478–823 ms.

### A read that stalls is not evidence of anything

`loadConnection` had `.catch(() => undefined)` and no timeout. When the request hung — sixty
seconds, on this machine — the page kept its initial `false` and asserted **"Not connected"**
about a connection that existed, next to an **Add connection** button inviting a second one.

The detail page now has three states, because the difference is the whole point:

| State | Badge | Connections |
| --- | --- | --- |
| loading | Checking… | — |
| ready, none found | Not connected | 0 |
| ready, found | Connected | 1 active |
| failed | Couldn't read the gateway | — |

### `/health` no longer re-probes on every request

`GET /health` used to call `refreshHealth()` per request, on top of a 60-second background
sweep. It was slow — **8.45 s**, thirteen real requests to thirteen providers' APIs. The part
that actually broke a feature was subtler:

> The browser allows six connections per origin. The page asks for health on load, and a sweep
> that outlives the poll interval queues the next one behind it — so health requests monopolise
> the pool and **ordinary requests to the same gateway queue behind them**. A chat turn that
> answers in six seconds took over a minute, which is indistinguishable from a model that hangs.

`health()` now returns the last sweep and stores it; concurrent callers **share** one sweep
rather than each starting their own. Four consecutive calls: 2.9 s cold, then 3 ms, 15 ms, 4 ms.
`checkedAt` is reported so the age of the report is visible rather than implied.

### Talking to a model: the provider playground

Every provider page ends with a conversation against one of its own models.

**Everything else on the page reports *about* a provider** — a badge, a latency, a model count.
"Test provider" sends `hi` and shows a green tick, which proves the credential works and nothing
about whether the model is usable. This is the surface that answers the question actually being
asked.

**It streams, and it can be stopped.** A chat that shows nothing for eight seconds and then
prints the whole answer is not a chat, and here the wait *is* the observation — it is the
clearest signal of which model is fast.

**Not every provider can stream.** DeepSeek Web declares `streaming: false`, and the gateway
answers a streamed request `501 NOT_SUPPORTED`:

```json
{"error":{"code":"NOT_SUPPORTED","message":"DeepSeek Web does not support streaming. …"}}
```

The client retries the same turn as one request and reports `streamed: false`, so the answer
still appears and the turn is labelled **"no streaming"**. A provider that cannot stream is not a
provider that cannot answer; showing the refusal would have been wrong.

**A failed turn is dropped from the replayed history**, not sent back as an assistant message.
Replaying a refusal as though the model had said it is a subtle way to corrupt every later turn.

**It is not offered when it cannot work.** No connection, or a provider the gateway cannot serve,
gets a sentence saying why instead of a control that can only fail.

### Logo tiles follow the logo, and the index is generated

`ProviderMark` used to hard-code `backgroundColor: logo ? '#ffffff' : …`. Any light mark was
therefore **a white glyph on a white tile**:

- `chatgpt.svg` is `fill="#fff"`
- `qwen.svg` is `fill="#ffff"` — a four-digit hex, i.e. white at full alpha, which a `#rgb` check
  misses entirely

It was never only those two. **151 of the 157 bundled assets are light** — including `anthropic`,
`openai`, `gemini`, `google`, `openrouter` and `kiro` — and **63 are dark**. One tile colour
satisfies one group and hides the other, in whichever theme it did not match. The rule is now the
simple one: **the tile is the opposite of the mark**, which is theme-independent.

The classification is **generated from the asset files by a Vite plugin**, not hand-written:

```
buildStart → read public/providers/*.svg and *.png → src/lib/logoPolarity.generated.ts
```

A hand-written list goes stale the moment a logo is added, and a stale entry fails *silently* —
an invisible logo rather than an error. There is no app test runner to catch that, so the assets
are the input, and both `pnpm dev` and `pnpm build` keep the module true.

**SVGs and PNGs need different rules**, and the difference is the point:

| Format | Rule | Why |
| --- | --- | --- |
| SVG | any fill > 0.72 → dark tile; else any fill < 0.15 → light tile | fills are sparse, so an average hides the part that matters |
| PNG | average > 0.45 → dark tile; else average < 0.25 → light tile | pixels fill the box, so extremes mislead |

`tokenharbor.svg` is a single `#16190e`-scale path — one `#16191e` fill — that averages to a
harmless mid-tone while being invisible on a dark card. `openai.png` is a black knot on a white
field whose brightest pixel is always `1`, so only the average says it belongs on a dark tile.

### Provider cards: the grid follows the container, not the viewport

The card grid is `repeat(auto-fit, minmax(272px, 1fr))` — compact cards — and
`minmax(320px, 1fr)` for the advanced view. **Not** `sm:`/`md:`/`xl:` column counts, because the
dashboard has a sidebar that is 252 px from `lg` up and off-canvas below it:

> The same viewport width yields a content area 252 px narrower on one side of that breakpoint
> than the other, and collapsing the sidebar changes it again. Any fixed column count is
> therefore wrong somewhere.

Measured column counts by content width: 360→1, 480→1, 640→2, 760→2, 900→3, 1024→3, 1200→4,
1440→5, 1920→6. A card is never rendered narrower than it can show its name and status.

Three separate clipping faults lived inside the cards, none of them about the grid:

- **The name shared a row with the caution badge** — badge `shrink-0`, name `truncate` — so a
  badge reading "Account session" took the space and "ChatGPT Web" got 93 px of text in 82. The
  badge now sits on the status line, where it reads better anyway.
- **A planned provider's reason sat in a hard `max-w-[11rem]` box**: 905 px of sentence in 176 px,
  so the first fragment and nothing else. It has its own full-width row now, clamped to two
  lines, with the whole reason still on `title`.
- **The advanced card's Models stat is a composite string** — `77 models · all import` — needing
  158 px in a 121 px cell, so it ellipsised to `77 models · all i…`, which reads as a rendering
  fault rather than as a number. It wraps.

### DeepSeek Web: the answer is mostly bare strings

The stream shape is not what it looks like, and getting it wrong is invisible. A real reply to
"Count from 1 to 5" arrives as:

```text
data: {"v":{"response":{"thinking_enabled":false,"fragments":[{"type":"RESPONSE","content":"1"}]}}}
data: {"p":"response/fragments/-1/content","o":"APPEND","v":","}
data: {"v":" "}
data: {"v":"2"}
data: {"v":","}
data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":60}]}
data: {"p":"response/status","o":"SET","v":"FINISHED"}
```

**Only the first line is a fragment object.** The path is the *indexed* form, not
`response/fragments`. The rest of the answer is frames whose value is a bare string, most with
**no path at all**. A decoder that recognises only fragment objects keeps the opening character
and drops everything after it — so **"Count from 1 to 10" returned `1`**, with
`finish_reason: stop`, and every answer looked like a terse model that happened to work.

This survived because the one-token test it was written against asked for a one-token answer.
A probe that proves only what it was built to prove passes happily while the feature is broken.

Two consequences, both from the captured body rather than from reasoning:

- **`FINISHED` is a status word with a string value.** Appending every string value writes the
  literal word `FINISHED` onto the end of the answer. It is consumed as status.
- **A body that closes without `response/status: "FINISHED"` was cut off mid-generation** — an
  expired session, a dropped connection. It is now refused by name rather than returned as a
  fragment wearing `finish_reason: stop`.

Only the third row makes a claim about the credential, and only after reading it. The read has
a **10 second ceiling** — generous for an endpoint that answers in single-digit milliseconds,
and there so that a stall resolves into a *failure the user can see* rather than a wrong answer
they cannot.

### The catalog: 13 cards, and why the plan does not narrow them

Five Sol rungs, two Luna free, six for GPT-5.5:

```
gpt-5.6-luna-free            GPT-5.6 Luna (Free)           auto, no thinking
gpt-5.6-luna-free-thinking   GPT-5.6 Luna (Free, Think)    auto, thinking
gpt-5.6-sol-instant          GPT-5.6 Sol (Instant)         gpt-5-6
gpt-5.6-sol-medium           GPT-5.6 Sol (Medium)          gpt-5-6  + thinking
gpt-5.6-sol-high             GPT-5.6 Sol (High)            gpt-5-6  + thinking
gpt-5.6-sol-xhigh           GPT-5.6 Sol (XHigh)           gpt-5-6  + thinking
gpt-5.6-sol-pro              GPT-5.6 Sol (Pro)             gpt-5-6-pro
gpt-5.5-instant              GPT-5.5 (Instant)             gpt-5-5
gpt-5.5-medium               GPT-5.5 (Medium)              gpt-5-5  + thinking
gpt-5.5-high                 GPT-5.5 (High)                gpt-5-5  + thinking
gpt-5.5-xhigh               GPT-5.5 (XHigh)               gpt-5-5  + thinking
gpt-5.5-pro                  GPT-5.5 (Pro)                 gpt-5-5-pro
gpt-5.5-pro-extended         GPT-5.5 (Pro Extended)        gpt-5-5-pro
```

**The cards and the resolver are one table.** The reference's own provider page advertises
effort-suffixed ids that its `resolveSelection` then refuses, so a client that copies one out
of the UI gets `unsupported model`. Deriving both from `CHATGPT_WEB_MODELS` makes that
unreachable, and a test asserts it.

**The effort ladder collapses to one boolean.** `reason` is a system hint, and ChatGPT picks
the effort itself once it is set — so `medium`, `high` and `xhigh` are distinct *cards* and one
*request*. `pro` is different: it is a different model string, and the reference deliberately
withholds the thinking hint for it. `chatGptWebDirectModel` owns that rule in the SDK, because
deriving `reason` as `effortIndex > 0` at a call site sends a hint the page does not honour.

**`gpt-5.5-pro-extended` is an alias of `pro`, not a distinct request.** ChatGPT exposes no
separate wire model for it, and inventing one would produce a model id the page rejects. It is
kept so a client that sends it is answered rather than refused.

**The plan does not narrow the list.** A free account is offered all 13. `resolveChatGptWebSelection`
never consults the plan either — it maps an id onto a selection and lets the page refuse,
because a `planType` read out of an export is weaker evidence than what the page serves. Gating
the catalog on it was a second, different rule, and the wrong one: a wrong gate is not
symmetric. Showing a model the account cannot use costs one visible test failure that names
itself; hiding a model it *can* use hides something that works, with no way to tell that apart
from "not supported". The plan is still **reported** — the connect dialog shows it.

### DeepSeek Web

The second web-session provider, and the one that shows what the shape is *for*.

**No browser is in the request path.** chat.deepseek.com is an HTTP API behind a session
token, so a turn is a `fetch` with a bearer credential — the same shape as any other HTTP
provider. A browser is involved only in *getting* the credential, and only once.

```
POST /api/v0/users/current            userToken  ->  data.biz_data.token   (an accessToken, ~1h)
POST /api/v0/chat/create_pow_challenge { target_path }  ->  a challenge
POST /api/v0/chat_session/create                              ->  a chat session
POST /api/v0/chat/completion         X-Ds-Pow-Response: <base64 proof>
```

Three things are load-bearing and none is obvious:

**The token is exchanged, not used.** `userToken` authorises `users/current` and nothing else.
Sending it at the completion endpoint gets a 401 that looks exactly like an expired session.
The access token is cached for an hour with a minute of slack, so a turn does not spend two
round trips before it sends anything.

**Every completion is gated by a proof of work.** `DeepSeekHashV1` is SHA3-256's sponge at
**23** Keccak rounds instead of 24, which is why `node:crypto` cannot do it. The nonce is found
by scanning `<salt>_<expireAt>_<nonce>` for a full 32-byte digest match, bounded at 250 000, and
returned base64 in `X-Ds-Pow-Response`. A challenge is taken per completion, not cached: the
answer is bound to the target path and carries its own expiry.

**The endpoint takes one flat `prompt`, not messages.** History is flattened with the turns
labelled, because a bare join of `["You are terse.", "2+2?"]` loses which was which and the
instruction is the part that gets lost.

The SSE answer arrives in two frame shapes and both are read:

```json
{"v":{"response":{"thinking_enabled":true,"fragments":[{"type":"THINK","content":"…"}]}}}
{"p":"response/fragments","o":"append","v":[{"type":"ANSWER","content":"working"}]}
```

The append frames often arrive with **no `type`**, addressed relative to the current message —
so `thinking_enabled` from the last whole response decides which side of the split a bare
fragment belongs to. Treating every append as the answer is how a model that thinks first ends
up answering with its reasoning.

**The credential is `userToken` in localStorage, not a cookie.** `context.cookies()` returns
nothing useful and the connection looks signed out forever. DeepSeek stores it sometimes as
`{"value":"…"}` and sometimes bare, so both are read.

**`{"value":null}` is the signed-out placeholder, and it is refused by name.** Probed against
the live site: that is exactly what the page stores when nobody is signed in, and falling
through to "treat the raw string as the token" turned it into a credential that looked valid,
was accepted, and surfaced much later as DeepSeek refusing a session nobody could explain. The
decision is on the **presence of the `value` key**, not its emptiness — `{"other":"x"}` is some
other object pasted by mistake and is used as-is, while `{"value":null}` is the signed-out state
and is named:

> That userToken is empty, which is what chat.deepseek.com stores when you are not signed in.
> Open chat.deepseek.com, sign in, and copy it again.

Extraction is a **console one-liner** rather than a DevTools navigation, because the navigation
is where people go wrong — a mis-click yields a cookie object or the signed-out placeholder, and
neither is obvious at the point of failure:

```
ChatGPT Web   copy(document.cookie)
DeepSeek Web  copy(JSON.parse(localStorage.userToken).value)
```

The request headers are DeepSeek's own web-client fingerprint, and the header *set* is itself
a bot-detection signal: the 2.0.0 build dropped `X-App-Version` and added
`X-Client-Bundle-Id`, so sending the stale stamp is itself suspicious. `x-hif-leim`, a signed
client-attestation token from obfuscated JS, is deliberately omitted — reproducing it means
porting that JS, and the endpoint does not currently require it. If it ever does, requests will
fail with a 401 that says nothing about attestation, which is when to come back to it.

### The gateway badge, and recovering from an outage

The sidebar badge used to be the literal string **"Gateway online"**. It asserted rather than
asked, so during an outage the dashboard reported the one thing that was false — and looked
correct afterwards, so there was no reason to distrust it.

A page that failed its only request made **no further requests**, so nothing could notice the
gateway coming back. The offline message was the last thing the tab ever said, and the only way
out was a manual reload — the wrong instinct when the fix is "nothing, it already recovered".
This is what made the same complaint appear four times.

Both are fixed by polling `/v1/connections` every four seconds. It answers in about five
milliseconds, so the poll is free, and it is the only way a page that has already failed can
learn it stopped failing. Verified end to end: with the gateway stopped the badge read
`Gateway offline` / `not answering · pnpm dev:gateway`, and with it restarted — **no reload** —
it read `Gateway online` again.

### Getting the credential: one button, in your own browser

There is one control, and it opens the provider in a **new tab in the current browser**. Sign in
there, copy the one value, paste it.

There used to be a second path: OmniHilbras launching its own Chromium and reading the session
out of that. It opened a window on the desktop that the user could not tell from an unrelated
browser, and it was **broken** — the window showed the provider's home page and the flow never
detected the sign-in, so it sat there indefinitely. Two buttons, one of them broken and
unexplained, is worse than the paste path alone.

So the window flow is **removed rather than demoted**: both sign-in modules, both session
stores, four service methods, four routes and thirteen tests are gone. The persistent profile
is still used for *turns* when it happens to be signed in; it is simply no longer how a
connection is made.

```
POST /v1/web-cookie/chatgpt/connect    { storageState }        -> 201
POST /v1/web-cookie/deepseek/connect   { userToken }           -> 201
POST /v1/web-cookie/chatgpt/check      { storageState }        -> 200
POST /v1/web-cookie/tokenharbor/check  { cookieHeader }        -> 200
POST /v1/web-cookie/tokenharbor/connect { cookieHeader, freeOnly } -> 201
```

### Token Harbor Web — a session cookie over a gateway whose terms forbid it

Token Harbor is itself a gateway, and its terms prohibit constructing a proxy over it. This is
one: `/api/direct-chat/stream` is the web chat's own request path, driven with a Supabase session
cookie rather than an API key. The supported path is the `tokenharbor` API-key card
(`https://tokenharbor.ai/v1`, OpenAI-compatible, free on the `:free` models); this card exists
because the operator asked for the session route with that trade stated, and it carries
`riskSeverity: 'high'` so a user meets the warning before pasting a credential.

The cookie is Supabase's, on the `auth` host: `sb-<ref>-auth-token`, chunked `.0`/`.1` when large.

**The wire format is not OpenAI's**, which is the whole adapter:

```
POST /api/direct-chat/sessions  { model, temporary }        -> { session: { id } }
POST /api/direct-chat/stream    { sessionId, content, model, webSearch, tz }
   -> SSE named events: chunk { delta } | thinking { delta } | done | error { code, message }
```

`temporary: true` keeps a gateway request out of the user's sidebar; `chunk` is the answer and
`thinking` is the reasoning, split by event name so a thinking model is not read as answering
with its reasoning. `done` is what makes a truncated body detectable — a stream that closes
without it is reported, not handed back as a half answer labelled complete. Attachment events
(`image`, `file`, `citation`, `tool_use`) are ignored rather than guessed into the answer.

**No live turn is asserted here.** The turn needs a signed-in session this repository has no
credential for, so it is verified by using it; what is asserted offline is the cookie parser
(chunk reunion in numeric order, sibling cookies preserved), the decoder (reasoning split from
the answer, `done` required, `error` codes), and the route. Health is a `credential` check — it
reads `/api/me/profile` and says so rather than claiming `inference`.

**The trade-off, stated plainly.** A pasted credential is replayed into the gateway's browser
on each turn, rather than that browser keeping a fresh session of its own. The Cloudflare
clearance therefore can go stale, and an edge challenge is somewhat more likely than with a
profile that stays signed in. That is the cost of "do not open a window I did not ask for", and
it is the right trade.

### A refusal is not an outage

The gateway answers **`403 CORS_ORIGIN_DENIED`** when a request carries an `Origin` that is not
on its allowlist (`http://localhost:5173` and `http://127.0.0.1:5173` are). The browser cannot
read that response, so from the dashboard it is indistinguishable from a dead server — and the
badge said `Gateway offline`, which points the user at restarting a server that is running
perfectly and refusing correctly.

This was the actual cause behind four separate "restart the servers" requests. The trigger was
a stray `vite preview` left running on `:4173` by an earlier verification attempt; a `pkill`
whose pattern did not match missed it.

So the two are now distinct states with distinct wording:

| state | badge | hint |
| --- | --- | --- |
| up | `Gateway online` | `localhost:8787 · local mode` |
| nothing answered | `Gateway offline` | `not answering · pnpm dev:gateway` |
| answered, refused this origin | `Gateway refused this page` | `this page's origin is not allowed` |

One trap worth recording: the poll must use the **absolute** gateway base. A relative
`/v1/connections` reaches Vite, which answers `200` with the app's own HTML — so the badge
would have reported the gateway as up for exactly as long as it was down.

### `/health` is 24 seconds, and it was blocking the list

`GET /health` probes **every** provider, so it takes around 24 seconds. `ProvidersPage` awaited
it *before* setting the connections, so the provider list sat empty for 24 seconds on every
load — even though `/v1/connections` answers in five milliseconds and is what the page is
actually about. Connections are now set first and the health pass refines them when it lands.

This is a real cost that remains: the health pass itself is still a full probe of every
provider on every call. Caching it, or separating "is the process up" from "how is each
provider doing", is the honest fix and has not been done.

### Where a Connect click goes, and why it is not the API-key modal

`AddProviderModal` collects an **API key**, and `resolveProviderOption` falls through to
`providerCatalog` for any id it does not recognise. So a web-session provider — which is
signed into, and has no API key — resolved to a catalog entry and opened an API-key dialog
asking for a credential it does not use. The dialog that knows how to sign in
(`WebCookieConnectDialog`) only ever rendered on the provider's **detail** page; the list had
no idea it existed.

Two levels, because one is not enough:

- the list's Connect **navigates to the provider's page** for a web-session provider
- `openAdd` **refuses** one, so no future caller can repeat it by accident

`isWebSessionProvider` is exported from the modal so the check is available rather than
re-derived at each call site.

### The Console cannot supply the ChatGPT credential, at all

NextAuth sets `__Secure-next-auth.session-token` `HttpOnly`, and `document.cookie` cannot read an
HttpOnly cookie. A console one-liner is therefore not a slower route — **it is a route that does
not exist.** It was offered here as the *fastest* path, and it was the only path offered.

What made it worse than not working is the shape of the failure. The header it returns is a
plausible set of chatgpt cookies with no session token, which reads exactly like being signed
out — so it sent a **signed-in** user off to sign in again. `__Secure-next-auth.callback-url` is
not HttpOnly, so a signed-in browser still leaks part of the family, and that is the
discriminator:

| The pasted header contains | What happened | What to do |
| --- | --- | --- |
| any other `__Secure-next-auth.*` | signed in, copied from the Console | the cookie is HttpOnly — use the **Network** tab |
| no `__Secure-next-auth.*` at all | not signed in | sign in, then use the **Network** tab |

The sibling has to be detected from the **raw** cookie names: the allowlist drops `callback-url`
on the way in, so by the time the check runs there is no trace of it.

The two routes that do work are **Network → Headers → Request Headers → Cookie** (copy the whole
line) and **Application → Storage → Cookies**. The whole line matters: a token over the size
limit is split into numbered chunks, and a header copied without its siblings is a broken session
that fails later as an unexplained refusal.

### Qwen Web: refusals arrive in the body, on both origins

Qwen's shape is unusual enough to be worth stating plainly, because **every refusal is HTTP 200**:

```
GET  https://auth.qwen.ai/api/v2/auths/            → 200
     {"success":false,"data":{"code":"Unauthorized","details":"401 Unauthorized"}}

POST https://chat.qwen.ai/api/v2/chat/completions  → 200
     {"ret":["FAIL_SYS_USER_VALIDATE","RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试"],
      "data":{"url":"…/_____tmd_____/punish?x5secdata=…"}}
```

A client that checks the status code sees a working provider on both. The first version of the
probe did exactly that and reported a guest cookie as `authenticated: true`; the live run is what
caught it. Refusals are read out of the body with `readRefusal`, and never inferred from a status.

Two origins, because **Qwen's auth is not on its chat host**. A guest holds no auth cookie on any
host, which is why there is nothing for an unauthenticated client to present.

**The challenge is not a clearance flow.** Requesting that `_____tmd_____/punish` URL returns 200,
renders "Please connect them in order", **sets no cookie**, and the retry is refused with a freshly
minted challenge. It is a human puzzle, so no client can satisfy it. `GET /api/v1/chat/completions`
is 404 — v2 is the only turn path. And asking the turn from inside the page **kills the renderer**,
because the failing body never ends; a probe has to run from Node with a byte cap, which is why
`readCapped` exists.

### The catalog is read, not remembered — and it moves

`GET /api/v2/models/` answers guests. Two overclaims had to be undone to get here.

**First:** ten plausible ids were written from memory — `qwen3.7-flash`, `qwen3.7-coder-plus`,
`qwen3.7-vl-plus` and so on — and the probe caught it. Guessing a catalog is the same fault as
guessing a capability: the card would have advertised models that do not exist and offered turns
guaranteed to fail, with nothing on the page to say why.

**Second:** replacing those with a flat *"it answers three"* was also wrong. Someone running the
probe minutes later saw **seven**:

```
qwen3.7-plus  qwen3.8-max  qwen3.8-omni-flash  qwen3.7-max
qwen3.6-plus  qwen3.5-plus  qwen3.5-omni-plus
```

while repeated requests from here returned the same **three** every time. Cookies were ruled out —
none, `cna`, `isg`, and a pasted `cna`+`isg` pair all agreed — and the gateway probe agreed with
the direct request. So the guest catalog **varies**, and a constant is wrong by construction: it
will disagree with the provider on some day, and a card listing models the endpoint no longer
serves is worse than one that admits the list moves.

Consequences, both deliberate:

- `QWEN_WEB_MODELS` is a **dated snapshot** for the card, with `QWEN_WEB_MODELS_OBSERVED_AT`.
- **The dialog is the authority** — it always shows the live list the probe read.

Qwen publishes no context length on that endpoint, so none is claimed.

### Qwen is `available`, not `planned`

`planned` meant "there is nothing behind this button", and the page disables it. That was right
while the only thing Qwen could be asked was a guess. There is a flow behind it now — a **probe**,
`POST /v1/web-cookie/qwen/check` — that asks three questions and reports the answers:

| Question | Route | Why it matters |
| --- | --- | --- |
| Does the credential mean anything? | `auth.qwen.ai/api/v2/auths/` | a guest is refused here first, so it separates "no credential" from "the gate is the problem" |
| What models are served? | `chat.qwen.ai/api/v2/models/` | readable by guests, so the catalog is real even when a turn is not |
| **Is a turn actually served?** | `chat.qwen.ai/api/v2/chat/completions` | the one question that decides whether this is a provider |

### The probe has a budget, and asks its three questions at once

The dialog did work, and read as broken — which is the same outcome as broken. The probe answers in
about a second; the problem was that "Ask Qwen" then said nothing at all, so a wait looked
identical to a dead button. Measured rather than assumed: the gateway answers in 0.7–1.8 s by
`curl` and the browser's own fetch took 1.2–1.5 s, so the network was never the bottleneck.

Three changes, none of which depend on the diagnosis being right:

- **A 20-second budget.** A stall becomes an answer instead of an indefinite spinner, and the
  answers gathered so far are *returned rather than discarded* — a slow auth origin with a fast
  refusal on the turn is still a useful answer, and throwing it away would be its own dishonesty.
- **The three questions go out together.** They were sequential: three round trips to a host on
  another continent for no reason. The auth origin and the model catalog are independent, and only
  the turn waits — it names a model id from the catalog, so a hard-coded id would go stale the day
  Qwen renames one and the request would fail for a reason unrelated to the credential.
- **The waiting state says what is being asked and how long it may take**, which is what turns a
  spinner into progress.

A disabled primary button is named too — *"Paste the credential above first."* — because a silently
greyed button reads as a broken feature, and the thing it wants is one field described two steps
above it.

**Nothing is saved.** There is no connect route for Qwen, and the dialog hides Connect because
there is nothing to save — a connection is only worth having once a turn is really served.

**What remains unknown, and cannot be resolved without a signed-in account: does the TMD gate
apply to an authenticated request?** That is exactly the one DeepSeek's `userToken` unblocked, and
it is why this is a probe rather than a verdict. If the answer is no, this becomes a working
provider; if yes, it stays a catalog entry. Either way nobody takes a guess on trust.

### What was found on the way

The catalog is open and the turn is not:

```
GET  chat.qwen.ai/api/v2/models/      200, three models, 1,000,000 ctx each
POST chat.qwen.ai/api/v2/chat/completions   -> 200, with this body:

{"ret":["FAIL_SYS_USER_VALIDATE","RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试"],
 "data":{"url":".../_____tmd_____/punish?...&action=captchaconnect",
         "dialogSize":{"width":"375px","height":"665px"}}}
```

That is Alibaba's TMD anti-bot, and it returns a captcha that has to be **rendered in a
browser**. A guest session has no XSRF cookie at all, so the `X-XSRF-TOKEN` header the bundle
sends is not even obtainable without an account. The models endpoint is free and easy; the turn
needs a solved captcha per challenge — a harder version of the problem ChatGPT Web already
turned out to be, with no reference implementation anywhere to lean on. So there is a catalog
and no card, and the honest state is "known, not built".

Two findings kept from that probe: the endpoint is a plain `POST /api/v2/chat/completions` with
`X-XSRF-TOKEN` / `X-Request-Id` / `x-request-origin` and no obfuscation, and calling it from
inside the page kills the renderer — which is what buffering an endless SSE stream with
`response.text()` does. Both are why a Qwen driver must read its body incrementally with a cap.

### One dialog, driven by a descriptor

The connect dialog is not a ChatGPT dialog with the names swapped. Each provider supplies its
own credential name, extraction steps, sign-in note, routes and paste placeholder, in
`src/lib/webSessionProviders.ts`.

That is not tidiness for its own sake. The ChatGPT guide once told people to paste a Cookie
header the parser refused, because the instruction and the parser were written in different
places. And the generalised dialog still shipped a hardcoded ChatGPT sentence that told
DeepSeek users a chatgpt.com window was about to open — caught by looking at the rendered
dialog rather than the code. Anything provider-specific belongs to the provider.

### Signing in, which is how you get the session

```
POST /v1/oauth/chatgpt/start                    ->  { sessionId, headed }
GET  /v1/oauth/chatgpt/status?sessionId=&freeOnly=
     -> { status: "pending" }
     -> { status: "denied",  error }
     -> { status: "connected", connection, plan }
```

A window opens on **the machine running the gateway** — not inside the dashboard, because a
dashboard on a different machine cannot put a browser on your desktop. `headed` comes back
with the id so the dialog can say so: with no display there is nowhere to type a password, and
the flow points at the paste path rather than waiting for a sign-in nobody can perform.

The session is read out of the browser that created it, so the Cloudflare clearance the edge
set is the one that gets kept — a copied cookie tends to lose it. The paste path stays as the
fallback, and is unchanged.

**The profile is the fast path; the vault is the fallback.** Signing in writes the session into
the persistent profile, so a turn afterwards finds the browser already signed in and injects
nothing. Injecting anyway would overwrite a *fresher* session with a stored one — the
clearance rotates — and replacing a working session with a stale copy is how a working
provider starts failing for no visible reason. So the stored cookies are set only when the
profile turns out not to be signed in, which is also the state the paste flow always lands in.

**A poll is claimed before the page is read.** Two polls arriving together must not both see a
signed-in page and save two connections from one sign-in. `pending` releases the claim so the
next poll can look again; `connected` and `denied` discard the session and close the window.

**Sessions are swept.** A leaked window is a signed-in session left open on someone's desktop,
so one nobody came back for is closed when the next one starts and again at the TTL.

**The terms position is unchanged.** Signing in as yourself does not make automating
chatgpt.com any more permitted than pasting its cookie was. The warning stands.

### Getting the session in, and checking it

The dialog's guide names the cookie, gives both extraction routes, and says to check before
saving:

```
POST /v1/web-cookie/chatgpt/check     { storageState }   ->  { planType, isFreePlan, verified, models }
POST /v1/web-cookie/chatgpt/connect   { storageState, freeOnly }  ->  201 { connection }
```

**The parser accepts the Cookie header**, because the guide tells you to paste one. It did not
before: the error message said "paste the cookie header instead" and then refused one, so the
instruction and the parser disagreed and the only way to find out which was wrong was to paste
a real session and be turned away. A header is split on `;`, allowlisted to ChatGPT's own
cookies (`cf_clearance`, `__cf_bm` and `_cfuvid` included — the edge sets those, and a session
sent without them can be challenged even when the token is valid), and the session token is
**reassembled from its numbered chunks**, which is how a browser splits a long one.

A **cut-short chunk set is refused**, and the check says so. A partial token is not a shorter
session, it is a broken one, and sending it reads as an opaque 401. A lone `.0` is the harder
case: it looks complete on its own, but a browser only splits a token over its size limit, so
one chunk means the header was truncated.

**The check opens the page.** Expiry, cookie presence and browser availability are all local
checks, and none of them can tell a working session from one revoked from another device — so
a check that only parsed would be a button labelled "Check cookie" that accepts a dead
session. It costs one page load, which the connect immediately does again.

Measured against a real session and a deliberately invalid one, **every DOM marker is
identical** — both render two textareas, no profile button, no sign-in link, the same form, the
same URL. A selector picked from either page passes the other. The one difference is the page
text, which carries the plan on a signed-in account and not on a signed-out one, so that is
what is read, polled for 15s because the badge arrives with the account data rather than in
the first paint. A page without it is reported as unconfirmed, not guessed at.

**Every driver failure carries a cause.** A challenge is `PROVIDER_UNAVAILABLE` and a sign-in
wall is `AUTHENTICATION_FAILED`, because the fixes differ — one is the network, one is the
credential. Thrown as bare `Error`s they both arrived as `INTERNAL_ERROR` and "The gateway
encountered an unexpected error", which hides the one thing the user needs to know.

**`freeOnly` is recorded on the connection, and carried through discovery.** A toggle that
lives only in the dialog is a switch that does nothing for anyone connecting over the API.
Gating the refresh on `policy === 'all'` was worse than useless: it made a free-only connection
*unrefreshable*, so the toggle could create a connection that broke the next time anybody asked
the provider what it serves.

### Verified end to end

```
POST /v1/chat/completions  x-omnihilbras-provider: chatgpt-web
  {"model":"gpt-5.6-luna-free","messages":[{"role":"user","content":"Reply with the single word: working"}]}

-> 200  provider: chatgpt-web  model: gpt-5.6-luna-free  finish_reason: stop
   content: "working"          20s, 24s, 37s across three consecutive runs
-> 200  content: "4"           for "What is 2+2? Answer with the number only."
```

**It is not perfectly reliable.** A fetch that ChatGPT's own code makes — its Sentinel or
Turnstile solve — can fail on the network, arriving as `Failed to fetch`, which is
indistinguishable to the caller from a real refusal and is not one. That gets exactly one
retry; anything else is raised as a real failure, so a broken session is never retried into
looking intermittent. Two navigation retries for the same reason.

Attachments are **not** implemented. A text-only turn is the whole of what this does, and
saying so beats a partial upload path.

### Catalog cards added for OpenAI-compatible gateways

A new provider is a catalog card plus, separately, an entry in the add-provider dropdown.
Those are two lists and the duplication is structural; the resolver added in v0.9.6 makes
the *card* authoritative, so a card added on its own still resolves to itself. The dropdown
still reads its own list, so a provider meant to be addable from the providers page needs
an entry in both.

The endpoint is checked before the card is written, not after:

| Card | Base | Probe | Answer |
| --- | --- | --- | --- |
| NaraRouter | `https://router.bynara.id/v1` | `GET /v1/models` | `401 A valid API key is required.` |
| TokenHarbor | `https://tokenharbor.ai/v1` | `GET /v1/models` | `401 Invalid or revoked API key. Rotate your key at …` |

A `401` with a JSON error body is the useful result: it shows the route exists, the service
is live, and it wants a bearer key, which is what the generic on-demand adapter sends. A
`404` or an HTML page means the guessed path is wrong and the base URL needs finding first.
NaraRouter's site root returns HTML and `/api/v1` 404s, so only `/v1` is the API.

A card never borrows another provider's logo. There is a `tokenrouter` asset in
`public/providers` belonging to a different, unrelated service, and `tokenharbor` uses the
letter mark rather than it.

### A provider id must never resolve to a different vendor

The add-connection dialog keeps its own list of providers, and it used to resolve an
unknown id to the *first* entry, which is OpenAI. So a card the dialog did not know about
became OpenAI, with OpenAI's endpoint — and the key typed for one provider was validated
against, and transmitted to, a different company. The failure looks like a wrong key,
because the error comes back from the wrong vendor in exactly that shape:

```
Provider authentication failed. Incorrect API key provided: sk-nry-…
You can find your API key at https://platform.openai.com/account/api-keys.
```

Two rules now hold, and the second is the one that matters:

1. A card in `providerCatalog` resolves to its own option, endpoint and all, whether or
   not the dialog's list has been updated. The list is no longer a second source of truth
   that can fall behind the catalog.
2. **An id that resolves to nothing resolves to the neutral custom option, never to a
   named vendor.** A key must not be able to reach a company the operator did not name,
   and "I have never heard of this provider" is not a reason to pick one.

A catalog card and the dialog's option list are the same data in two places, and that is
the structural cause. The resolver reads the catalog as the authority and the list as an
override, so a card can be added in one place and still resolve correctly.

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
   `GET /v1/oauth/cline/callback/:sessionId`, which is exempt from both the
   cross-site guard and the API-key gate: a top-level navigation from the
   provider sends `sec-fetch-site: cross-site` and no `Origin`, and it has no way
   to carry an `Authorization` header at all.
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

The refresh request is **camelCase** — `{ refreshToken, grantType: "refresh_token" }`,
the shape Cline's own client sends. Snake_case is refused with `400 Validation failed`
naming `refreshtoken` and `granttype` as missing. The renewed tokens come back inside a
`data` envelope beside `success`, so they are read from `data`. Earlier releases sent
snake_case and read the top level, so every renewal failed and a Cline connection went
stale after its hour; 1.77.2 fixes both.

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
prefix. The adapter applies the prefix only to JWT-shaped tokens and sends
everything else verbatim. ClinePass carries the same WorkOS token — it is the same
account — so it needs no separate rule here; the current keys are a property of
Cline's JWT, not of a ClinePass-specific format.

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

### ClinePass

ClinePass is Cline's paid model tier, and it is **the same account as Cline**, not a
second credential. Cline's own client registers `cline` and `cline-pass` against the
same host and the same AI SDK provider, and its auth registry registers `cline-pass`
as an **alias** of the `cline` handler (`storageProviderId: "cline"`), reusing the
identical stored credential; `isOAuthProvider("cline-pass")` is true, and Cline's own
CLI opens a **sign-in** for it. So it is registered here as an **OAuth** provider whose
sign-in is Cline's: the ClinePass card is signed into by signing into Cline, and
nothing in Cline's SDK reads a cookie — `app.cline.bot` is only ever opened in a real
browser.

`ClinePassAdapter` therefore **subclasses `ClineAdapter`** and changes only two things:
the id and name it reports (so a failure names the ClinePass card), and the model
filter below. Everything else — the host, the client headers, and crucially the OAuth
**token renewal** — is Cline's, because the shared connection carries Cline's token
with its own expiry and a ClinePass request has to renew it like a Cline one.

What distinguishes the two is not on the wire. Same host, same `Authorization:
Bearer`, same client headers; the only difference is the `cline-pass/` model
prefix and whether the account is entitled to it.

Three consequences, all load-bearing:

- **One connection, two cards.** The gateway's `provider-alias.ts` maps `clinepass`
  to `cline`, so a request made for ClinePass reads the `cline` connection's stored
  credential. This is the one deliberate cross-provider credential lookup in the
  gateway; the provider id on the request path stays `clinepass` so the adapter and
  its errors name the right card. On the dashboard the card carries
  `connectionProviderId: 'cline'`, which is what makes the one connection light up
  both cards.
- **The list is the recommended feed's tier.** `GET /api/v1/models` does not carry
  the ClinePass tier for every account: an unsubscribed account gets the 469-model
  Cline catalog and no `cline-pass/` id at all. So `listModels` reads the `clinePass`
  array of `GET /api/v1/ai/cline/recommended-models`, which is the list Cline's own
  CLI shows, and keeps only ids beginning `cline-pass/`. The feed's tiers sit at the
  top level of the body, with no `data` envelope. An account with no tier gets an
  empty list rather than the general catalog.
- **Entitlement cannot be pre-checked.** It is decided server-side per request,
  from the subscription, and stated in the response body (*"no access to clinepass
  subscription models yet"*). There is no endpoint that answers "is this
  subscription current", so a health check proves the Cline token is live and
  **nothing more** — a green card is not an entitlement check. The model filter is
  what keeps the *model list* honest; the health status does not.

A failed renewal reads as *"sign in again"*, which is now the correct instruction:
ClinePass shares Cline's sign-in, so there is a sign-in to repeat even though there
is no ClinePass sign-in of its own.

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

- A credential that states when it ends is recognised as expired **without a request**. An adapter
  may implement `isCredentialExpired`; it returns `true`, `false`, or `undefined` for *cannot say*,
  and a health probe skips the network round trip only on `true`. A credential that is not expired
  may still have been revoked, so the provider is still asked whenever the answer is not already
  known. An expired session is reported as `AUTHENTICATION_FAILED` — *"sign in again"* — and not as
  an unavailable provider, because those need different things from the user.
- Every request the LLM surface accepts is given an id, and it is the **same** id in three
  places: the `gateway.requestId` on a successful reply, the `requestId` on a refusal, and the
  `requestId` on the `ProviderRequestContext` every adapter is called with. So *"it failed at 3pm,
  4f2a…"* is something a user can write down and an operator can find.
- Candidates are ordered by priority, then name, and a candidate must own the
  model unless the caller pinned a provider explicitly.
- A retryable failure — timeout, rate limit, provider unavailable, an
  unreadable response, or a provider-marked retryable error — spends that
  connection's retry budget and then moves to the next candidate.
  `INVALID_REQUEST`, `AUTHENTICATION_FAILED`, `NOT_SUPPORTED`, `NOT_FOUND`,
  and `CANCELLED` are terminal: they are neither retried nor failed over,
  because another connection cannot fix them.
- The terminal set is drawn by what the code says about the **request**.
  Those four describe this request or this credential — a model the plan does
  not carry, a key the provider refused, a lane that does not exist — so
  another connection refuses them identically. `INVALID_RESPONSE` is not one
  of them: the provider accepted the request and returned a body nobody could
  read, which is a statement about that provider and not about the request. It
  fails over, and the connection is marked unhealthy either way.
- The per-request deadline is enforced by the gateway, not delegated to the
  adapter, so a provider that ignores its abort signal still cannot hold a
  request open. It defaults to **two minutes**; a connection saved without an
  explicit `timeoutMs` gets that default. A `timeoutMs` of `0` means no
  deadline, and is only reachable by asking for it.
- Rate limiting uses a sliding window per connection, so a burst cannot
  straddle a minute boundary and double the effective rate. A limited
  connection hands the request to the next route **without being retried**,
  on the first attempt as much as any other: a provider that has said
  "you have reached your limit" has said it about the connection, so the next
  request to that connection is one it has already refused. Asking whether a request may
  be sent costs nothing: a refused request spends no budget, because nothing was
  sent, and a request that *was* sent and then failed still spends it, because
  it still cost the provider a call.

  Whether a connection is *over* its limit is asked of the limiter at planning
  time, per request. It is **not** read from the last recorded verdict: the
  refusal records a wait, a plan that skipped on that recorded wait would never
  run the code that records a zero, and a connection would latch itself off for
  the life of the process. The recorded wait is a report for the dashboard
  (`rateLimitWaitMs` on `GET /v1/routing`), never an input to a decision. The
  default limit is none, which is right
  for a local single-user gateway.
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

**Checked 1.51.0. Nine of these ten were unticked while `tasks/plan.md` read 50/50 complete** — the plan
was finished and the criteria it was finished *against* were never revisited. Each is now verified by
measurement, and `apps/gateway/test/spec-success-criteria.mjs` fails if any stops holding.

- [x] A TypeScript SDK package builds independently of the React app. — its own `tsconfig.json` and
      `build` script; `packages/omnihilbras-sdk/package.json` declares no React dependency.
- [x] The SDK exposes stable normalized types and a provider registry. — `ProviderRegistry` is exported,
      and the adapter contract suite runs against it.
- [x] Core adapters are implemented: OpenAI, Anthropic, Gemini, and OpenAI-compatible, with a real OpenRouter adapter for authenticated connection management. — **18 files** in `packages/omnihilbras-sdk/src/providers/` — 16 provider folders, each with an `index.ts`, plus two helpers nested inside them (`deepseek-web/deepseek-pow.ts`, `zen/zen-free-tier.ts`). `openai-compatible` is a shared base that providers extend, not a provider. The two helpers and `qwen-web` are not protocol adapters, so the guard does not count them, which is why the capture guard counts 14: its file count exceeds that because the helpers are not protocol adapters — each run through the same provider contract suite, and a real OpenRouter key metadata route rather than a generic model-list call pretending to be one.
- [x] A provider with a different protocol can be added through a capability-specific adapter without
      modifying the gateway core. — **10 registrations in `service.ts`, 0 provider-id conditionals in
      `routing.ts` or `service.ts`.** Proved by 1.43.0, which added nine providers as catalog entries and
      1.45.0, which showed the gateway serves all nine with no adapter at all.
- [x] Native streaming works through one normalized `AsyncIterable<ChatChunk>` contract. — `ChatChunk` is in
      the public types; `provider-contract.js` exercises streaming for every adapter.
- [x] Provider errors have stable codes and never expose secrets. — `ProviderError` codes throughout, and
      the transport redacts token-shaped substrings from any relayed provider body.
- [x] The local gateway starts on loopback and supports health, models, chat, and SSE streaming. — measured
      live: `GET /health` 200, `GET /v1/models` 200, and `POST /v1/chat/completions` streaming.
- [x] Tests run without real provider credentials. — **0** test files in any of the three suites read a real
      provider environment variable.
- [x] The dashboard can use the local gateway without a document reload. — client-side React Router; no
      full-page navigation on any view change.
- [x] Cloud-specific concerns are represented by interfaces but are not implemented in the first slice. —
      `DeploymentConfig` and `tenant` are types; **no cloud SDK appears anywhere in the gateway or SDK**
      (the `aws-sdk` strings in `kiro.ts` are a User-Agent Cline/Kiro expects, not a dependency).

**One criterion is deliberately weaker than it looks.** "Never expose secrets" is enforced against
*gateway* error paths, not against a provider that echoes a credential back in its own body — that is
caught by shape-based redaction in `transport.ts`, which is a heuristic, not a boundary. A provider whose
credential matches none of the redacted prefixes would pass through. Recorded in
`tasks/todo.md` rather than presented as a property the product has.

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

The response also carries a `cost` object. **A cost is only ever shown for a model whose provider published a
price** — `pricing.ts` already normalises every quote to per-1M tokens, and `/v1/usage` multiplies recorded
tokens by that quote at read time. There is no default price and no fallback: most connections to an API-key
provider carry no price at all, because the provider does not publish one, so `cost.costUsd` sums only the
records that could be priced and `cost.pricedRequests` / `cost.unpricedRequests` say how many. When nothing
could be priced, `cost.unpricedEntirely` is `true` and `cost.caveat` explains that no cost is shown — a page
that renders `$0.00` over three real requests is the failure this prevents. `caveat` is `null` when every
record was priced, because a caveat printed every time is one nobody reads. Cache reads and writes bill at
their own rates and are not folded into the input rate.

## Brand

The logo, favicon and wordmark are **generated**, not hand-drawn: `pnpm brand` writes every artefact from one
geometry in `scripts/generate-brand.mjs`, and `pnpm test:brand` (run by `pnpm verify`) checks them.

**Colours are read from `src/index.css`, never retyped.** Both themes define `--gold`, `--gold-bright` and
`--bg`, so *which block is read* decides what the logo looks like; the generator reads the dark block, because
that is what the shipped `public/favicon.svg` used and gold on a light plate has no contrast at 16 px. A
retype in the generator would make it a second source of truth, and the drift guard would compare two stale
values and agree with itself.

`public/favicon.svg` predates the generator, so it is **asserted equal** to `brand/logo.svg` rather than
replaced. Two copies of one drawing is the drift this project keeps removing elsewhere, and the assertion is
what makes it a checked invariant rather than a habit.

The maskable variant is **not** the normal icon with a different name. Android crops a maskable icon to a
circle inscribed in the square, so the mark is inset to 78% on a full-bleed plate with square corners.
Measured: the mark's bounding box is 124 px of 512 at the shipped scale and 160 px un-inset, and the guard
asserts both bounds — an icon that survives the crop by being invisible is as wrong as one that gets cut.

The npm package carries four of the generated files under `packages/omnihilbras-sdk/brand/`, because npmjs.com
renders the *package's* README and its image reference is relative to the package. The copy is written by the
generator and asserted byte-identical, since a copy made by hand ships whatever geometry was current when
someone remembered to run `cp`.

The wordmark's plate is sized from a table of glyph advances rather than a guessed ratio. The first version
guessed, and rendering it showed **"Hilbras" clipped, with the final "s" missing** — while every other test
passed, because they all checked colours, sizes and coordinates and none looked at the drawing.

