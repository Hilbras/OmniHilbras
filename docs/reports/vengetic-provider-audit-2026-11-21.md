# Vengetic provider audit (2026-11-21)

**Scope:** our `vengetic` provider end-to-end against the live service at `api.vengetic.biz.id` and its docs at `vengetic.biz.id/docs`. No files changed; no authenticated request was made (a deliberately bogus key was used only to classify the auth behavior).

## 1. What we have

`Kernel/SDK/vengetic/adapter/index.ts:4-16` is a 15-line subclass of `OpenAICompatibleAdapter`: id `vengetic`, base `https://api.vengetic.biz.id/v1`, `Authorization: Bearer`. Everything else is inherited — OpenAI chat/stream, `/v1/models` discovery, standard SSE with `[DONE]`, tools and `tool_choice`, `max_tokens`, `temperature`, `top_p`, `response_format` where the caller can express it. Wiring is complete: card `src/data/providers.ts:525-542`, tools row `Kernel/Tools/src/caps.ts:75`, registry `Kernel/Tools/src/providerRegistry.ts:26`, slug `vg`, on-demand factory `Kernel/API/src/core/own-provider-adapters.ts:42` and `service.ts:765`. Tests exempt Vengetic from provider-contract/fixture coverage (`Kernel/SDK/tests/provider-contract.test.js:368`, `fixture-coverage.test.js:177`).

## 2. What the live service does (verified)

| Check | Result |
| --- | --- |
| `GET /v1/models` with no key | **HTTP 401** `{"error":{"code":"missing_api_key",…}}` |
| Same with bogus `Bearer sk-bogus…` | **HTTP 401** `invalid_token` — unlike NVIDIA, this catalog **does validate** the key |
| `POST /v1/chat/completions` with no key | HTTP 401 |
| Docs base URL / auth | `https://api.vengetic.biz.id/v1`, `Authorization: Bearer aiapi_…` — matches ours |
| Wire format | Standard OpenAI chat, `stream:true` → SSE `data:` with `[DONE]`; tools/tool_choice; `max_tokens`, `temperature` 0–2; no reasoning-specific parameter documented |
| Other endpoints we don't use | Anthropic-compatible `POST /v1/messages` (Bearer, not `x-api-key`), `POST /v1/images/generations`, `GET /v1/usage` (`usage:read` scope) |
| Error codes | `missing_api_key`, `api_key_invalid`, `insufficient_scope`, `model_not_found`, `insufficient_quota`, `rate_limit_exceeded`, `upstream_rate_limited`, `upstream_error`, `provider_misconfigured`; errors carry `request_id` |
| Limits (docs) | Free: 15 RPM / 100 RPD / 1 concurrent; paid tiers up to 35 RPM, 5M TPM, 100 concurrent. 429 when quota is exhausted |
| Model names | Case-sensitive, suffixes like `-Vengetic` / `:free`; docs advise copying exact ids from `/v1/models` |
| Key management | `https://vengetic.biz.id/login` → dashboard → API keys. The API host root returns 404. |

## 3. What we get right

Base URL, Bearer auth, model-id pass-through, `max_tokens`, OpenAI wire shape, and the SSE terminator all match the documentation. Because the catalog requires auth, the inherited `healthCheck()` (`listModels` → `verified:'credential'`) is a **real** credential check here — unlike NVIDIA, no bogus key can look healthy. The saved-connection Test button works through the gateway's `listModels` fallback (`Kernel/API/src/core/service.ts:4237-4244`).

## 4. Gaps, ranked

1. **P0 — the AddProviderModal Check button can never succeed.** The modal calls `POST /v1/connections/:providerId/check` (`src/components/AddProviderModal.tsx:157-180`), which routes to `validateConnectionCredential` (`Kernel/API/src/routes/connections.ts:120-128`) and throws `NOT_SUPPORTED` when the adapter has no `validateCredential` (`service.ts:4214`). Only the saved-connection Test path has the `listModels` fallback. Fix: implement `validateCredential` on `VengeticAdapter` using `listModels()` with the supplied credential — an authenticated, non-billable catalog read — so the candidate-key check reports the truth. Do **not** apply this generically: it would be unsafe for NVIDIA, whose catalog is public.
2. **P1 — gateway transport/timeout bypassed.** `own-provider-adapters.ts:42` constructs `new VengeticAdapter()` with no transport (`service.ts:765`), so it uses the SDK's 30 s default and skips the gateway's DNS-rebinding `checkDestination` and 120 s timeout. Fix: pass the gateway transport as done for aion-labs/ollama (`service.ts:761,769`).
3. **P1 — no quota reporting despite a documented `/v1/usage`.** No `quota()` method exists, so `/v1/connections/:id/quota` returns 501. The provider publishes RPM/TPM/RPD limits; implementing a generic quota reader would let the dashboard show real remaining capacity. Scope the credential requirement: `/v1/usage` needs `usage:read`, which a key may not have — absence must stay absent, not zero.
4. **P1 — other documented endpoints unreachable through our adapter.** No Anthropic `/v1/messages` or images surface. An agent configured for Anthropic against `vengetic` cannot use the provider through the gateway even though the relay speaks the protocol. Decide whether to add a translation lane or document the limitation.
5. **P2 — card points at a dead URL and labels the tier loosely.** `apiKeysUrl: 'https://api.vengetic.biz.id'` (`src/data/providers.ts:541`) returns 404; it should be `https://vengetic.biz.id/login` or the dashboard keys page. `group: 'free-tier'` is the project's free-tier grouping; the provider's "free" is a developer trial at 15 RPM / 100 RPD / 1 concurrent, not an unconditional free model tier — the card should say so in its description.
6. **P2 — error detail is flattened.** Transport maps 429 generically and never surfaces `insufficient_quota`, `upstream_rate_limited`, or `request_id`; provider-specific wording would tell the user whether to top up, wait, or retry.
7. **P2 — no tests.** Add a scripted-transport test for the exact request body, an authenticated-catalog fixture, and a validation test; remove the blanket contract/fixture exemptions.

## 5. Verdict

The wire basics are correct and — importantly — the health check is honest because Vengetic's catalog is authenticated. The single user-visible defect is the **Check button failing before save**, fixable with a small `validateCredential` override. The transport timeout, quota, and card URL are worthwhile follow-ups.

**Do not copy 9router's pattern of validating keys against a public catalog here** — the live check proved Vengetic's catalog is not public, so our approach is already the right shape; 9router has no Vengetic-specific provider at all.
