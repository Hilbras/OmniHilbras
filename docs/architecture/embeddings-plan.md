# Phase 7 — `/v1/embeddings`

Measured against `/home/gin/work/9router` on 2026-10-05. Both trees measured from source; nothing
inherited from earlier notes.

## Why this is the first gap and not provider count

The comparison turned up the standing temptation and dismissed it: 9router declares **125** registry
entries and we declare **22** cards. Provider-count parity is marketing. The property actually worth
having is *"add a provider without editing core"*, and our runtime already satisfies it —
`apps/gateway/test/runtime.test.js` asserts `THE INVARIANT: the runtime names no provider`, and all 14
protocol adapters register through `ProviderResolver` without the service knowing any of their names.

The measurable gap is **capability surface**, and it is stark:

| Surface | OURS | 9ROUTER |
| --- | --- | --- |
| `/v1/chat/completions` | yes | yes |
| `/v1/models` | yes | yes |
| `/v1/embeddings` | **no route** | `/v1/embeddings` |
| `/v1/images/generations` | **no route** | `/v1/images/generations` |
| OAuth/SSO | gateway keys | OIDC + SAML + password |
| Persistence | JSON files | SQLite |

Embeddings is first because it is the smallest honest version of the thing we are missing: a request
shape we already have all the machinery for, exposed on the existing authenticated surface.

## What already exists, and what is genuinely absent

Measured, not assumed:

- `ProviderCapability` in the SDK **already includes** `'embeddings' | 'images' | 'audio' | 'search'`
  (`packages/omnihilbras-sdk/src/types.ts`). The capability names exist; nothing declares them.
- **No adapter implements an embeddings call.** Methods across all 14 adapters are
  `chat` / `streamChat` / `listModels` / `healthCheck` / `validateCredential` / `discoverModels`.
  Zero declare `embeddings`.
- `RequestExecutor` exposes exactly `chat` and `stream` (`apps/gateway/src/request-executor.ts`),
  and `RoutingEngine.plan()` takes `{ connections, model, explicitProviderId }` — model-shaped,
  not request-kind-shaped. **The failover machinery is chat-shaped.**
- `isPublicLlmRoute()` in `routes/inference.ts:546` names `/v1/models` and `/v1/chat/completions`
  literally, so a new public route must be added there or it ships unauthenticated.
- `service.ts` mentions `embed` only in two comments about *provider embedding* (embedding an
  optional dependency), not embeddings the API.

So this is not "add a route". The chain the route needs — adapter method → executor → service →
route — has four links and **none of them exist**.

## The design decision, stated before the code

**Reuse the failover machinery, or build a parallel path?**

The obvious cheap move is a separate `embedWithFailover` that skips the executor. That is wrong for a
reason this repo has already paid for twice: the executor's semantics are the product. Cancellation
is not a failure (v1.52.0), an abandoned hedge may not record health (v1.53.0), a losing hedge must not
settle twice. A second path that does not carry those rules produces a second set of bugs that look
identical to the ones we spent two releases fixing.

So: **generalise the executor's request-kind axis rather than fork it.** Concretely, the smallest
change that is not a fork:

1. SDK: add `EmbeddingRequest` / `EmbeddingResponse` / `EmbeddingVector` types, and an optional
   `embed?:` method on `ProviderAdapter`. Optional, so it is not a breaking change to a published
   interface — and `notSupported()` from `apps/gateway/src/capability.ts` already produces the correct
   `NOT_SUPPORTED` error naming the adapter, which is the message a user needs.
2. SDK: `OpenAICompatibleAdapter` implements `embed` against `{baseUrl}/embeddings`, with an
   `embeddingsPath` config field beside the existing `modelsPath`/`chatPath`.
3. Gateway: `RequestExecutor` gains `embed()` beside `chat()`/`stream()`, sharing retry, hedge,
   rate-limit and the attempt ledger. **Not** a new executor.
4. Gateway: `GatewayService.embedWithFailover()` beside `chatWithFailover()`.
5. Route: `POST /v1/embeddings` in `routes/inference.ts`, added to `isPublicLlmRoute()` so it is
   authenticated like its siblings, with usage recorded on every terminal path exactly as chat does.
6. Guard: `tests/gateway-routes.test.js` already fails if a served path has no spec line — so the
   `docs/SPEC-SDK.md` line is required by the gate, not by good intentions.

## The acceptance criteria, written as things that can fail

- `POST /v1/embeddings` returns OpenAI's shape: `{ object: 'list', data: [{ object: 'embedding', index, embedding: number[] }], model, usage: { prompt_tokens, total_tokens } }`.
- A request naming a provider with no `embed` returns **404 `NOT_SUPPORTED`** naming that provider — not a 500, and not a silent empty vector.
- **Unauthenticated** `POST /v1/embeddings` returns **401**, like `/v1/chat/completions`. This is the specific way a new public route ships a hole, and it is why `isPublicLlmRoute` must change in the same commit.
- The **number of dimensions is measured, never invented** — the provider's own value, or absent. Not zero, not 1536 as a default.
- Usage records one entry per request, outcome `success` / `failure` / `cancelled` distinct, with `tokensUnmeasured` preserved rather than zero-filled.
- A cancelled embeddings request is recorded `cancelled`, not `success` and not `failure`.
- **Mutation-tested**, in both directions: removing `embed` from `isPublicLlmRoute` must turn the 401 test red; making `NOT_SUPPORTED` return an empty vector must turn the 404 test red; zero-filling dimensions must turn the dimensions test red.

## What is explicitly out of scope

- **Image generation.** Real capability, but it needs a binary/multipart response path and a different
  payload shape; it is a separate release, not a second endpoint in this one.
- **Audio (TTS / transcription).** Same reason, plus a base64 body this gateway has no place to hold.
- **SAML / OIDC.** That is Task 10's `AuthContext`, which is deliberately an interface with no
  implementation. Writing OIDC is a product decision, not a gap to close.
- **SQLite.** A persistence change, not a capability. Our usage and connection stores are JSON at
  `0600` and tested; changing the substrate under them is its own project.
- **Provider-count parity.** Declined, with the reason measured above.

## Verification

    pnpm verify

`pnpm test:gateway` runs as part of it. New tests go in `apps/gateway/test/embeddings-route.test.js`
and SDK tests beside the other adapter tests. The route-spec guard means a green run also proves
`docs/SPEC-SDK.md` documents the new route.

---

## Delivered

Every acceptance criterion above is met, and the numbers behind it:

| | |
| --- | --- |
| SDK types + optional `embed` on `ProviderAdapter` | `types.ts` |
| `OpenAICompatibleAdapter.embed()` + `embeddingsPath` | 15 SDK tests |
| `OpenAIAdapter` declares `embeddings: true` | the one provider whose endpoint is documented |
| `RequestExecutor.runSequential()` extracted; `chat` and `embed` share it | 3 dispatch loops total, not 4 |
| `GatewayService.embedWithFailover()` + the `embed` dispatch | — |
| `POST /v1/embeddings`, in `isPublicLlmRoute`, with usage on every terminal path | 19 gateway tests |
| `docs/SPEC-SDK.md` route line + auth sentence | required by `tests/gateway-routes.test.js` |

**Mutations caught:** embeddings dropped from the auth predicate (7 red), the
`typeof adapter.embed` check dropped, `NOT_SUPPORTED` replaced by an empty vector list, a failure recorded
as success, unmeasured `dimensions` zero-filled, and a guarded-but-unserved path (9 red).

### Three decisions this implementation made against the plan's own wording

1. **The executor loop was extracted rather than parameterised twice.** The plan said "generalise the
   request-kind axis"; what it became is one generic `runSequential<T>` that both `chat` and `embed`
   call with a dispatch closure, so the six rules cannot drift. A structural test pins the dispatch-site
   count at three — sequential, stream, hedge race — because a copied loop shows up as four.

2. **`isPublicLlmRoute` was not enough, so the route list is now compared against the dispatcher.** The
   predicate and the dispatcher state the same fact twice, and nothing in the repo connected them. The
   new test compares both sets in both directions.

3. **The attempt ledger is not in the HTTP response, and asserting it there was a wrong test.** The
   first ledger test asserted `body.error.details.attempts`; `toErrorEnvelope` publishes only
   code/message/requestId/provider/status/retryable, deliberately. The ledger is verified where it is
   consumed — the usage record — which is the reader that silently produced nothing when the ledger
   went missing in 1.61.0.

### Status codes are the existing ones, not the ones this plan guessed

`NOT_SUPPORTED` is **501** (`statusForError`'s long-standing mapping for "this provider cannot do
this"), and an unauthenticated request is `AUTHENTICATION_FAILED`. Both were written as guesses in the
first draft of the tests and were wrong; the corrected values are asserted now.
