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
| `apps/gateway/src/routing.ts` | 186 | **0** | routing is already provider-agnostic |
| `apps/gateway/src/service.ts` | 1500 | 12 | clustered in one method — see below |
| `apps/gateway/src/server.ts` | 1202 | 5 | all in connection lifecycle routes |

**The Core is far more provider-neutral than it looks.** Twelve literals in 1500 lines is not a
codebase littered with provider conditionals. And the ones that exist are not scattered — they
concentrate in a single factory:

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

Six lines. That is the entire provider-coupled execution surface, and it is the seam worth
closing first.

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
  server.ts          HTTP: routes, CORS, body limits. Translates requests; no provider logic.
  service.ts         Orchestration: connections, lifecycle, execution, health, routing state.
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
```

If step 4 requires touching `routing.ts`, `service.ts` execution paths, or the SDK core, the
adapter is asking the Core to do something it should be doing itself. That is the signal to add an
abstraction instead of a branch.

Web-session providers additionally need a connect route, because the credential is obtained by a
manual step rather than a request body. Those routes live in `server.ts` and are the one
*intentional* provider-specific surface in the HTTP layer.

---

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
  refactor's size, and doing it incrementally keeps 419 tests green throughout.
- **Cloud infrastructure.** The store interfaces are worth having; implementing remote stores
  before they are needed is speculative.
