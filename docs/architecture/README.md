# Architecture

Visual language: [design-system.md](../design-system.md).

This describes **what is built**, measured against the tree. Aspirational architecture belongs in
a roadmap; this file is a map of the current one, so that a change can be judged by whether it
moves the code toward the principle below or away from it.

The principle the project is organised around:

> **The Core provides capabilities; providers provide integrations.**

A new provider should be an adapter and a registration. It should not require edits to routing,
execution, health, or the SDK core.

## Delivery surfaces

The gateway is one of three consumers in this repository:

- `Kernel/API` is the HTTP gateway and composition root. It owns routing, health, retries, usage, the vault
  and the token-saver order.
- `Kernel/TokenSaver` is a standalone package. It can be used without the gateway and is tested on its own.
- `src/` is the dashboard and marketing site. `site/` holds the static HTML entries for the public pages;
  `desktop/` owns the Electron lifecycle, preload bridge and update runtime.

The dashboard and desktop app never call a provider directly. They call the gateway, which is the only
component that knows a provider's wire format.

## Android companion

`android/` is a Capacitor WebView for the dashboard, not a second gateway. The app pairs with a gateway URL and
a device API key; the key is encrypted by an Android Keystore-backed `SecureStore` plugin. Remote URLs must be
HTTPS; plain HTTP is limited to loopback and `adb reverse`. The provider vault never leaves the desktop. QR
pairing and release signing are deferred.

## Accounts

`GatewayConnection` is the account record. It already carries its own id, encrypted credential, model list,
priority, `requestsPerMinute`, optional `maxConcurrentRequests` and `proxyPool` name. Multiple rows for one
provider are separate accounts, not one account with aliases.

- Routing prefers `x-omnihilbras-connection` when supplied; the named account is spent first and its siblings remain behind it. Unknown and disabled accounts are refused.
- `UsageRecord.connectionId` is the account attribution; the Usage tab filters by it.
- `AUTHENTICATION_FAILED` is recorded against the account that owns the credential; a sibling is tried first because it is a different key, and the failure is reported when none is left.
- `proxyPool` is not enforced by a transport yet. A non-`none` value is refused rather than sent direct;
  pretending the label isolates egress would be worse than the clear error.

## Identity boundary

The deployment is still **single-operator by contract**, but a key now has a role. `owner` is the
historical admin credential: it can read and change the local vault the dashboard can. `viewer` is
read-only: it may read the observation surface (connections without credentials, providers, usage,
logs, events, health, routing, observability, token-saver, virtual models, skills, workspaces,
tunnels, pool and node metadata) and is refused every management write plus the sensitive reads
(`/v1/keys`, `/v1/backup`, `/v1/oauth`, `/v1/mitm`, `/v1/settings`, `/v1/runtime`). A key written
before roles existed loads as `owner`.

**A key with a `workspaceId` is scoped to it.** The connection list is filtered, a connection in
another workspace answers `404` rather than leaking its existence, a save is forced into the key's
workspace (a body naming another one is `400`), and the key list only shows keys in that workspace.
An unscoped key — every key written before this existed — keeps the operator-wide view. The scope is
enforced on `connections` and `keys`; usage, logs and the remaining stores are still operator-wide, so
`workspaceId` is a real boundary where it is applied and metadata elsewhere. `responsibility.owner`
remains metadata.

**Every authenticated management write is audited.** The HTTP boundary records actor (`key:<id>`,
`dashboard` or `system`), method, path, outcome and request id after the response is produced. The
record is content-free: no body, credential, prompt or connection record. `GET /v1/audit` is owner-only
and bounded to the last 5,000 records; the trail is local and is not yet in the encrypted backup
envelope.

The one administrative boundary that is enforced is process ownership: a desktop or CLI credential is
read only after the caller proves it owns the gateway process it is about to address.

**The vault is single-writer across processes.** The desktop app and the CLI can each hold a gateway on
the same state directory, and each keeps its own in-memory copy of the connections. A write
therefore takes `vault.lock` (created with `wx`, holding the holder's pid and a random token), and
reloads the metadata and encrypted secrets first when either file changed since this process last read
or wrote them. Without the reload, the lock would only serialize two stale copies: the second writer
would persist every connection it had loaded before the first writer's save, and that connection would
be gone. Reads take the lock only after a `stat` shows a change, so the ordinary path is two `stat`
calls and no contention. A lock whose holding process is gone, or whose age exceeds two minutes, is
broken; the token is checked before unlinking so a release cannot remove a successor's lock. The key
file was already safe by `wx`: two first runs race, one creates it, the other reads what was created.
Usage counters are accumulated as deltas and folded in after the reload, so a concurrent save cannot
discard a count that arrived while the flush was waiting.

## Jobs

Health sweeps and token renewals are the gateway's background passes. Each records its name, duration,
outcome and a short detail in the `jobs` state document, bounded to 1,000 runs; `GET /v1/jobs` serves
the history owner-only. This is a record, not a scheduler: stopping the timer stops the runs. It exists
because the current health was visible while the last sweep's failure was not, and a restart erased the
only evidence that renewal had run.

## Route contracts

`Kernel/API/src/core/route-contracts.ts` is the dispatcher's path inventory: 97 concrete paths and 38
prefixes, generated once from the route modules and served by `GET /v1/openapi` as an OpenAPI 3.1
document. Each path carries `x-omnihilbras-served`; prefixes are repeated in
`x-omnihilbras-prefixes`. This is discovery, not a typed schema: `tests/gateway-routes.test.js` parses
the same source and fails if the list and the dispatcher disagree. `!==` comparisons are included in
that parser because the early-return route shape (`if (url.pathname !== path) return false`) was a
blind spot the OpenAPI check exposed.

## State engine

Every local store now writes through one `StateDocument` seam. Its JSON shape is unchanged, so a vault, a
backup and a hand-edited file still mean what they meant; what moved is the durable container. With
`OMNIHILBRAS_STATE_BACKEND=sqlite`, each document is a row in `<dataDir>/state.db` (WAL, `busy_timeout`) and
each write appends an `events` row with the collection, byte count and SHA-256 — never the payload. A first
read imports the existing JSON file once; a row that exists wins, so a stale file cannot roll a store back.
The connections vault keeps its process lock and reload-on-change behavior: the stamp is now the document's
`updated_at:digest` rather than a file `stat`. `GET /v1/events` replays the journal for a reconnecting
`Last-Event-ID` and then resumes the live fingerprint; the JSON backend has no journal and delivers the next
change live. Usage keeps its own SQLite backend and is the one store with SQL-side queries.

## Virtual models

A virtual model is one public `oh/` id with one or more account/upstream-model targets. `GatewayService.planRoute`
resolves it before concrete model routing; each target is planned as a one-connection decision so health,
credentials, rate limit and concurrency stay in the routing engine. `RouteCandidate.model` carries the upstream
model override, and the request executor sends it instead of the alias. No provider sees `oh/...`.

---

## Measured state

Counts are from the tree, not from intention. Both numeric columns are **recomputed by
`tests/documentation-counts.test.js`** — added in 1.85.1, because this table had been read as measured
while every line count in it had gone stale: `service.ts` was quoted at 1103 and measured 1755, and
nothing had looked. A caption saying "measured" is a claim like any other, so the only version of it
that holds is one a machine re-derives.

- **Lines** — the file's line count.
- **Provider ids named** — how many of the provider ids the SDK ships (one directory each under
  `Kernel/SDK/`, so a new provider extends the check without editing it)
  occur as a whole word inside a string literal in the file's executable code, comments stripped. That
  is the definition `shared-execution-has-no-provider-names.test.js` applies to the shared algorithm,
  generalised from "is this zero" to "how many". **Zero is the claim this column exists to make**; a
  non-zero row is the honest size of a provider-specific surface, not an allegation.

| Surface | Lines | Provider ids named | Note |
| --- | --- | --- | --- |
| `Kernel/API/src/core/routing.ts` | 949 | **0** | provider-agnostic; `isRetryableFailure` judges an unreadable answer a provider fault |
| `Kernel/API/src/core/provider-resolver.ts` | 347 | 1 | enforced by a test that greps the file; the per-provider tables live in `provider-client-identity.ts` and `provider-responses-lane.ts` it reads |
| `Kernel/API/src/core/circuit-breaker.ts` | 192 | **0** | per-connection closed → open → half-open; counts what it refused |
| `Kernel/API/src/core/request-executor.ts` | 1049 | **0** | the failover loop, the attempt ledger, the ordering |
| `Kernel/API/src/core/connection-manager.ts` | 383 | **0** | one error mapper, one catalog merge, one lock scope |
| `Kernel/API/src/core/service.ts` | 5820 | 54 | every `.onDemand()` registration, in one constructor |
| `Kernel/API/src/core/http.ts` | 361 | **0** | the vocabulary every route shares |
| `Kernel/API/src/routes/oauth.ts` | 967 | 14 | the module a provider split would help most |
| `Kernel/API/src/routes/connections.ts` | 441 | 1 | one OpenRouter save shortcut, the generic quota route, the build stamp, and the route that forgets an added model |
| `Kernel/API/src/routes/inference.ts` | 2055 | **0** | `/v1/models`, `/v1/chat/completions`, `/v1/responses`, `/v1/messages` (Anthropic shape + SSE), the video path constants, and the auth gate |
| `Kernel/API/src/routes/api-keys.ts` | 162 | **0** | the key list, the one mutable setting, and the PATCH that either pauses or renames — never both |
| `Kernel/API/src/routes/status.ts` | 220 | **0** | `/health`, `/`, `/v1/system`, `/v1/routing`, and the build stamp |
| `Kernel/API/src/core/codexCallbackListener.ts` | 92 | **0** | the loopback socket a registered redirect points at |
| `Kernel/API/src/server.ts` | 575 | **1** | refuses a half-configured Codex OAuth override at startup, dispatches the video surface, and gives every request the id its record will carry |

**The Core was far more provider-neutral than it looked.** The non-zero cells above are the entire
provider-specific surface of the gateway core, and none of it is a scattered conditional — it is a
registration block and a credential alias. What used to be a chain of `if` statements concentrated in a
single factory:

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
  // … twelve registrations, in one place
```

`ProviderResolver` now contains **zero** provider ids, and a test strips the comments and fails if
a provider-shaped string appears. `service.ts`'s own `resolveAdapter` is down to a single delegation —
`return this.providers.resolve(providerId, pendingEndpoint, () => this.listConnections())` — so the
branching that used to name providers is gone and what remains is the registration list itself.

**What remains, honestly:** the service still names each on-demand provider *once*, in that
constructor, which is why it is one of the three files in the table above with a non-zero count. The
step from here to "a provider adds itself" is for adapter modules to carry their own registration.

### What the numbers mean

**Stateless providers already need no Core changes.** A provider the gateway can reach with a stored
credential is served by `ProviderResolver`'s saved-endpoint fallback — any id, registered or not — and
the OpenAI-compatible ones land on one generic branch with no per-provider code at all. Adding one
required an adapter and a connect route. Nothing else.

**Lifecycle providers are the exception, and for a structural reason.** A provider whose credential is
simply a stored secret fits the Core's model. A provider that must be *created, refreshed, and revoked*
— a Cline session, an OAuth grant, a console token — has nowhere to live, so it is wired in by hand:
the adapter is built on demand, its credential is written by a bespoke block, and its refresh is
orchestrated in the Core.

This section used to prove that with a word count — `lifecycle`, `revoke`, `onboard` and `provision`,
each "0 occurrences in `service.ts`". **That evidence has expired, and 1.85.1 removed the claim along
with it:** `lifecycle` appears in `service.ts` four times, because `CredentialLifecycle` now exists. It
is *not* the contract proposed below — it pre-checks whether a stored credential has already expired,
so that a health sweep does not launch a browser to be told what the credential said in writing — and it
creates, refreshes and revokes nothing. `revoke`, `onboard` and `provision` are still 0. A count offered
as evidence stops being evidence the moment it moves, and this one was left standing as though it had
not.

**That gap now has its contract.** `CredentialProvisioner` (`refresh` / `revoke` / `describe`) is
implemented by `AdapterCredentialProvisioner`, which delegates the *how* to the adapter's
`renewCredential` and removes the secret through the connection store. The renewal pass calls the
provisioner instead of branching on the adapter method, so a lifecycle provider can adopt the
contract without teaching the Core another branch; `create` remains the sign-in routes, because
creating a credential is a flow with a browser, not a method call. `CredentialLifecycle` keeps its
separate job: the pre-check that avoids launching a browser to learn a token's written expiry.
**Provider manifests are now one description.** `Kernel/SDK/_shared/src/provider-manifests.ts` holds
every provider's card fields, tool capability row and registry row (base URL, model URL, auth mode,
wire formats, usage URL). `src/data/providers.ts`, `Kernel/Tools/src/caps.ts` and
`Kernel/Tools/src/providerRegistry.ts` are projections, not tables.
`tests/provider-manifest.test.js` asserts each projection field-for-field and fails if a consumer
carries a second literal list. The manifest is generated once during the V4 migration and is the source
from here on; a provider is added by adding one manifest entry and its adapter.

---

## Layers

```text
Kernel/API/src/
  server.ts          CORS, body limits, and a five-line route dispatcher. No provider logic.
  routes/            One module per resource: status, connections, oauth, api-keys, inference, usage.
  core/              The rest of the gateway: composition, policy, and the contract layer.
    http.ts          Read a request, write a response, turn a failure into an envelope.
    service.ts       Composition root. Wires the managers below to its own effects.
    provider-resolver  Which adapter serves a provider id. Zero provider ids; a test enforces it.
    provider-client-identity  The client identity one provider's relay gates on — impersonation of another
                       vendor's tool, one provider, overridable, and named as such where it is written.
    request-executor  The failover chain: hedge, retry, next route, attempt ledger. Zero ids.
    connection-manager  Storing connections: one error mapper, one catalog merge, one lock scope.
    sign-in-sessions  The one OAuth session lifecycle. A grant is spent once, in one function.
    sign-in-coordinator  Claim, poll, save, publish — and one description of why a sign-in failed.
    credential-manager  Which connection serves a provider, and the context a request is made in.
    routing-engine    Which routes a request may take, given health and limits. Zero ids.
    model-catalog     What this gateway serves, and which provider serves what. Zero ids.
    retry-policy      Retry this route, next route, or stop. One decision, two callers. Zero ids.
    timeout-policy    What a timeout value means, and the deadline that enforces it.
    rate-limit-policy  What a request limit means, when it is spent, and what it is *now*.
    hedge-policy      Whether a second request is worth sending, and which route.
    request-context   One request's id, from the edge to whichever provider answered it.
    credential-lifecycle  Whether a stored credential still works, asked without a request.
    registry.ts       The ProviderAdapter contract and registration — the one shared contract.
    types.ts          The interface every adapter satisfies.
    runtime.ts        The outer runtime: auth context, tenant, credential store, deployment.
    capability        A named "this adapter does not do that", for two consumers that needed it.
    health.ts         Probing, ejection and recovery, asked two questions only.
    api-key-manager   API keys and the two user-facing messages about them.
    routing.ts        Provider-agnostic selection, ejection and recovery. Zero provider ids.

Kernel/SDK/
  _shared/         The canonical adapter machinery: errors, url, streaming, bounded-map,
                   model-normalize, types, transport, responses-lane and the OpenAI base.
  openai/          One provider package, and the shape every sibling has: adapter/index.ts holds the
                   wire format; lib/types.ts and provider-specific helpers stay local; package.json
                   and log/ are owned per provider. Deleting one folder leaves the others able to build.

src/                 Dashboard. Presentation and gateway management only.
```

The boundary that matters: **`Kernel/API/src/routing.ts` must never learn a provider's name.**
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
1. Write the adapter in Kernel/SDK/<name>/
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
split would pay for itself fastest: that one file serves **five** OAuth start routes —
`claude-code`, `cline`, `kimi-code`, `kiro`, `opencode-console` — each with its own session and
callback handling, so a sixth arrives as another block of branches beside them.

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

`Kernel/SDK/tests/provider-contract.js` holds the invariants the Core is entitled to
assume, and `provider-contract.test.js` runs them against every adapter that can be driven offline
— **all twenty-five provider packages**, which is the point of the coverage guard below: every
directory under `Kernel/SDK/` that ships a contract is either contracted or listed with a reason
why not, and adding another fails the suite until it is dealt with.

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
| `{ transport }` | openai, openrouter, openai-compatible, anthropic, cline, clinepass, claude-code, gemini, kimi-code, kiro, opencode-console, zen | `test/harness/scripted-transport.js` |
| `{ fetch }` | deepseek-web, tokenharbor-web | `test/harness/scripted-fetch.js` |
| `{ driver }` | chatgpt-web, gemini-web | `test/harness/scripted-driver.js` |

Each harness implements the *real* interface it stands in for, because a harness that implements a
similar one cannot exercise the adapter at all. The `fetch` double is built from real `Response`
objects, because DeepSeek's reader streams `response.body` and refuses a body past 8 MB; the driver
double has no HTTP request to intercept, so the driver interface *is* the seam.

There is now one import seam, `Kernel/SDK/tests/harness/index.js`, and the contract suite uses it. The
three doubles remain because the three interfaces are genuinely different: a single double cannot
implement a transport, a streaming `fetch` and a page driver without becoming the union of all three
and losing the property that it implements the real interface. The seam removes the import cost; it
does not pretend the styles are one.

### Decision, 2026-11-18: the two remaining seams are deferred

The deep scan recorded two unresolved architecture seams and chose **not** to implement either in this plan:

- **`CredentialProvisioner`** (`create` / `refresh` / `revoke` / `describe`) would replace the per-adapter
  renewal hooks with one contract. It is real work across every SDK package, and the current renewal pass is
  tested and working; doing it here would mix a wide refactor into a release whose purpose is honesty of
  claims. Deferred to a separate `3.68.0` effort if a provider with a third credential shape arrives.
- **One adapter harness seam.** Three injection styles exist (transport double, driver double, fetch double)
  because the providers genuinely differ; a single seam would need to emulate all three. It ranks above
  decomposing the service, but below a verified provider contract, so it stays outstanding.

Neither is a blocker for the current release. Both are recorded here rather than in a stale task checkbox.

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

- **Splitting the SDK into per-provider packages.** — **Done, then partially undone on purpose.**
  The Kernel restructure dissolved the shared SDK into one private package per provider under
  `Kernel/SDK/`; the reason was ownership and per-provider release/build isolation, and the cost was
  245 tracked vendored files with 56 copies of `types.ts` and `errors.ts`. V4's Phase A keeps the
  per-provider packages but moves the modules that have no reason to vary into
  `Kernel/SDK/_shared`. The split is still real — ownership and build isolation remain — but a
  shared fix now lands once, and a reinstated copy fails `tests/vendored-lib-drift.test.js`.
- **A rewrite.** The provider-specific surface of the Core is a registration list and two route
  modules, not a scattered set of conditionals — so a rewrite has nothing to collect. Doing it
  incrementally keeps the whole suite green throughout.
- **Cloud infrastructure.** The store interfaces are worth having; implementing remote stores
  before they are needed is speculative.
