# 9router parity, cycle 1 — provider-by-provider comparison

Step 4 of `tasks/parity-loop/README.md`. Reads both trees as they stand **now**:

| Tree | Commit | Working tree |
| --- | --- | --- |
| OmniHilbras (OH) | `632eb79a62e4302d05427826275a334b357bc887` | **dirty**: the cycle-1 implementation is present as uncommitted edits and new files (`git status --short` lists 43 modified files including `src/data/providers.ts`, `Kernel/API/src/core/service.ts` and `Kernel/API/src/routes/mcp.ts`, plus new `together`/`fireworks` registrations and `virtual-smart-fusion.test.js`) |
| 9router (9R) | `1855aa44473e88feac9d3f131b9c0c5fc9706b68` | only untracked `pnpm-lock.yaml`, `pnpm-workspace.yaml` |

Commands that established this (run in this ask):

```
git log -1 --format='%H %ad %s' --date=iso                  # both trees
git status --short                                          # both trees
git show HEAD:src/data/providers.ts | rg -o "id: '[a-z0-9-]+'" | sed ... | sort -u | wc -l   -> 58
rg -o "id: '[a-z0-9-]+'" src/data/providers.ts | sed ... | sort -u | wc -l                       -> 60
find 9router/open-sse/providers/registry -maxdepth 1 -type f -name '*.js' | wc -l                -> 149
find ... ! -name 'index.js' | wc -l                                                              -> 148
LC_ALL=C comm -12 /tmp/9r_providers.txt /tmp/oh_ids2.txt | wc -l                                 -> 31
LC_ALL=C comm -13 ... -> 29 ; LC_ALL=C comm -23 ... -> 117
```

`index.js` in 9R's registry directory is an auto-generated import file
(`9router/open-sse/providers/registry/index.js:1`), **not a provider**, so the 149 files represent
**148 provider ids**. The counts used throughout are therefore:

| Set | OH working tree (60 ids) | 9R (148 ids) |
| --- | ---: | ---: |
| Shared | **31** | **31** |
| OH-only | **29** | — |
| 9R-only | — | **117** |

At committed HEAD the OH card list has 58 ids: shared **29**, OH-only **29**, 9R-only **119**.
The two ids that moved only because of uncommitted implementation work are `together` and
`fireworks` (`git diff src/data/providers.ts` adds their cards at working-tree lines 1495 and 1516;
`git diff Kernel/API/src/core/own-provider-adapters.ts` adds a shared
`openAiRouter(...)` factory with `validation: 'none'`). No provider file was edited by this report.

**Checks run in this ask** (nothing else is claimed as passed):

```
node --test tests/provider-cards.test.js tests/tools-caps.test.js tests/provider-validation.test.js tests/provider-oauth-routes.test.js
  -> 21 tests, 21 pass, 0 fail
node --test tests/9router-catalog.test.js       -> 4 skipped (path hardcoded to /home/gin/work/9router)
```

`pnpm verify`, the full suite, 9router's Vitest suite and all live provider probes were **not run**:
no live credential is available and the ask forbids source edits/publishing. Every "defect" below is
read from code, tests, `CHANGELOG.md`, `docs/` or `tasks/`, not from a live call.

---

## 1. Source key used by the per-id matrix

To keep the matrix readable, each cell carries short locators:

| Locator | Exact source |
| --- | --- |
| `C<line>` | `src/data/providers.ts:<line>` — card id line (list of all card lines printed above) |
| `Cap:OA` / `Cap:FM` / `Cap:NO` / `Cap:WEB` | `Kernel/Tools/src/caps.ts:41-77` (OpenAI wire), `:78-80` (forced with mapping), `:94` (no forcing), `:96-106` (web) |
| `Reg:OD` | `Kernel/API/src/core/own-provider-adapters.ts:68-104` (factory + declared validation strategy) |
| `Reg:DS` | `Kernel/API/src/core/service.ts:737-835` (on-demand registrations) |
| `Reg:BUILTIN` | `Kernel/API/src/core/config.ts:227-250` (built-in registry adapters) |
| `Auth:<line>` | `Kernel/API/src/routes/oauth.ts:<line>` (OAuth/web-cookie start/check/connect route) |
| `OH:UP` | `Kernel/API/src/core/routing.ts:533-579` (first-slash prefix, bare id, comparison key) and `service.ts:983-997,3903,3942,3955` (catalog `upstreamModelId` sent) |
| `OH:STREAM` | `Kernel/SDK/openai/lib/openai-compatible.ts:512` (inherited SSE for OpenAI-compatible adapters); specialized adapters named per row |
| `9R(<id>):<line>` | `9router/open-sse/providers/registry/<id>.js:<line>` — category/auth/format/baseUrl/models fields |
| `9RV:<line>` | `9router/src/app/api/providers/validate/route.js:<line>` — candidate-key check |
| `9R:UP` | `9router/open-sse/config/providerModels.js:95-133` (`getModelUpstreamId`, suffix/tier aware) |
| `9R:CAP` | `9router/open-sse/providers/capabilities.js:74-77,248-440` (provider/model capability rows) |
| `9R:CHG:<line>` | `9router/CHANGELOG.md:<line>` |
| `OH:DOC:<path>:<line>` | workspace report/task note |

Undefined behavior is not filled in: where a tree has no stated strategy, the matrix says `none`.

---

## 2. Every shared id (31)

Credential column = what a Check/save proves. Upstream column = how `provider/model` becomes the wire
model id. Tool column = declared wire/forcing. Streaming column = what the adapter actually emits.
Defects are recorded with the source that describes them.

| # | id | Credential OH / 9R | Upstream ids OH / 9R | Tool wire OH / 9R | Streaming OH / 9R | Known defects (source) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `anthropic` | API key, built-in registry `Reg:BUILTIN`; no Check strategy declared (`Reg` absent) / apikey, Check = POST `/v1/messages`, `status !== 401` (`9R(anthropic):15`, `9RV:303-308`) | catalog id or bare first-slash id (`OH:UP`) / static registry ids at `9R(anthropic):24` | forced with mapping `{type:"any"}` `Cap:FM`; native Anthropic adapter `C1447` / native `claude` format `9R(anthropic):18`, Claude Code cloaking `9router/open-sse/utils/claudeCloaking.js:58-169` | native Messages SSE (464-line adapter) / native `claude` SSE | OH: four adapters including anthropic returned bare "unavailable" from `catch {}`, fixed (`OH:DOC:tasks/todo.md:3622`). 9R: Zed Anthropic wire 400 without `tool_result.is_error` (`9R:CHG:29`). |
| 2 | `chatgpt-web` | Web cookie, check+connect `Auth:678-688`, no Check strategy / webCookie, auth hint paste `userToken` from localStorage (`9R(chatgpt-web):16-17`) | page-driven, no upstream id mapping in gateway / registry model list `9R(chatgpt-web):27` | `web: true`, tools off by contract `Cap:WEB` / web session executor, no tool contract | 1053-line page driver / `format: openai` registry `9R(chatgpt-web):24` with browser executor | OH: signed-out page used to be a retryable failure and failed over (`OH:DOC:tasks/todo.md:3519`); expiry stored inside credential JSON (`:3374`). 9R: needs shared browser pool + TLS impersonation (`9R:CHG:121`). |
| 3 | `cline` | OAuth or API key, `validation:'credential'`, `validateOnSave` `Reg:DS:749`; start `Auth:50` / oauth, `tokenUrl`/`refreshUrl` and `clineEnvelope` quirk `9R(cline):16-38` | catalog id; Cline ids contain slashes and are preserved (`OH:UP`) / registry models `9R(cline):38`, envelope unwrapped on non-stream chat | OpenAI wire with forcing `Cap:OA` / envelope quirk + `clineHeaders` hook `9R(cline):20-35` | inherited OpenAI SSE / OpenAI chat | OH: `workos:` prefix and one-shot refresh covered by SDK tests (`OH:DOC:tasks/todo.md:3364`); only Cline has real fixture bytes (`OH:DOC:docs/reports/provider-test-matrix.md:36`). 9R: `workos:` prefix gave 401 on every request, fixed (`9R:CHG:357`). |
| 4 | `clinepass` | OAuth or API key, `validation:'none'` `Reg:DS:754`; start `Auth:120` / oauth, same Cline host with separate account (`9R(clinepass):16-44`) | own connection; separate `connectionProviderId` semantics in OH (`C304`) / same registry wire as Cline | OpenAI wire with forcing `Cap:OA` / `clineEnvelope` | inherited OpenAI SSE / OpenAI chat | OH: ClinePass failure reason must stay distinct from Cline's (`OH:DOC:tasks/todo.md:4652`). 9R: `workos:` prefix 401 and missing refresh, fixed (`9R:CHG:357`); quota tracker added (`9R:CHG:8`). |
| 5 | `codebuddy-cn` | OAuth, start `Auth:321`, `validation:'none'` `Reg:DS` / oauth with `forceStream`, CN base `/v2/chat/completions` (`9R(codebuddy-cn):18-22`) | catalog id / static registry models `9R(codebuddy-cn):50` | forced with mapping `Cap:FM` / CN channel requires `X-Request-ID`, `X-Conversation-ID`, `X-Conversation-Request-ID`, `X-Conversation-Message-ID` (`9R:CHG:128`) | inherited OpenAI SSE / forced stream | OH: account restriction `403 {"code":11140}` stops the failover walk (`OH:DOC:docs/SPEC-SDK.md:246`). 9R: without those headers every call is `400 / 11128 "request illegal"` (`9R:CHG:128`); client identity sanitised for intl WAF (`9R:CHG:68`). |
| 6 | `codebuddy-intl` | OAuth, start `Auth:340` / oauth, intl base `9R(codebuddy-intl):19-24` | catalog id / `9R(codebuddy-intl):50` | forced with mapping `Cap:FM` / intl WAF identity rules (`9R:CHG:68`) | inherited OpenAI SSE / forced stream | OH: shares CN restriction rule (`docs/SPEC-SDK.md:246`). 9R: same missing-header 400 (`9R:CHG:128`). |
| 7 | `codex` | OAuth device/code flow via PKCE (`Kernel/API/src/providers/codexOAuth.ts:161-179`), start `Auth:481`; native `validateCredential` `Reg:DS` / oauth, registry marked `deprecated: true` with `RISK_NOTICE` (`9R(codex):28-37`) | catalog id; Responses lane via `providerResponsesPath` (`Kernel/API/src/core/provider-responses-lane.ts:38`) / `getModelUpstreamId` suffix rewrite `9R:UP`; review-model helpers | tools on Responses wire, forcing refused `Cap:NO`; Codex agent lifecycle `Kernel/SDK/codex/lib/responses-tools.ts:8-72` / `format: openai-responses`, forced stream `9R(codex):41` | native Responses SSE + tool deltas / Responses passthrough | **OH pins CLI `0.159.2` (`Kernel/SDK/codex/adapter/index.ts:19`) while 9R pins `0.167.1` (`9R(codex):5`) and its changelog says `0.159.0` identities are rejected with 400 (`9R:CHG:23`); npm latest is `0.171.0` (internet §6).** OH formerly ended tool loops silently, fixed (`144b73cb`, `2be26c3e`). |
| 8 | `deepseek` | API key, `validation:'none'` `Reg:OD:94` / apikey, Check = chat request to `/v1/models`-style compatible path (`9RV:401-413`) | catalog id, first-slash strip only (`OH:UP`) / `9R(deepseek):23,58` | OpenAI wire with forcing `Cap:OA` / registry quirk: Anthropic-compatible endpoint accepts only built-in `web_search_*`, strips client tools `9R(deepseek):31-38` | inherited OpenAI SSE / `format: openai` `9R(deepseek):47` | OH: generic key validation cannot prove a DeepSeek key (`Reg:OD:94`). 9R: custom/MCP tools are rejected upstream (`9R(deepseek):31-38`), PoW worker shipped separately (`9R:CHG:62`). |
| 9 | `deepseek-web` | Web session, connect `Auth:562`, `validation:'none'` / webCookie, paste `userToken` (`9R(deepseek-web):16-17`) | page/model map from capture `docs/reports/deepseek-web-capture.md` / static models `9R(deepseek-web):24` | web, tools off `Cap:WEB` / web executor | 1292-line page driver with done-terminator / `format: openai` `9R(deepseek-web):21`, dedicated `deepseek-web-done-terminator.js` executor | OH: four-endpoint flow and PoW hash needed real captures (`OH:DOC:docs/reports/deepseek-web-capture.md`, `9R:CHG:89`). 9R: deferred `[DONE]` and stall watchdog in `9router/open-sse/utils/stream.js:28,137`. |
| 10 | `fireworks` | API key, **uncommitted** `openAiRouter` with `validation:'none'` (`git diff Kernel/API/src/core/own-provider-adapters.ts:100-104`), card `C1516` / apikey, Check via `/v1/models` (`9R(fireworks):15-18`, `9RV:401-413`) | catalog id; `accounts/fireworks/...` ids contain slashes and are passed through (`OH:UP`) / static ids at `9R(fireworks):21` | OpenAI wire with forcing `Cap:OA` / no special quirk | inherited OpenAI SSE / OpenAI chat | OH: new and uncommitted; guard test now asserts it is a real chat adapter (`node --test tests/provider-cards.test.js` output above). 9R: static catalog only; no documented defect in this checkout. |
| 11 | `gemini` | API key, built-in registry `Reg:BUILTIN`; no Check strategy / `freeTier` with apikey **and** embedded OAuth client id/secret (`9R(gemini):18-24`), Check via `/v1/models?key=` (`9RV:320-324`) | catalog id / static ids `9R(gemini):38`, tier rewrite `9R:UP` | forced with mapping `toolConfig.functionCallingConfig.mode` `Cap:FM` / native gemini format `9R(gemini):24`, `9R:CAP:302` | native `streamGenerateContent` (416-line adapter) / native gemini SSE | OH: bare "unavailable" catch fixed (`tasks/todo.md:3622`); `/v1/models` URL collision with `:generateContent` in a test double (`:3625`). 9R: public-catalog key check accepts bogus keys (`9RV:320-324`); Gemini 4 pricing fixed (`9R:CHG:18`). |
| 12 | `gemini-web` | Web session, check/connect `Auth:545-554`, `validation:'none'` / webCookie `9R(gemini-web):16-23` | page-driven / static models `9R(gemini-web):31` | web, tools off `Cap:WEB` / web executor | 522-line page driver / `format: openai` registry | OH: Check routes verify the session, not model inference (`docs/SPEC-SDK.md:549-552` in the system report). 9R: web executor needs browser runtime install (`9R:CHG:121`). |
| 13 | `grok-web` | Web session, check/connect `Auth:606-612` / webCookie `9R(grok-web):16-23` | page-driven / static models `9R(grok-web):27` | web, tools off `Cap:WEB` / dedicated grok-web tools executor (`9router/open-sse/executors/grok-web-tools.js`) | 470-line page driver / `format: grok-web` `9R(grok-web):24` | OH: refused cookie is not stored; 400/429 means accepted credential refusing probe (`tasks/todo.md:5749`). 9R: TLS impersonation via `wreq-js` (`9R:CHG:121`), Grok 4.7 context advertised at 500k (`9R:CHG:147`). **Anti-bot spoofing is not to be copied.** |
| 14 | `groq` | API key, `validation:'none'` `Reg:OD:97` / apikey, Check via models (`9RV:401-413`) | catalog id / static `9R(groq):27` | OpenAI wire with forcing `Cap:OA` / replayed reasoning fields stripped (`9R:CHG:312`) | inherited OpenAI SSE / OpenAI chat | OH: generic Check cannot prove key ownership (`Reg:OD:97`). 9R: `client_metadata` and reasoning replay caused translator failures (`9R:CHG:312`). |
| 15 | `kilocode` | OAuth, start `Auth:297`, `validation:'none'` / oauth with gateway base `9R(kilocode):16-29` | catalog id / registry models `9R(kilocode):29` | forced with mapping `Cap:FM` / registry has no `format`, generic | inherited OpenAI SSE / OpenAI chat | OH: device auth answers `202`/`403`/`410` (`tasks/todo.md:5441`). 9R: catalog picker and free-credit quota gaps (`9R:CHG:874,182`). |
| 16 | `kimi` | API key at `api.moonshot.ai/v1` (`C1003`), `validation:'none'` `Reg:OD:93` / **OAuth coding subscription** at `api.kimi.com/coding/v1/messages` (`9R(kimi):23-28`) — different product | catalog id / Claude wire ids from coding catalog `9R(kimi):62` | OpenAI wire with forcing `Cap:OA` / native `claude` format `9R(kimi):28` | inherited OpenAI SSE / Claude Messages SSE | **This is a semantic mismatch: OH's `kimi` is the Moonshot platform API; 9R's `kimi` is Kimi Code. OH's `kimi-code` (`C1027`, OAuth `Auth:242`) is the equivalent of 9R's `kimi`.** 9R routes Responses clients to Kimi Code `/responses` (`9R:CHG:216`). |
| 17 | `kiro` | OAuth Builder ID / IAM Identity Center, start `Auth:516`, tools forcing refused `Cap:NO` / free category with binary format `9R(kiro):17-25` | catalog id; Kiro snapshot suffixes included / Anthropic ids normalised to Kiro aliases in 9R (`9R:CHG:150`) | tools served, forcing refused `Cap:NO` / Kiro eventstream translator | 1497-line binary eventstream adapter (`Kernel/SDK/kiro/adapter/index.ts`) / `format: kiro` | OH: id/connection aliasing bug fixed in routing (`Kernel/API/src/core/routing.ts:755-775`); fixtures pinned as `kiro-stream.bin` (`provider-test-matrix.md:36`). 9R: unserved regions spliced into hostnames, fixed (`9R:CHG:64`). |
| 18 | `minimax-code` | OAuth device flow with PKCE, start `Auth:363`, `validation:'none'` / oauth native Messages `9R(minimax-code):23-30` | catalog id / `9R(minimax-code):53` | forced with mapping `Cap:FM` / `claude` format | 780-line Messages adapter / native Messages SSE | OH: sign-in preflight catalog failure used to discard a good grant (`tasks/full-improvement-plan-2026-11-19.md:53`). 9R: desktop lease auth mode and MiniMax casing `minimax-m2.5` (`9R:CHG:37,150`). |
| 19 | `minimax-code-global` | OAuth, start `Auth:382`, same adapter/region override (`C1175`) / oauth global base `9R(minimax-code-global):17-24` | catalog id / `9R(minimax-code-global):47` | forced with mapping `Cap:FM` / `claude` | shared MiniMax Messages adapter / native | OH: no `Kernel/SDK/minimax-code-global` package — same adapter with a different base (`git diff service.ts` registration at `:765`). 9R: separate registry entry and lease-mode attribution (`9R:CHG:37`). |
| 20 | `mistral` | API key, `validation:'none'` `Reg:OD:87` / apikey, Check via models (`9RV:401-413`) | catalog id / `9R(mistral):23` | OpenAI wire with forcing `Cap:OA` / `dropClientMetadata: true` `9R(mistral):17` | inherited OpenAI SSE / OpenAI chat | OH: generic Check cannot prove key. 9R: `client_metadata` stripped (`9R:CHG:992`), replayed reasoning stripped (`9R:CHG:312`). |
| 21 | `nous` | OAuth (device flow) or API key, `validateOnSave` + `validation:'credential'` `Reg:DS:759`, start `Auth:274` / `freeTier` with device-flow agent key (`9R(nous):31-37`) | catalog id with embedded slashes; only dispatched prefix stripped (`OH:UP`) / suffix-aware `9R:UP` | OpenAI wire with forcing `Cap:OA` / attribution tags `product/client/user` (`9router/open-sse/executors/default.js:118-139`), nested reasoning (`9router/open-sse/translator/concerns/thinkingUnified.js:403-414`) | native adapter handles reasoning-only streams (`Kernel/SDK/nous/adapter/index.ts`) / `format: openai` `9R(nous):37` | OH: reasoning-only stream previously threw `INVALID_RESPONSE`; attribution tags and nested reasoning were missing — all fixed and asserted (`docs/reports/comparison-9router-2026-11-20.md:132-159`). 9R: attribution tags were missing once, fixed (`9R:CHG:175`); 401 classification documented (`tasks/todo.md:5852`). |
| 22 | `nvidia` | API key, 1-token **real** probe, `validateOnSave` + `validation:'credential'` `Reg:OD:101`, adapter `validateCredential` (`Kernel/SDK/nvidia/adapter/index.ts:65-110`) / apikey with `hasFree`, but Check via public catalog (`9RV:401-413`) | `vendor/model` passed through (`docs/reports/nvidia-provider-audit-2026-11-21.md:23`), tier rewrite in 9R (`9R:UP`) | OpenAI wire with forcing `Cap:OA`; per-model `supports_tools` not parsed / `dropClientMetadata`, NIM param strip, stale `tools:false` on Nemotron reasoning (`9router/open-sse/providers/capabilities.js:248`) | inherited OpenAI SSE / `format: nvidia-tts` only for TTS registry `9R(nvidia):53` | OH audit P0/P1/P2 were **fixed** by `81d82d46` (current adapter shows `chat_template_kwargs`, real probe, gateway transport). 9R still validates against a public catalog that answers 200 for a bogus key (`nvidia-provider-audit:§3`, `9R:CHG:27,83`). |
| 23 | `ollama` | Keyless (`credential:'none'`) `C605`, `validation:'none'`, local endpoint / `freeTier` apikey, Check via `/api/chat`-style compatible path (`9R(ollama):17-23`) | bare local model ids / registry models `9R(ollama):25` | OpenAI wire with forcing `Cap:OA` / `format: ollama` | inherited OpenAI SSE / native ollama stream | OH: keyless save path had to be expressible (`AGENTS.md` security rules; `tests/provider-card-honesty.test.js`). 9R: host suffix `/v1` normalisation for `ollama-local`, System One host path (`9R:CHG:123,96`). |
| 24 | `openai` | API key, built-in registry `Reg:BUILTIN`; no Check strategy / apikey, **public `/v1/models`** Check (`9RV:289-294`) | catalog id / `gpt-*` static ids `9R(openai):30`, suffix rewrite `9R:UP` | OpenAI wire with forcing `Cap:OA` / forced stream, thinking kept on tool-result turns (`9R:CHG:54`) | inherited OpenAI SSE + embeddings/images `Kernel/SDK/openai/adapter/index.ts:13-31` / `format: openai`, `forceStream` `9R(openai):73` | OH: bare "unavailable" catch fixed (`tasks/todo.md:3622`). 9R: public-catalog key check accepts a bogus key (`9RV:289-294`); same class as OH's old NVIDIA bug. |
| 25 | `opencode` | OAuth or API key, `validation:'credential'` `Reg:DS:760`, start `Auth:179` / free category, `forceStream`, free-lane tool declarations (`9R(opencode):13-38`) | Zen lane model ids and per-lane refusals (`docs/SPEC-SDK.md:1049-1133`) / per-model target formats (`9router/open-sse/providers/registry/opencode-zen.js:37-119`) | tools served, forcing refused `Cap:NO`; gateway declares read-only `glob/grep/read` (`Kernel/Tools/src/gatewayTools.ts:3-31`) / `forceAutoToolChoiceModels` for one contributor model `9R(opencode):38` | streamed `session.text.delta` + `session.reasoning.delta` (`Kernel/API/src/core/opencode-service.ts`) / forceStream + event translation | OH: tool scope and `external_directory` exposure documented, not fixed (`AGENTS.md`); local service install/adopt added after audit. 9R: proxy-pool keyed session cache, 429 retry (`9R:CHG:20`). |
| 26 | `opencode-go` | OAuth or API key, `validateOnSave` + `validation:'credential'` `Reg:DS:764`, start `Auth:198` / apikey base `/inference/go/openai/v1/...` `9R(opencode-go):22-32` | `/zen/go/v1` lane `C637` / `9R(opencode-go):42` | forcing refused `Cap:NO` / OpenAI wire | 850-line adapter / `format: openai` `9R(opencode-go):32` | OH: shares Zen's lane refusal rules (`docs/SPEC-SDK.md:1076-1121`). 9R: sends Claude reasoning on Messages transport (`9R:CHG:52`). |
| 27 | `openrouter` | API key, built-in registry `Reg:BUILTIN`, real validator in SDK (`Kernel/SDK/openrouter/adapter/index.ts`) / freeTier apikey, public `/v1/models` Check (`9RV:325-330`) | catalog id, provider prefix stripped only when connected (`OH:UP`) / `9R(openrouter):28` | OpenAI wire with forcing `Cap:OA` / generic | inherited OpenAI SSE / OpenAI chat | OH: one of four adapters with real fixture bytes (`provider-test-matrix.md:36`). 9R: public-catalog key check (`9RV:325-330`); System One and video lanes exist beyond chat (`9R:CHG:303,345`). |
| 28 | `perplexity-web` | Web session, check/connect `Auth:619-625` / webCookie `9R(perplexity-web):16-24` | page-driven / static models `9R(perplexity-web):27` | web, tools off `Cap:WEB` / `format: perplexity-web` | 612-line page driver / native SSE | OH: 400/429 from probe means accepted cookie, not failure (`tasks/todo.md:5749`). 9R: separate Perplexity Agent API provider exists but is 9R-only (`9R:CHG:784`). |
| 29 | `qoder` | OAuth device flow, start `Auth:405`, `validation:'none'` / oauth, custom agent-chat base `9R(qoder):15-28` | catalog id / `9R(qoder):28` | forcing refused `Cap:NO`; PKCE `Kernel/SDK/qoder/adapter/index.ts:175-202` / custom COsy protocol | 674-line adapter / custom SSE | OH: preflight catalog read must tolerate failure (`tasks/full-improvement-plan-2026-11-19.md:466`). 9R: 10605 queue-capacity treated as transient, disabled catalog entries (`9R:CHG:146,21`); separate `qoder-cn` id (9R-only). |
| 30 | `together` | API key, uncommitted `openAiRouter` `validation:'none'` (`git diff own-provider-adapters.ts:100-104`), card `C1495` / apikey, Check via `/v1/models` (`9R(together):15-21`, `9RV:401-413`) | `meta-llama/...` ids with slashes preserved (`OH:UP`) / static ids `9R(together):21` | OpenAI wire with forcing `Cap:OA` / no quirk | inherited OpenAI SSE / OpenAI chat | OH: new and uncommitted; no live probe. 9R: static catalog, no documented defect in this checkout. |
| 31 | `tokenharbor` | API key, `validation:'none'` `Reg:OD:89`, card `C723`; **authenticated** catalog so saved-connection Test is real (`docs/reports/vengetic-provider-audit-2026-11-21.md:3` discusses the distinction) / apikey, Check via models (`9R(tokenharbor):21-29`) | catalog id / static `9R(tokenharbor):39` | OpenAI wire with forcing `Cap:OA` / no quirk | inherited OpenAI SSE / OpenAI chat | OH: live `/v1` route and 401 wording measured; `/api/v1` 404s and `/models` returns HTML (`tasks/todo.md:3907`); separate web session `tokenharbor-web` is OH-only. 9R: no separate web-session id. |

### Cross-cutting observations from the matrix

1. **Credential validation is more honest in OH but narrower.** OH declares a strategy beside every
   factory (`Reg:OD`, `Reg:DS`) and refuses a Check for `none` (`service.ts:4627-4632`); 9R's
   `9RV:289-413` uses public `/v1/models` reads for `openai`, `gemini`, `openrouter`, `deepseek`,
   `groq`, `mistral`, `together`, `fireworks`, `ollama` — a bogus key can be reported valid. The two
   newest OH adapters inherit `validation:'none'` for that same reason.
2. **Upstream IDs are at parity on the general algorithm but not on provider quirks.** OH strips one
   connected prefix and honours catalog `upstreamModelId` (`OH:UP`); 9R additionally rewrites
   thinking tiers and suffix variants (`9R:UP`). Kiro/Codex/Anthropic have per-model alias tables in
   9R (`9R:CHG:150`, `9R(codex):55`) that OH does not reproduce.
3. **Tool wire is asserted in OH andquirky in 9R.** OH has one row per id (`Cap:*`) with a guard test
   that passed here (21/21); 9R carries provider-specific tool repairs (Cline envelope, DeepSeek
   tool stripping, CodeBuddy headers, Claude cloaking, OpenCode forced-auto models) that OH has not
   ported. The web-session ids are tools-off in both.
4. **Streaming formats are mostly at parity for chat**, with 9R ahead for Codex Responses passthrough,
   Kiro binary stream, and free-tier OpenCode event translation; OH ahead for explicit stall budgets
   and for reasoning-only Nous streams.
5. **Defect knowledge is asymmetric.** 9R's `CHANGELOG.md` is a dense, provider-specific incident log
   (Cline prefix, CodeBuddy headers, NVIDIA params, Qoder queue, DeepSeek tools). OH's records are
   honest but concentrated in `tasks/todo.md`, `docs/reports/` and tests; no single per-provider defect
   register exists.

---

## 3. Workspace-only ids (29)

All 29 are listed. `src/data/providers.ts` card line and the nearest implementation fact are given.

| id | card | What it adds that 9R has no id for |
| --- | --- | --- |
| `100milionseek` | `C413` | Free-tier API-key router, OpenAI-compatible `own('100milionseek')`, `validation:'none'` (`Reg:OD:79`) |
| `agentrouter` | `C371` | Router with client identity and its own Responses lane (`Kernel/SDK/agentrouter/adapter/index.ts`, `Kernel/API/test/agentrouter-responses-lane.test.js`) |
| `agnes-ai` | `C350` | Free-tier router, `validation:'none'` (`Reg:OD:68`); 9R has a separate `agnes` id |
| `aion-labs` | `C392` | Real 1-token credential probe, `validateOnSave` (`Reg:OD:78`, `Reg:DS:810`) |
| `anyrouter` | `C545` | Free-tier router (`Reg:OD:83`) |
| `apinex` | `C769` | Free-tier router (`Reg:OD:90`) |
| `apmix` | `C747` | Dedicated 132-line adapter with `validation:'none'` (`Reg:DS:755`) |
| `beatapi` | `C485` | Dedicated 124-line adapter with `validation:'none'` (`Reg:DS:756`) |
| `claude-code` | `C1049` | Anthropic subscription OAuth with PKCE (`Kernel/SDK/claude-code/adapter/index.ts:430-474`, `Auth:432`); 9R has `claude` instead |
| `coarena` | `C1402` | Free-tier router (`Reg:OD:102`) |
| `custom` | `C1535` | Local OpenAI-compatible endpoint; resolver fallback exists precisely for it (`provider-resolver.ts:49-58`) |
| `deepseek-web-v2` | `C200` | Second DeepSeek web wire with its own connect route (`Auth:568`) |
| `duckduckgo-web` | `C916` | Keyless Duck.ai session; optional cookie (`Auth:707-713`) |
| `grok` | `C1354` | xAI API key (`Reg:OD:98`); 9R has `grok-cli` and `grok-web` but no `grok` API id |
| `kimi-code` | `C1027` | Kimi Code OAuth (`Auth:242`) — the actual counterpart of 9R's `kimi` |
| `kiraai` | `C505` | Free-tier router (`Reg:OD:81`) |
| `nara-router` | `C702` | Free-tier router (`Reg:OD:88`) |
| `numes` | `C457` | Free-tier router (`Reg:OD:80`) |
| `opencode-console` | `C80` | Console OAuth + local service/runtime installer (`Kernel/API/src/core/opencode-runtime.ts`); 9R has `opencode` and `opencode-zen` only |
| `qwen` | `C1260` | Qwen platform API key (`Reg:OD:95`); 9R has no `qwen` id |
| `qwen-token-plan` | `C1284` | Separate token-plan endpoint (`Reg:OD:96`) |
| `qwen-web` | `C132` | Qwen web session descriptor (`src/lib/webSessionProviders.ts:80+`) |
| `tiarina` | `C791` | Free-tier router (`Reg:OD:91`) |
| `tokenharbor-web` | `C845` | Token Harbor web session with its own adapter (`Kernel/SDK/tokenharbor-web/adapter/index.ts`) |
| `unorouter` | `C585` | Free-tier router (`Reg:OD:85`) |
| `vengetic` | `C525` | Audited API-key provider, authenticated catalog (`docs/reports/vengetic-provider-audit-2026-11-21.md`) |
| `xkiro` | `C813` | Free-tier router (`Reg:OD:92`) |
| `zcode` | `C1304` | ZCode standalone OAuth (`Auth:648`, `Kernel/API/src/core/zcode-oauth.ts`) |
| `zro` | `C565` | Free-tier router (`Reg:OD:84`) |

Most OH-only ids are API-key aggregators reachable by 9R's generic OpenAI-compatible path under a
different vendor id; they are **not** evidence of 29 unique upstream protocols. The genuinely
distinct ones are `claude-code`, `opencode-console`, `qwen-web`, `deepseek-web-v2`, `duckduckgo-web`,
`tokenharbor-web`, `zcode` and the two web-Qwen/DeepSeek variants.

---

## 4. 9router-only ids (117)

Category counts come from the registry `category` field; the one file named `index.js` is excluded
because it is generated glue. Full id list by category:

**apikey (82)** — `alicode`, `alicode-intl`, `alims-intl`, `alitp-intl`, `assemblyai`, `atria`,
`aws-polly`, `azure`, `bai`, `baidu`, `bedrock`, `bedrock-xai`, `black-forest-labs`, `blackbox`,
`bluesminds`, `brave-search`, `cartesia`, `cerebras`, `chutes`, `cohere`, `comfyui`, `commandcode`,
`dahl`, `deepgram`, `elevenlabs`, `exa`, `fal-ai`, `featherless`, `firecrawl`, `fish-audio`, `glm-cn`,
`google-pse`, `huggingface`, `hyperbolic`, `inworld`, `jina-ai`, `jina-reader`, `linkup`, `llm7`,
`minimax`, `minimax-cn`, `mmf`, `morph`, `nace`, `nanobanana`, `nebius`, `ollama-local`,
`ollama-search`, `opencode-zen`, `perplexity`, `perplexity-agent`, `playht`, `recraft`, `runcrate`,
`runwayml`, `sambanova`, `sdwebui`, `searchapi`, `selfhosted-embedding`, `selfhosted-stt`,
`selfhosted-tts`, `sensenova`, `sensenova-intl`, `serper`, `siliconflow`, `stability-ai`, `synthetic`,
`tavily`, `tencent`, `tinyfish`, `tokenrouter`, `topaz`, `v1m`, `venice`, `vercel-ai-gateway`,
`vertex-partner`, `volcengine-ark`, `voyage-ai`, `xiaomi-tokenplan`, `xquik`, `youcom`.
(82 names; every one is a file under `9router/open-sse/providers/registry/`.)

**free (3)** — `devin-cli`, `gemini-cli`, `mimo-free`.

**freeTier (15)** — `agnes`, `api-airforce`, `bazaarlink`, `byteplus`, `cloudflare-ai`, `coqui`,
`edge-tts`, `google-tts`, `kilo-gateway`, `kimchi`, `local-device`, `poolside`, `searxng`, `tortoise`,
`vertex`.

**oauth (15)** — `antigravity`, `claude`, `cursor`, `github`, `gitlab`, `glm`, `grok-cli`, `iflow`,
`muse`, `qoder-cn`, `trae`, `windsurf`, `xai`, `xiaomi-mimo`, `zed`.

**webCookie (2)** — `muse-web`, `uc-web`.

Notable capability classes with no OH counterpart (evidence in the named files):

- **Subscription CLI/OAuth wires:** `cursor` (`9router/open-sse/executors/cursor.js`),
  `gemini-cli`, `grok-cli`, `devin-cli`, `zed`, `windsurf`, `trae`, `antigravity`, `iflow`,
  `claude`, `glm`, `github`, `gitlab`, `xiaomi-mimo`. OH has no card, adapter or OAuth route for any
  of them; 9R has both registry entries and `src/lib/oauth/<id>.js` modules for most.
- **Binary/proprietary inference:** `commandcode` (NDJSON `/alpha/generate`),
  `antigravity`, `mimo-free`, `xiaomi-tokenplan` — 15 dedicated executors in
  `9router/open-sse/executors/` beyond the shared `base.js`.
- **Media/search families:** `elevenlabs`, `deepgram`, `assemblyai`, `aws-polly`, `edge-tts`,
  `fal-ai`, `black-forest-labs`, `runwayml`, `stable diffusion` (`stability-ai`), `brave-search`,
  `tavily`, `exa`, `serper`, `searxng`, `jina-reader`, `firecrawl`. OH serves audio speech/STT and
  one DuckDuckGo search route (`Kernel/API/src/routes/media.ts:13,51,85`) but has no per-vendor media
  registry.
- **Cloud/self-hosted model hosts:** `azure`, `bedrock`, `vertex`, `cloudflare-ai`, `sambanova`,
  `nebius`, `siliconflow`, `together`-like routers, `ollama-local`, `selfhosted-*`.
- **Duplicate vendor variants OH already covers under one id:** `opencode-zen` (OH `opencode`),
  `agnes` (OH `agnes-ai`), `minimax` (OH `minimax-code`), `perplexity` (OH `perplexity-web`),
  `qoder-cn` (OH `qoder` with region selection), `muse-web` and `uc-web` (OH has several web
  sessions but neither vendor).

**Do not copy:** 9R's web executors use TLS/browser impersonation (`9R:CHG:121`) and its MITM stack;
the parity loop's safety rule (`tasks/parity-loop/README.md:19-21`) forbids copying anti-bot spoofing.
A provider that refuses a request must report the refusal, not forge a client identity.

---

## 5. Internet findings (trees cannot supply these)

1. **Codex CLI version drift is real in both trees.** `https://registry.npmjs.org/@openai%2Fcodex/latest`
   returned `"version": "0.171.0"`. OH pins `0.159.2` (`Kernel/SDK/codex/adapter/index.ts:19`), 9R
   pins `0.167.1` (`9router/open-sse/providers/registry/codex.js:5`) and its changelog says the
   backend rejects `0.159.0` identities with 400 (`9R:CHG:23`). 9R is closer but also stale.
2. **Claude tool-use documentation has moved.** `https://docs.anthropic.com/en/docs/build-with-claude/tool-use`
   redirects (301) to `https://platform.claude.com/docs/en/build-with-claude/tool-use`, titled "Tool
   use with Claude". Its fetched text shows table labels `auto, none` and `any, tool`; it did **not**
   provide an exact statement that `is_error` is required, so that 9R changelog claim (`:29`) is
   reported as a 9R code fact, not an internet-confirmed requirement.

---

## 6. Ranked, concrete improvement plan

Each item names files, the behavior to add and a proving test. Ordered by user-visible impact and by
how directly it closes the shared-id matrix; no item requires a live key.

1. **Unify the `kimi` identity before anything else (high).**
   Files: `src/data/providers.ts:1003` (`kimi` card), `Kernel/API/src/core/own-provider-adapters.ts:93`,
   `src/components/AddProviderModal.tsx`, `docs/SPEC-SDK.md`, `docs/architecture/9router-provider-catalog.md`.
   Behavior: make `kimi` name one product unambiguously — either point it at the coding endpoint with
   an OAuth route like 9R's `9R(kimi):23-28`, or keep the Moonshot platform id and add an explicit
   alias note plus a card description that says which product a saved key belongs to. Do not silently
   route a platform key to `api.kimi.com/coding/v1/messages`.
   Proving test: extend `tests/provider-cards.test.js` and `tests/provider-detail-display.test.js` to
   assert the card endpoint, auth mode and the adapter base URL agree, and add a
   `Kernel/API/test/kimi-identity.test.js` that saves one credential and asserts the exact request URL.

2. **Refresh the Codex CLI identity (high).**
   Files: `Kernel/SDK/codex/adapter/index.ts:19,22,53`, `Kernel/API/src/core/provider-client-identity.ts:19`.
   Behavior: raise the pinned CLI version to one the backend accepts (latest published is `0.171.0`),
   keep the version in one constant, and make the User-Agent and `version` field use it. Do not claim
   `0.171.0` is proven to work without a live turn; state that the value is the registry latest.
   Proving test: extend `Kernel/SDK/tests/codex.test.js` and `Kernel/API/test/build-identity.test.js`
   to fail when the literal is older than a value supplied by an env/constant, and assert the wire
   headers carry the same string.

3. **Port 9R's provider-specific tool assertions to the asserted caps model (high).**
   Files: `Kernel/SDK/deepseek/adapter/index.ts`, `Kernel/SDK/codebuddy/adapter/index.ts`,
   `Kernel/Tools/src/normalize.ts`, `Kernel/Tools/src/providerRegistry.ts`.
   Behavior: for `deepseek`, refuse client-defined tools on the Anthropic-compatible lane with a
   named `NOT_SUPPORTED` instead of letting upstream reject them (`9R(deepseek):31-38`); for
   `codebuddy-cn/intl`, send the four IDE request/conversation headers 9R sends (`9R:CHG:128`) so the
   gateway's channel check does not answer `400 / 11128`; keep the decisions in provider adapters,
   not in Core.
   Proving test: new `Kernel/SDK/tests/deepseek-tools.test.js` and
   `Kernel/API/test/codebuddy-headers.test.js` with scripted transports asserting the exact body and
   headers, plus a case that a refusal is surfaced rather than retried.

4. **Add a shared per-provider defect register backed by a test (medium).**
   Files: new `docs/architecture/provider-defects.md`, `scripts/build-provider-defects.mjs` (or a
   checked-in JSON), `tests/9router-catalog.test.js` pattern.
   Behavior: one row per shared/provider id with `id`, `known failure`, `source path:line`,
   `status` (open/fixed/9R-only) and `proving test`. Generate it from the registry/cards so a new id
   without a row fails. This closes the current asymmetry where 9R's `CHANGELOG.md` is searchable and
   OH's knowledge is spread over `tasks/todo.md` and reports.
   Proving test: extend `tests/provider-cards.test.js` to fail when an id has no defect-register row,
   and pin the row count to the card count.

5. **Make candidate-key checks honest for the remaining shared ids (medium).**
   Files: `Kernel/API/src/core/own-provider-adapters.ts:87-98` (`mistral`, `groq`, `deepseek`,
   `kimi`, `qwen`, `together`, `fireworks`), `Kernel/SDK/deepseek/adapter/index.ts`.
   Behavior: where the upstream catalog is authenticated (Vengetic is the measured example in
   `docs/reports/vengetic-provider-audit-2026-11-21.md`), declare `validation:'models'` with an
   evidence note; where it is public, keep `none` and say so in the modal. Never add a generic
   fallback that would make a bogus key look valid.
   Proving test: `tests/provider-validation.test.js` already asserts "every on-demand registration
   states what a Check may prove" (21/21 run above); extend it with an explicit evidence-file
   requirement for each `models` declaration and a bogus-key case for the public-catalog ids.

6. **Close the high-value 9router-only CLI/OAuth ids (medium, staged).**
   Files: new `Kernel/SDK/<id>/adapter/index.ts`, `Kernel/API/src/core/own-provider-adapters.ts`,
   `Kernel/API/src/routes/oauth.ts`, `src/data/providers.ts`, `Kernel/Tools/src/caps.ts`.
   Behavior: first `claude`, `cursor`, `gemini-cli`, `zed`, `glm` — cards with no measured claims,
   a declared validation strategy, and real OAuth/device flows where 9R has them
   (`9router/src/lib/oauth/<id>.js`). Do not copy browser impersonation or MITM.
   Proving test: per-id scripted adapter tests plus `tests/provider-cards.test.js`,
   `tests/tools-caps.test.js` and `tests/provider-oauth-routes.test.js` (all runnable locally).

7. **Port the 9R capability quirks that affect correctness, not breadth (low).**
   Files: `Kernel/API/src/core/modelCapabilities.ts`, `Kernel/API/src/core/routing.ts:573-579`,
   `Kernel/SDK/nvidia/adapter/index.ts`.
   Behavior: parse per-model `supports_tools`/`supports_thinking` already present in some upstream
   catalogs (`docs/reports/nvidia-provider-audit-2026-11-21.md:§5.4`) and refine `narrowedToolCaps`
   accordingly; add suffix/tier-aware upstream-id resolution for Codex and Anthropic ids where the
   catalog supplies tier variants (`9R:UP`).
   Proving test: extend `Kernel/API/test/model-capabilities.test.js` and
   `Kernel/API/test/model-meta-round-trip.test.js` with tiered ids and a `supports_tools:false` entry.

**Explicitly excluded from the plan:** plaintext credential storage, public-catalog key validation,
anti-bot/TLS spoofing, fabricated streaming or success states, and any "test" that uses a live key
this machine does not have. The counts, locators and defects above are the evidence for these items;
none of them has been implemented by this report.
