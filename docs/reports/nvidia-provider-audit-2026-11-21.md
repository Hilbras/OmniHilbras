# NVIDIA provider audit against build.nvidia.com (2026-11-21)

**Scope:** how our `nvidia` provider works, what `build.nvidia.com` / `integrate.api.nvidia.com/v1` actually offer, and the concrete gaps. No files were changed; no billable request was made and no credentials were used.

## 1. What we have

`Kernel/SDK/nvidia/adapter/index.ts:4-14` is a 15-line subclass of `OpenAICompatibleAdapter`: id `nvidia`, base `https://integrate.api.nvidia.com/v1`, `Authorization: Bearer`. Everything else is inherited:

- model discovery `GET /v1/models`, chat/stream on `/chat/completions`, auth mandatory, standard SSE with `[DONE]`;
- request body (`Kernel/SDK/openai/lib/openai-compatible.ts:694-709`): `model`, `messages`, `stream`, `temperature`, `top_p`, `max_tokens`, `stop`, `tools`, `tool_choice`, **`reasoning_effort`**; `providerOptions` are rejected outright (`:809-813`);
- health check is just `listModels()`, reported `verified: 'credential'` (`:653-673`). No `validateCredential`, `discoverModels`, quota, or expiry override exists in the package;
- wiring is present: card `src/data/providers.ts:1378-1400`, tools row `Kernel/Tools/src/caps.ts:67` (OpenAI wire, forced choice allowed), registry `Kernel/Tools/src/providerRegistry.ts:58`, slug `nv`, on-demand factory `Kernel/API/src/core/own-provider-adapters.ts:59`;
- tests explicitly exempt NVIDIA from provider-contract and fixture coverage (`Kernel/SDK/tests/provider-contract.test.js:368`, `fixture-coverage.test.js:177`).

## 2. What the live service does (verified directly)

| Check | Result |
| --- | --- |
| `GET /v1/models` with **no key** | **HTTP 200**, 33 models |
| `GET /v1/models` with a bogus `Bearer nvapi-…` | **HTTP 200** — the catalog is public and does not validate the key |
| `POST /v1/chat/completions` with no key | **HTTP 401** |
| Model ids | `vendor/model`, e.g. `nvidia/nemotron-3-ultra-550b-a55b` — our pass-through is correct |
| Catalog metadata | All 33 have `{id, object, created, owned_by}`; **one** (`moonshotai/kimi-k3.1-pro`) also has `context_window`, `model_type`, `supports_structured_output`, `supports_thinking`, `supports_tools`. **No pricing anywhere.** |
| Model page (`build.nvidia.com/nvidia/nemotron-3-ultra-550b-a55b.md`) | Base URL and Bearer header match ours; context 1,048,576; `max_tokens` default 16384, max 32768 (**no `max_completion_tokens`**); `reasoning_content` in replies; rate limits "up to 40 rpm / 10,000 requests per day" |
| Reasoning wire shape | The page states snippets translate the UI field `reasoning_effort` into **`chat_template_kwargs`**; the literal request field is `chat_template_kwargs: {"enable_thinking":true,"force_nonempty_content":true}` — required when combining tool calls with reasoning |
| Special headers | No `x-nvidia-*` headers appear in pages or examples |
| Key creation | Requires sign-in at `build.nvidia.com/settings/api-keys` |

Inference, not verified without a key: whether raw `reasoning_effort` is ignored or rejected, whether an authenticated `/v1/models` returns richer metadata, and SSE framing details.

## 3. 9router comparison

`projects.old/9router/open-sse/providers/registry/nvidia.js` carries more NVIDIA-specific machinery: `timeoutMs: 90000`, `hasFree: true` with a developer-program notice, `apiKeyUrl: https://build.nvidia.com/settings/api-keys`, static embedding/TTS/STT endpoints, and `tests/unit/nvidia-params.test.js` proving it strips client metadata and aliases reasoning fields. Two of its choices are **not** worth copying: it validates keys against the public catalog (same bug as ours below), and its static capability table marks Nemotron reasoning models `tools:false` with a stale 128k context versus NVIDIA's published 1M.

## 4. What we get right

Base URL, Bearer auth and model ids match NVIDIA's own examples. `max_tokens` is correct; no special headers are needed. Replayed assistant reasoning uses `reasoning_content`, which 9router had to add a quirk for. No invented prices or measurements; card stays honest. All registry/guard surfaces exist, so `pnpm verify` stays green.

## 5. Gaps, ranked

1. **P0 — key validation is broken and health is misleading.** `/v1/models` is public, so it cannot validate a key. Our `NvidiaAdapter` has no `validateCredential`, so `POST /v1/connections/nvidia/check` throws `NOT_SUPPORTED` (`Kernel/API/src/routes/connections.ts:120-128`, `service.ts:4214`) and the modal's Check button can never report a valid key. Worse, `healthCheck()` reports `healthy` after reading a public catalog — **a bogus key looks healthy** (verified: HTTP 200 for `nvapi-bogus`). Fix: implement `validateCredential` with a minimal real `chat/completions` probe (state clearly that it costs a request), set `validateOnSave: true` at `service.ts:782`, and stop claiming credential verification from the catalog. The gateway's `probeConnection` `listModels` fallback (`service.ts:4237-4244`) is unsafe for this provider.
2. **P1 — reasoning controls are in the wrong shape.** We send `reasoning_effort` raw; NVIDIA documents translation into `chat_template_kwargs`. A caller asking for `none` cannot disable thinking, and `force_nonempty_content` (needed for tools + reasoning) is impossible because `providerOptions` are rejected. Fix: override `toRequestBody` (now `protected`) to map `low|medium|high|none` → `chat_template_kwargs` and allow a narrow `chat_template_kwargs` passthrough.
3. **P1 — the gateway transport is bypassed.** `own-provider-adapters.ts:59` and `service.ts:782` construct `NvidiaAdapter()` with no transport, so it uses the SDK's 30 s default vs the gateway's 120 s and DNS-rebinding check. A 550B reasoning turn can be cut off at 30 s. Fix: pass the gateway transport as done for aion-labs/ollama (`service.ts:761,769`).
4. **P2 — catalog metadata gaps.** `model-normalize.ts:70-105` ignores NVIDIA's published `supports_tools`/`supports_thinking`/`model_type`. Parse them; add only labelled `static-catalog` context values explicitly published on model pages, never invented prices.
5. **P2 — unconditional tool-forcing claim.** `caps.ts:67` grants forced `tool_choice` to every NVIDIA model even though NVIDIA publishes per-model `supports_tools` and 9router disables tools for Nemotron reasoning models. Scope or document it.
6. **P2 — test coverage.** Add a scripted-transport NVIDIA test for the exact request body and a public-catalog fixture; remove the blanket exemptions.
7. **P3 — card polish.** Point `apiKeysUrl` at `https://build.nvidia.com/settings/api-keys` instead of the homepage, and label the tier as a developer-program trial (40 rpm / 10k per day), not an unconditional free tier.

## 6. Verdict

The wire basics are right and the project's honesty rules held — no fake prices or capabilities were invented. The real defects are **validation** (any key looks healthy, Check cannot succeed), **reasoning wiring**, and the **30 s timeout bypass**. Those three are worth fixing; the rest are refinements.
