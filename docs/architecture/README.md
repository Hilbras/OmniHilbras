# Architecture

This describes **what is built**, measured against the tree. Aspirational architecture belongs in
a roadmap; this file is a map of the current one, so that a change can be judged by whether it
moves the code toward the principle below or away from it.

The principle the project is organised around:

> **The Core provides capabilities; providers provide integrations.**

A new provider should be an adapter and a registration. It should not require edits to routing,
execution, health, or the SDK core.

---

## Measured state

Counts are from the tree, not from intention. They are the honest starting point for any
refactor, and several of them contradict what an outsider might assume.

| Surface | Lines | Provider-id literals | Note |
| --- | --- | --- | --- |
| `apps/gateway/src/routing.ts` | 195 | **0** | routing was already provider-agnostic |
| `apps/gateway/src/routing.ts` → see above | 195 | **0** | `isRetryableFailure` now judges an unreadable answer a provider fault |
| `apps/gateway/src/provider-resolver.ts` | 120 | **0** | enforced by a test that greps the file |
| `apps/gateway/src/request-executor.ts` | 331 | **0** | the failover loop, the attempt ledger, the ordering |
| `apps/gateway/src/connection-manager.ts` | 241 | **0** | one error mapper, one catalog merge, one lock scope |
| `apps/gateway/src/service.ts` | 1103 | 8 | down from 12, all `.onDemand()` registrations |
| `apps/gateway/src/http.ts` | 256 | **0** | the vocabulary every route shares |
| `apps/gateway/src/routes/oauth.ts` | 249 | 4 | the module a provider split would help most |
| `apps/gateway/src/routes/connections.ts` | 233 | 5 | all in connection lifecycle |
| `apps/gateway/src/routes/inference.ts` | 386 | **0** | `/v1/models`, `/v1/chat/completions`, and the auth gate |
| `apps/gateway/src/routes/api-keys.ts` | 71 | **0** | |
| `apps/gateway/src/routes/status.ts` | 37 | **0** | `/health`, `/v1/routing` |
| `apps/gateway/src/server.ts` | 155 | **0** | was 1202 with 5 provider ids |

**The Core was far more provider-neutral than it looked.** Twelve literals in 1500 lines is not a
codebase littered with provider conditionals, and the ones that existed were not scattered — they
concentrated in a single factory:

```ts
private async resolveAdapter(providerId: string, pendingEndpoint?: {...}) {
  if (providerId === 'cline') return this.clineAdapter();
  if (providerId === 'opencode') return this.zenAdapter();
  if (providerId === opencodeConsoleProviderId) return this.opencodeConsoleAdapter(providerId);
  if (providerId === kiroProviderId) return this.kiroAdapter(providerId);
  if (providerId === chatGptWebProviderId) return this.chatGptWebAdapter();
  if (providerId === deepseekWebProviderId) return this.deepSeekAdapter();
  const registered = this.registry.get(providerId);   // ← everything else lands here
}
```

Those six branches existed for one reason, and it was not that those providers were special: they
must be **built on demand**, because each needs a connection id, a lazily-created browser driver,
or a shared access-token cache. That is a factory, and a factory is a registration:

```ts
this.providers = new ProviderResolver(registry)
  .onDemand('cline', () => this.clineAdapter())
  .onDemand('opencode', () => this.zenAdapter())
  // … six registrations, in one place
```

`ProviderResolver` now contains **zero** provider ids, and a test strips the comments and fails if
a provider-shaped string appears. That is the whole provider-coupled execution surface, closed.

**What remains, honestly:** the service still names each on-demand provider *once*, in that
constructor. The step from here to "a provider adds itself" is for adapter modules to carry their
own registration.

### What the numbers mean

**Stateless providers already need no Core changes.** Nine connections are live —
`openrouter`, `cline`, `opencode`, `opencode-console`, `nara-router`, `tokenharbor`, `kiro`,
`chatgpt-web`, `deepseek-web` — and the OpenAI-compatible ones are served by the generic branch at
the end of `resolveAdapter` with no per-provider code at all. Adding one required an adapter and a
connect route. Nothing else.

**Lifecycle providers are the exception, and for a structural reason.** The Core has no lifecycle
concept at all:

```
lifecycle   0 occurrences in service.ts
revoke      0
onboard     0
provision   0
```

A provider whose credential is simply a stored secret fits the Core's model. A provider that must
be *created, refreshed, and revoked* — a Cline session, an OAuth grant, a console token — has
nowhere to live, so it is wired in by hand: the adapter is built on demand, its credential is
written by a bespoke block, and its refresh is orchestrated in the Core.

**That is the real gap, and it is one abstraction, not twelve refactors.** A `CredentialLifecycle`
contract — `create` / `refresh` / `revoke` / `describe`, with the Core owning *when* to call it and
the adapter owning *how* — would absorb every one of those hand-wired branches, and
`resolveAdapter` would shrink to a lookup.

---

## Layers

```text
apps/gateway/src/
  server.ts          CORS, body limits, and a five-line route dispatcher. No provider logic.
  http.ts            Read a request, write a response, turn a failure into an envelope.
  routes/            One module per resource: status, connections, oauth, api-keys, inference.
  service.ts         Composition root. Wires the managers below to its own effects.
  provider-resolver  Which adapter serves a provider id. Zero provider ids; a test enforces it.
  request-executor   The failover chain: hedge, retry, next route, attempt ledger. Zero ids.
  connection-manager  Storing connections: one error mapper, one catalog merge, one lock scope.
  sign-in-sessions   The one OAuth session lifecycle. A grant is spent once, in one function.
  sign-in-coordinator  Claim, poll, save, publish — and one description of why a sign-in failed.
  credential-manager  Which connection serves a provider, and the context a request is made in.
  routing-engine      Which routes a request may take, given health and limits. Zero ids.
  model-catalog       What this gateway serves, and which provider serves what. Zero ids.
  retry-policy        Retry this route, next route, or stop. One decision, two callers. Zero ids.
  timeout-policy      What a timeout value means, and the deadline that enforces it. Owns the default.
  rate-limit-policy   What a request limit means, when it is spent, and what it is *now*.
                       `currentWait` is a query; `enforce` records the verdict. A plan asks
                       `currentWait`, never the recorded map — 1.39.0, where reading the record
                       latched a limited connection off for the life of the process.
  zen-free-tier       The four request conditions OpenCode Zen's free tier requires, in one place.
                       A rule about a request, not a provider: `zen` applies it to any `-free` model.
                       The two parts that drift (placeholder tool name, client version) are read from
                       the environment, and a refusal after they are met names the network rather
                       than the credential — 1.42.0.
  hedge-policy        Whether a second request is worth sending, and which route. Every refusal is named.
  request-context     One request's id, from the edge to whichever provider answered it.
  credential-lifecycle  Whether a stored credential still works, asked without a request.
  runtime.ts            The outer runtime: auth context, tenant, credential store, deployment.
  capability          A named "this adapter does not do that", for two consumers that needed it.
  health.ts          Probing, ejection and recovery, asked two questions only.
  api-key-manager    API keys and the two user-facing messages about them.
  routing.ts         Provider-agnostic selection, ejection and recovery. Zero provider ids.
  transport.ts       One configured HTTP client, bounded bodies, URL validation.

packages/omnihilbras-sdk/src/
  registry.ts        ProviderAdapter contract and registration.
  types.ts           The contract every adapter satisfies.
  transport.ts       HttpTransport, shared by adapters and the gateway.
  errors.ts          ProviderError and the normalised error codes routing reasons about.
  adapters/          One directory per provider. All provider-specific wire formats live here.

src/                 Dashboard. Presentation and gateway management only.
```

The boundary that matters: **`apps/gateway/src/routing.ts` must never learn a provider's name.**
It decides between candidates using health, priority and error class. If a provider id ever
appears there, the abstraction has leaked.

---

## Provider categories

Providers differ operationally, and the difference is not cosmetic. The categories are recorded on
the catalog entry (`status`, `auth`, `unavailableReason`) and should drive behaviour rather than
being re-derived.

| Category | Credential | Failure mode | Examples |
| --- | --- | --- | --- |
| **API** | static secret | key rejected | OpenAI, Anthropic, Gemini, OpenRouter |
| **OpenAI-compatible** | static secret | endpoint unreachable | NaraRouter, TokenHarbor, custom endpoints |
| **OAuth / device flow** | refreshable grant | grant expired | Cline, Kiro, OpenCode Console |
| **Web session** | whole-account cookie or token | session or gate | ChatGPT Web, DeepSeek Web, Qwen Web |

A web-session credential is **an account, not a key**. It grants what the account can do, it
expires unpredictably, and it is often a browser-only, undocumented protocol. Treating it like an
API key is how a dashboard ends up claiming a connection works when a provider has since gated
it — which is exactly what happened to Qwen, and why its card says what it measured.

---

## Adding a provider

```text
1. Write the adapter in packages/omnihilbras-sdk/src/adapters/<name>/
2. Satisfy ProviderAdapter: chat, listModels, validateCredential, healthCheck, capabilities
3. Export it from the SDK index
4. Register it in the gateway registry
5. Add adapter tests
6. Drop the mark in public/providers/ and reference it from src/data/providers.ts
```

If step 4 requires touching `routing.ts`, `service.ts` execution paths, or the SDK core, the
adapter is asking the Core to do something it should be doing itself. That is the signal to add an
abstraction instead of a branch.

Web-session providers additionally need a connect route, because the credential is obtained by a
manual step rather than a request body. Those routes live in `routes/oauth.ts` and are the one
*intentional* provider-specific surface in the HTTP layer. It is also the module where a provider
split would pay for itself fastest: a fifth OAuth provider is five more `if` blocks in one file,
next to the four that already exist.

### The marks are input, not build output

`public/providers/` is written by a human and read by the `logoPolarity()` plugin in
`vite.config.ts`, which samples each asset and writes `src/lib/logoPolarity.generated.ts` saying
whether the mark needs a light or a dark tile. **The directory is never written to.** Excluding it
from a commit as generated output therefore drops required assets, and it did: 141 of 294 were
absent from 18 consecutive releases, two of them rendered directly by `src/data/providers.ts`.

Nothing catches that on its own — a missing logo is a 404 in a browser, and the generated map
degrades silently by applying its rule to files the checkout does not have. `tests/dashboard-assets.test.js`
asserts it instead, and `pnpm test:repo` runs first in `pnpm test` for that reason.

## The outer runtime, and what it is not

`runtime.ts` names the four things a deployment supplies — `AuthContext`, `TenantContext`,
`ConnectionSecretStore`, `DeploymentConfig` — and **implements none of them**. The task said
"interfaces, without cloud infrastructure", and the tempting way to fail that is to add a
`RemoteSecretStore` nobody uses, so a test asserts the *absence*: no file under `src/` may contain
`remote`, `tenantStore` or `CloudConfig` outside a comment.

The boundary earned its keep by finding real problems rather than by existing:

- **Two exported types were called `SecretStore`.** The SDK's is keyed by *provider* and read-only;
  the gateway's is keyed by *connection* and writable. Reading `SecretStore` in either package meant
  opening the other one to find out which you had. The gateway's is now `ConnectionSecretStore`.
- **The service's credential dependency was `Pick<ConnectionStore, 'get' | 'set' | 'delete'>`** —
  a type describing the local file store's *origin* rather than the shape the gateway needs, and one
  the local store never actually satisfied. "Could this be remote?" was only answerable by reading a
  constructor.
- **A third credential-store shape existed and was used nowhere.** `WritableSecretStore` extends the
  provider-keyed type, so it looked like the gateway's writable store while having a different key.
  Deprecated with a pointer; a trap left exported is worse than a trap removed.
- **`trusted: boolean` became `AuthContext`.** The boolean is a correct decision expressed as a
  value with no owner and no name, so nothing could ask *who*, and a hosted gateway could not answer
  "may this reach the LLM surface without a key" differently from a loopback one.

**Tenancy is carried, not threaded.** A tenant is a property of a *deployment*, so it is configured
once; a multi-tenant deployment scopes a store by construction rather than adding a parameter to
thirty methods. Threading a value nothing reads would be decoration shaped like architecture.

---

## The provider contract

`packages/omnihilbras-sdk/test/provider-contract.js` holds the invariants the Core is entitled to
assume, and `provider-contract.test.js` runs them against every adapter that can be driven offline
— **all eleven adapters**, which is the point of the coverage guard below: every `.ts` in
`src/adapters/` is either contracted or listed with a reason why not, and adding an eleventh (or a
twelfth) fails the suite until it is dealt with.

The split is the design: **the contract owns the invariants, a provider supplies only its wire
format.** Asking a provider to describe its own expectations would make this a second copy of its
tests; asking it only how to speak its own protocol keeps the assertions in one place, where they
cannot drift per provider.

It asserts what the Core actually relies on:

| Invariant | Why the Core needs it |
| --- | --- |
| declared capabilities have implementations | routing dispatches on the flag; a flag with no method is a crash |
| refusals are `ProviderError` with a known code | the routing engine decides retry/fail-over by reading `code` and nothing else |
| a 401 maps to `AUTHENTICATION_FAILED` | "unauthorized" is terminal, "unavailable" is not — the wrong one ejects a working connection |
| models are attributed to the adapter that returned them | usage and ejection both read `providerId` |
| health never throws, and carries a reason when unhealthy | a throw breaks the sweep that contains it |
| **text survives the round trip exactly** | a truncated answer is worse than an error, because it looks like a working model |

**The last one is the centrepiece, and it exists because of a real bug.** DeepSeek Web's own tests
asserted that two hand-written frame shapes were read correctly, and passed — while every real
answer was being truncated to its first character, because live traffic arrives as a run of
bare-string frames the fixture did not contain. A test that constructs its own input and then
asserts against that input only proves the decoder agrees with the author of the test.

So every completion fixture in the contract is **multi-part**, and the assertion is exact
equality. The contract answer ends in a lone space and its parts share prefixes, so per-frame
trimming and deduplication each fail. It was proven, not assumed: the shipped decoder returns
`"1, 2, 3"` from a captured stream, and a decoder that keeps only the first fragment returns `"1"`
and is rejected.

### It found a bug on the first run

Four adapters reported `unavailable` from a bare `catch {}` with **no message** — `anthropic`,
`gemini`, `openai-compatible`, `openrouter`. The dashboard could say "unavailable" and not whether
the key was rejected, the endpoint was wrong, or the provider was down, which are three different
things to go and fix. Six other adapters already carried the reason, so the shape existed to copy.

### Three injection styles, and three harnesses

| Style | Adapters | Harness |
| --- | --- | --- |
| `{ transport }` | openai, openrouter, openai-compatible, anthropic, gemini, cline, kiro, opencode-console | `test/harness/scripted-transport.js` |
| `{ fetch }` | deepseek-web | `test/harness/scripted-fetch.js` |
| `{ driver }` | chatgpt-web | `test/harness/scripted-driver.js` |

Each harness implements the *real* interface it stands in for, because a harness that implements a
similar one cannot exercise the adapter at all. The `fetch` double is built from real `Response`
objects, because DeepSeek's reader streams `response.body` and refuses a body past 8 MB; the driver
double has no HTTP request to intercept, so the driver interface *is* the seam.

Every contract test needs a harness per style, so a single seam here would remove real cost. It
ranks below closing `resolveAdapter` but above decomposing the service.

## Contracts worth keeping

Three things in this repository have earned their keep and should be protected:

- **Errors are normalised, and routing reasons about codes, not providers.** A provider that
  refuses with a 200 and a refusal in the body — Qwen does — is mapped at the adapter edge, never
  in routing.
- **A health check reports what it measured.** A check served from a cache is not a check, and a
  request that stalled is not a result. Both mistakes shipped here once and were caught only by
  looking at a real provider.
- **Nothing is saved until it has been verified.** Connect routes verify before writing, so a
  refused credential never becomes a connection the dashboard then calls "connected".

---

## Deliberate non-goals

- **Splitting the SDK into per-provider packages.** The SDK is small and the adapters are the
  point. Package sprawl costs more than it saves until there is a size or ownership reason.
- **A rewrite.** The provider-specific surface is twelve literals in one factory. That is a
  refactor's size, and doing it incrementally keeps the whole suite green throughout.
- **Cloud infrastructure.** The store interfaces are worth having; implementing remote stores
  before they are needed is speculative.
