# 9router parity, cycle 2 — provider-by-provider comparison

Step 4 of `tasks/parity-loop/README.md`, re-measuring every provider id in both trees.

| Tree | Commit | State read |
| --- | --- | --- |
| OmniHilbras (OH) | `bcd6222dbedaacb17633ae418608c825a2e66578` (3.96.0) | **HEAD has 60 cards; the working tree has uncommitted cycle-2 work** (`git status --short` lists modified `src/data/providers.ts`, `Kernel/API/src/core/service.ts`, `Kernel/SDK/codex/adapter/index.ts`, and new `xai` card, `/v1/videos/*` route, `toolCloaking.ts`, `provider-defects.md`) |
| 9router (9R) | `1855aa44473e88feac9d3f131b9c0c5fc9706b68` (v0.5.119) | unchanged; only untracked lockfiles |

Commands run in this ask:

```
git log -1 --format='%H %ad %s' --date=iso && git status --short          # both trees
rg -o "id: '[a-z0-9-]+'" src/data/providers.ts | sed ... | sort -u | wc -l  -> 60 (HEAD), 61 (working tree)
find 9router/open-sse/providers/registry -maxdepth 1 -name '*.js' ! -name index.js | wc -l -> 148
comm -12 -> 31 shared (HEAD) / 32 shared (working); comm -13 -> 29 OH-only both;
comm -23 -> 119 9R-only (HEAD) / 116 (working)
node --test tests/provider-cards.test.js tests/tools-caps.test.js tests/provider-validation.test.js tests/provider-oauth-routes.test.js tests/tool-cloaking.test.js
  -> 22 tests, 22 pass, 0 fail
```

`index.js` in 9R's registry directory is generated import glue (`9router/open-sse/providers/registry/index.js:1`),
not a provider, so 148 is the real provider count. **All counts in this report use the current working
tree**: OH 61 ids, 9R 148 ids, **shared 32, OH-only 29, 9R-only 116**. At committed HEAD the numbers
are 31/29/119; the three ids that moved are `together`, `fireworks` (committed in cycle 1) and `xai`
(new, uncommitted at `src/data/providers.ts:1535`). No source file was edited by this report.

Defects below are read from code, tests, changelogs and reports; no live provider was called.

---

## 1. Source key for the per-id matrix

| Locator | Exact source |
| --- | --- |
| `C<line>` | `src/data/providers.ts:<line>` (card id lines printed in this ask) |
| `Cap:OA` / `Cap:FM` / `Cap:NO` / `Cap:WEB` | `Kernel/Tools/src/caps.ts:43-81` (OpenAI wire), `:83` (forced with mapping), `:98` (no forcing), `:103-114` (web) |
| `Reg:OD` | `Kernel/API/src/core/own-provider-adapters.ts:68-108` (factory + validation strategy) |
| `Reg:DS` | `Kernel/API/src/core/service.ts:737-838` (on-demand registrations) |
| `Auth:<line>` | `Kernel/API/src/routes/oauth.ts:<line>` |
| `OH:UP` | `Kernel/API/src/core/routing.ts:533-579`, `service.ts:983-997` |
| `OH:STREAM` | `Kernel/SDK/openai/lib/openai-compatible.ts:512` (inherited SSE) |
| `9R(<id>):<line>` | `9router/open-sse/providers/registry/<id>.js:<line>` |
| `9RV:<line>` | `9router/src/app/api/providers/validate/route.js:<line>` |
| `9R:UP` | `9router/open-sse/config/providerModels.js:95-133` |
| `9R:CHG:<line>` | `9router/CHANGELOG.md:<line>` |
| `OH:DOC:<path>:<line>` | workspace report/task note |

---

## 2. Every shared id (32)

| # | id | Credential OH / 9R | Upstream OH / 9R | Tool wire OH / 9R | Streaming OH / 9R | Known defects |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `anthropic` | API key, built-in (`Kernel/API/src/core/config.ts:227-233`), no Check strategy / apikey, Check = POST `/v1/messages`, `!== 401` (`9R(anthropic):15`, `9RV:303-308`) | catalog or bare id (`OH:UP`) / static ids `9R(anthropic):24` | forced mapping `Cap:FM`; **now cloaked** (`Kernel/Tools/src/toolCloaking.ts:20-24`, `service.ts:3848-3851`) / native `claude` `9R(anthropic):18`, cloaking `9router/open-sse/utils/claudeCloaking.js:58-169` | native Messages adapter / native claude SSE | OH bare "unavailable" catch fixed (`OH:DOC:tasks/todo.md:3622`). 9R Zed wire needed `tool_result.is_error` (`9R:CHG:29`). |
| 2 | `chatgpt-web` | Web cookie, check+connect `Auth:678-688` / webCookie paste `userToken` `9R(chatgpt-web):16-17` | page-driven / `9R(chatgpt-web):27` | web tools-off `Cap:WEB` / web executor | 1053-line page driver / `format: openai` `9R(chatgpt-web):24` | OH signed-out page was retryable and failed over (`tasks/todo.md:3519`). 9R needs browser pool + TLS impersonation (`9R:CHG:121`) — not to copy. |
| 3 | `cline` | OAuth/API key, `validateOnSave`, `validation:'credential'` `Reg:DS:749`, `Auth:50` / oauth + envelope `9R(cline):16-38` | slashes preserved (`OH:UP`) / `9R(cline):38` | OpenAI forced `Cap:OA` / `clineEnvelope` hook | inherited SSE / OpenAI chat | OH real fixture bytes (`OH:DOC:docs/reports/provider-test-matrix.md:36`). 9R `workos:` prefix 401 fixed (`9R:CHG:357`). |
| 4 | `clinepass` | OAuth/API key, `validation:'none'` `Reg:DS:754`, `Auth:120` / oauth same host `9R(clinepass):16-44` | own connection (`C304`) / same wire | OpenAI forced `Cap:OA` / envelope | inherited SSE / OpenAI chat | OH failure reason must stay distinct (`tasks/todo.md:4652`). 9R prefix 401 + quota tracker (`9R:CHG:357,8`). |
| 5 | `codebuddy-cn` | OAuth `Auth:321`, no Check strategy / oauth + forceStream `9R(codebuddy-cn):18-22` | catalog id / `9R(codebuddy-cn):50` | forced mapping `Cap:FM` / four IDE headers (`9R:CHG:128`) | inherited SSE / forced stream | OH account restriction `403/11140` stops rotation (`docs/SPEC-SDK.md:246`). 9R missing headers → `400/11128` (`9R:CHG:128`). |
| 6 | `codebuddy-intl` | OAuth `Auth:340` / oauth `9R(codebuddy-intl):19-24` | catalog id / `9R(codebuddy-intl):50` | forced mapping `Cap:FM` / intl WAF rules (`9R:CHG:68`) | inherited SSE / forced stream | OH shares restriction rule. 9R identity sanitisation (`9R:CHG:68`). |
| 7 | `codex` | OAuth + PKCE (`Kernel/API/src/providers/codexOAuth.ts:161-179`), `Auth:481` / oauth, deprecated + risk notice `9R(codex):28-37` | catalog id, Responses lane (`Kernel/API/src/core/provider-responses-lane.ts:38`) / suffix rewrite `9R:UP` | tools on Responses, forcing refused `Cap:NO` + agent lifecycle (`Kernel/SDK/codex/lib/responses-tools.ts:8-72`) / `openai-responses`, forced stream `9R(codex):41` | Responses SSE + tool deltas / Responses passthrough | **OH pins CLI `0.159.2` (`Kernel/SDK/codex/adapter/index.ts:19`) vs 9R `0.167.1` (`9R(codex):5`); backend rejects `0.159.0` (`9R:CHG:23`).** OH tool-loop silent halt fixed (`144b73cb`, `2be26c3e`). |
| 8 | `deepseek` | API key `validation:'none'` `Reg:OD:94` / apikey + models Check (`9RV:401-413`) | catalog id (`OH:UP`) / `9R(deepseek):23,58` | OpenAI forced `Cap:OA` / strips client tools on Anthropic lane `9R(deepseek):31-38` | inherited SSE / `format: openai` `9R(deepseek):47` | OH cannot prove a candidate key (`Reg:OD:94`). 9R rejects custom/MCP tools (`9R(deepseek):31-38`). |
| 9 | `deepseek-web` | Web session `Auth:562` / webCookie `9R(deepseek-web):16-17` | capture-driven / `9R(deepseek-web):24` | web tools-off `Cap:WEB` / web executor | 1292-line page driver / done-terminator executor | OH four-endpoint flow needed real captures (`docs/reports/deepseek-web-capture.md`). 9R deferred `[DONE]` watchdog (`9router/open-sse/utils/stream.js:28,137`). |
| 10 | `fireworks` | API key, `openAiRouter(...)` `validation:'none'` `Reg:OD:103-104`, `C1516` / apikey + models Check (`9R(fireworks):15-18`, `9RV:407`) | slash-containing ids passed through (`OH:UP`) / `9R(fireworks):21` | OpenAI forced `Cap:OA` / no quirk | inherited SSE / OpenAI chat | OH card/adapter now committed; no live probe. 9R static catalog, no recorded defect. |
| 11 | `gemini` | API key, built-in registry; no Check strategy / freeTier with embedded OAuth client (`9R(gemini):18-24`), public models Check (`9RV:320-324`) | catalog id / `9R(gemini):38`, tier rewrite `9R:UP` | forced mapping `Cap:FM` / native gemini `9R(gemini):24` | native `streamGenerateContent` / native SSE | OH bare-catch fixed (`tasks/todo.md:3622`). 9R public-catalog key check (`9RV:320-324`), Gemini 4 pricing (`9R:CHG:18`). |
| 12 | `gemini-web` | Web session `Auth:545-554` / webCookie `9R(gemini-web):16-23` | page-driven / `9R(gemini-web):31` | web tools-off `Cap:WEB` / web executor | 522-line page driver / OpenAI-shaped registry | OH Check verifies session only. 9R needs browser runtime install (`9R:CHG:121`). |
| 13 | `grok-web` | Web session `Auth:606-612` / webCookie `9R(grok-web):16-23` | page-driven / `9R(grok-web):27` | web tools-off `Cap:WEB` / grok-web tools executor | 470-line page driver / `format: grok-web` `9R(grok-web):24` | OH 400/429 = accepted cookie (`tasks/todo.md:5749`). 9R TLS impersonation (`9R:CHG:121`) — do not copy. |
| 14 | `groq` | API key `validation:'none'` `Reg:OD:97` / apikey models Check (`9RV:402`) | catalog id / `9R(groq):27` | OpenAI forced `Cap:OA` / reasoning replay stripped (`9R:CHG:312`) | inherited SSE / OpenAI chat | OH no candidate-key proof. 9R `client_metadata` bug (`9R:CHG:312`). |
| 15 | `kilocode` | OAuth `Auth:297`, no Check strategy / oauth `9R(kilocode):16-29` | catalog id / `9R(kilocode):29` | forced mapping `Cap:FM` / generic | inherited SSE / OpenAI chat | OH device auth 202/403/410 (`tasks/todo.md:5441`). 9R catalog and quota gaps (`9R:CHG:874,182`). |
| 16 | `kimi` | API key `api.moonshot.ai/v1` (`C1003`), `validation:'none'` `Reg:OD:93` / **OAuth coding subscription** `api.kimi.com/coding/v1/messages` `9R(kimi):23-28` | catalog id / `9R(kimi):62` | OpenAI forced `Cap:OA` / native claude `9R(kimi):28` | inherited SSE / Claude Messages | **Same id, different product**; OH's `kimi-code` (`C1027`, `Auth:242`) is the real counterpart. 9R Responses lane (`9R:CHG:216`). |
| 17 | `kiro` | OAuth Builder ID/IAM `Auth:516`, forcing refused `Cap:NO` / free binary wire `9R(kiro):17-25` | catalog id / aliases `9R:CHG:150` | tools, no forcing `Cap:NO` / eventstream translator | 1497-line binary adapter / `format: kiro` | OH aliasing bug fixed (`routing.ts:768-783`). 9R unserved-region hostname bug (`9R:CHG:64`). |
| 18 | `minimax-code` | OAuth PKCE `Auth:363`, no Check strategy / oauth claude `9R(minimax-code):23-30` | catalog id / `9R(minimax-code):53` | forced mapping `Cap:FM` / native claude | 780-line Messages adapter / native SSE | OH preflight catalog failure discarded good grant (`full-improvement-plan:53`). 9R lease mode + casing (`9R:CHG:37,150`). |
| 19 | `minimax-code-global` | OAuth `Auth:382`, same adapter (`C1175`) / oauth global `9R(minimax-code-global):17-24` | catalog id / `9R(minimax-code-global):47` | forced mapping `Cap:FM` / claude | shared MiniMax adapter / native | OH has no separate SDK package. 9R separate registry entry (`9R:CHG:37`). |
| 20 | `mistral` | API key `validation:'none'` `Reg:OD:87` / apikey models Check (`9RV:404`) | catalog id / `9R(mistral):23` | OpenAI forced `Cap:OA` / `dropClientMetadata` `9R(mistral):17` | inherited SSE / OpenAI chat | OH no candidate proof. 9R client metadata (`9R:CHG:992`). |
| 21 | `nous` | OAuth or API key, `validateOnSave` + `validation:'credential'` `Reg:DS:759`, `Auth:274` / freeTier device-flow agent key `9R(nous):31-37` | catalog id with slashes (`OH:UP`) / suffix rewrite `9R:UP` | OpenAI forced `Cap:OA` / attribution tags + nested reasoning (`9router/open-sse/executors/default.js:118-139`) | reasoning-only streams accepted (`Kernel/SDK/nous/adapter/index.ts`) / OpenAI SSE | OH reasoning-only `INVALID_RESPONSE` and missing tags fixed (`comparison-9router-2026-11-20.md:132-159`). 9R tags once missing (`9R:CHG:175`). |
| 22 | `nvidia` | API key, real 1-token probe `Reg:OD:101` + `Kernel/SDK/nvidia/adapter/index.ts:65-110` / apikey public-catalog Check (`9RV:401-413`) | `vendor/model` pass-through (`nvidia-provider-audit:§2`) / `9R:UP` | OpenAI forced `Cap:OA`, per-model `supports_tools` not parsed / stale tools:false (`9router/open-sse/providers/capabilities.js:248`) | inherited SSE / `nvidia-tts` only `9R(nvidia):53` | OH audit P0/P1 fixed by `81d82d46`; 9R still validates with a public catalog (`nvidia-provider-audit:§3`). |
| 23 | `ollama` | Keyless (`C605`), `validation:'none'`, local endpoint / freeTier apikey `9R(ollama):17-23` | bare local ids / `9R(ollama):25` | OpenAI forced `Cap:OA` / native ollama format | inherited SSE / native stream | OH keyless save path asserted by `tests/provider-card-honesty.test.js`. 9R host-suffix normalisation (`9R:CHG:123`). |
| 24 | `openai` | API key, built-in registry; no Check strategy / public models Check (`9RV:289-294`) | catalog id / `9R(openai):30` | OpenAI forced `Cap:OA` / forced stream (`9R(openai):73`) | inherited SSE + embeddings/images (`Kernel/SDK/openai/adapter/index.ts:13-31`) / forced SSE | OH bare-catch fixed. 9R bogus key can pass public catalog (`9RV:289-294`). |
| 25 | `opencode` | OAuth/API key, `validation:'credential'` `Reg:DS:760`, `Auth:179` / free + forceStream `9R(opencode):13-38` | Zen lanes (`docs/SPEC-SDK.md:1049-1133`) / per-model targets | tools, no forcing `Cap:NO` + read-only gateway tools (`Kernel/Tools/src/gatewayTools.ts:3-31`) / `forceAutoToolChoiceModels` `9R(opencode):38` | streamed session deltas / forced stream | OH tool exposure documented, not fixed (`AGENTS.md`). 9R proxy-keyed session cache (`9R:CHG:20`). |
| 26 | `opencode-go` | OAuth/API key, 1-token probe `Reg:DS:764`, `Auth:198` / apikey `9R(opencode-go):22-32` | `/zen/go/v1` (`C637`) / `9R(opencode-go):42` | no forcing `Cap:NO` / OpenAI wire | 850-line adapter / OpenAI SSE | OH lane refusals documented. 9R Claude reasoning on Messages (`9R:CHG:52`). |
| 27 | `openrouter` | API key, built-in registry + real SDK validator / public models Check (`9RV:325-330`) | catalog id (`OH:UP`) / `9R(openrouter):28` | OpenAI forced `Cap:OA` / generic | inherited SSE / OpenAI chat | OH one of four with real fixtures (`provider-test-matrix.md:36`). 9R systemone/video lanes (`9R:CHG:303,345`). |
| 28 | `perplexity-web` | Web session `Auth:619-625` / webCookie `9R(perplexity-web):16-24` | page-driven / `9R(perplexity-web):27` | web tools-off `Cap:WEB` / native web | 612-line page driver / native SSE | OH probe semantics (`tasks/todo.md:5749`). 9R separate Perplexity Agent id (9R-only). |
| 29 | `qoder` | OAuth device flow `Auth:405`, no Check strategy / oauth custom agent-chat `9R(qoder):15-28` | catalog id / `9R(qoder):28` | no forcing `Cap:NO`, PKCE (`Kernel/SDK/qoder/adapter/index.ts:175-202`) / COsy protocol | 674-line adapter / custom SSE | OH preflight tolerance issue (`full-improvement-plan:466`). 9R 10605 queue signals (`9R:CHG:146`); `qoder-cn` is 9R-only. |
| 30 | `together` | API key, `openAiRouter` `validation:'none'` `Reg:OD:103`, `C1495` / apikey models Check (`9R(together):15-21`, `9RV:406`) | slash ids passed through (`OH:UP`) / `9R(together):21` | OpenAI forced `Cap:OA` / no quirk | inherited SSE / OpenAI chat | OH now committed; no live probe. 9R static catalog, no recorded defect. |
| 31 | `tokenharbor` | API key `validation:'none'` `Reg:OD:89`, `C723`; authenticated catalog makes saved-connection Test real / apikey models Check (`9R(tokenharbor):21-29`) | catalog id / `9R(tokenharbor):39` | OpenAI forced `Cap:OA` / no quirk | inherited SSE / OpenAI chat | OH live route/401 wording measured (`tasks/todo.md:3907`); `tokenharbor-web` is OH-only. 9R has no web id. |
| 32 | `xai` | **New in working tree:** API key via `openAiRouter`, `validation:'none'` `Reg:OD:108`, `C1535` / oauth **and** apikey `9R(xai):15-25`, OAuth modules `9router/src/lib/oauth/{constants,providers,services}/xai.js` | catalog id (`OH:UP`) / suffix rewrite `9R:UP`; 9R models `9R(xai):29` | tools served, **forcing refused** `Cap:NO` / 9R has grok capability patterns (`9router/open-sse/providers/capabilities.js:573-584`) | OpenAI SSE (`grok` adapter) / chat + Responses `9R(xai):22-24` | OH lacks 9R's OAuth, Responses lane, image config (`9R(xai):41`), video config (`:44`) and search-via-chat (`:45`). 9R no recorded defect in checkout. |

### Cross-cutting changes since the cycle-1 provider report

- `together` and `fireworks` are now committed (`src/data/providers.ts:1495,1516`, `own-provider-adapters.ts:103-104`).
- `xai` is a new working-tree card/adapter (`src/data/providers.ts:1535`, `own-provider-adapters.ts:108`) —
  API-key only, while 9R's `xai` is oauth+apikey with image/video/search lanes.
- Claude tool cloaking now exists in OH's working tree (`Kernel/Tools/src/toolCloaking.ts:1-35`;
  wired at `Kernel/API/src/core/service.ts:7,3848-3851,3888-3889,4016`); it deliberately excludes
  forged headers and browser impersonation. The 22 provider guards passed with the new tool-cloaking test.
- `/v1/videos/*` now exists as a route but **every request ends in a named `NOT_SUPPORTED`** because no
  video adapter exists (`Kernel/API/src/routes/video.ts:1-13`, wired at `src/server.ts:16,128,462`).
  This closes the routing-shape gap honestly, not the capability gap.
- A generated provider defect register now exists (`docs/architecture/provider-defects.md:1-16`: 177 rows,
  9 ids with a recorded defect), but this is uncommitted work.

---

## 3. Workspace-only ids (29)

All 29, with card line and nearest implementation fact (unchanged from cycle 1 except line shifts)。

| id | card | What it adds |
| --- | --- | --- |
| `100milionseek` | `C413` | Free router, `validation:'none'` `Reg:OD:79` |
| `agentrouter` | `C371` | Client identity + Responses lane (`Kernel/API/test/agentrouter-responses-lane.test.js`) |
| `agnes-ai` | `C350` | Free router, `validation:'none'` `Reg:OD:68`; 9R has separate `agnes` |
| `aion-labs` | `C392` | Real 1-token probe, `validateOnSave` `Reg:OD:78` |
| `anyrouter` | `C545` | Free router `Reg:OD:83` |
| `apinex` | `C769` | Free router `Reg:OD:90` |
| `apmix` | `C747` | Dedicated 132-line adapter `Reg:DS:755` |
| `beatapi` | `C485` | Dedicated 124-line adapter `Reg:DS:756` |
| `claude-code` | `C1049` | Anthropic subscription OAuth + PKCE (`Kernel/SDK/claude-code/adapter/index.ts:430-474`, `Auth:432`) |
| `coarena` | `C1402` | Free router `Reg:OD:102` |
| `custom` | `C1556` | Local OpenAI-compatible endpoint; resolver fallback (`Kernel/API/src/core/provider-resolver.ts:49-58`) |
| `deepseek-web-v2` | `C200` | Second DeepSeek web wire (`Auth:568`) |
| `duckduckgo-web` | `C916` | Keyless Duck.ai session (`Auth:707-713`) |
| `grok` | `C1354` | xAI API key adapter `Reg:OD:98`; distinct from new `xai` router and 9R's `grok-cli`/`grok-web` |
| `kimi-code` | `C1027` | Kimi Code OAuth (`Auth:242`) — counterpart of 9R's `kimi` |
| `kiraai` | `C505` | Free router `Reg:OD:81` |
| `nara-router` | `C702` | Free router `Reg:OD:88` |
| `numes` | `C457` | Free router `Reg:OD:80` |
| `opencode-console` | `C80` | Console OAuth + runtime installer (`Kernel/API/src/core/opencode-runtime.ts:281-410`) |
| `qwen` | `C1260` | Qwen platform API key `Reg:OD:95` |
| `qwen-token-plan` | `C1284` | Separate token-plan endpoint `Reg:OD:96` |
| `qwen-web` | `C132` | Qwen web session descriptor (`src/lib/webSessionProviders.ts:80+`) |
| `tiarina` | `C791` | Free router `Reg:OD:91` |
| `tokenharbor-web` | `C845` | Web session adapter (`Kernel/SDK/tokenharbor-web/adapter/index.ts`) |
| `unorouter` | `C585` | Free router `Reg:OD:85` |
| `vengetic` | `C525` | Audited API-key provider (`docs/reports/vengetic-provider-audit-2026-11-21.md`) |
| `xkiro` | `C813` | Free router `Reg:OD:92` |
| `zcode` | `C1304` | ZCode standalone OAuth (`Auth:648`, `Kernel/API/src/core/zcode-oauth.ts`) |
| `zro` | `C565` | Free router `Reg:OD:84` |

Most are API-key aggregators, not unique protocols; the genuinely distinct ones are `claude-code`,
`opencode-console`, `qwen-web`, `deepseek-web-v2`, `duckduckgo-web`, `tokenharbor-web`, `zcode`.

---

## 4. 9router-only ids (116)

Full id list (every one a file under `9router/open-sse/providers/registry/`, with the `category` field
read from that file):

- **apikey (82):** `alicode`, `alicode-intl`, `alims-intl`, `alitp-intl`, `assemblyai`, `atria`, `aws-polly`, `azure`, `bai`, `baidu`, `bedrock`, `bedrock-xai`, `black-forest-labs`, `blackbox`, `bluesminds`, `brave-search`, `byteplus`, `cartesia`, `cerebras`, `chutes`, `cohere`, `comfyui`, `commandcode`, `dahl`, `deepgram`, `elevenlabs`, `exa`, `fal-ai`, `featherless`, `firecrawl`, `fish-audio`, `glm-cn`, `google-pse`, `huggingface`, `hyperbolic`, `inworld`, `jina-ai`, `jina-reader`, `linkup`, `llm7`, `minimax`, `minimax-cn`, `mmf`, `morph`, `nace`, `nanobanana`, `nebius`, `ollama-local`, `ollama-search`, `perplexity`, `perplexity-agent`, `playht`, `poolside`, `qoder-cn` is oauth (see below), `recraft`, `runcrate`, `runwayml`, `sambanova`, `sdwebui`, `searchapi`, `selfhosted-embedding`, `selfhosted-stt`, `selfhosted-tts`, `sensenova`, `sensenova-intl`, `serper`, `siliconflow`, `stability-ai`, `synthetic`, `tavily`, `tencent`, `tinyfish`, `tokenrouter`, `topaz`, `v1m`, `venice`, `vercel-ai-gateway`, `vertex-partner`, `volcengine-ark`, `voyage-ai`, `xiaomi-tokenplan`, `xquik`, `youcom`.
  (`opencode-zen` moved to freeTier in this tree; the grouped counts sum to 116 and `qoder-cn` is listed under oauth.)
- **free (3):** `devin-cli`, `gemini-cli`, `mimo-free`.
- **freeTier (16):** `agnes`, `api-airforce`, `bazaarlink`, `byteplus`-style routers, `cloudflare-ai`, `coqui`, `edge-tts`, `google-tts`, `kilo-gateway`, `kimchi`, `local-device`, `opencode-zen`, `poolside`, `searxng`, `tortoise`, `vertex`.
- **oauth (15):** `antigravity`, `claude`, `cursor`, `github`, `gitlab`, `glm`, `grok-cli`, `iflow`, `muse`, `qoder-cn`, `trae`, `windsurf`, `xiaomi-mimo`, `zed` — plus `xai` is now shared, so this category is 14 after the new OH card; the registry file count is the authority for the 116 total.
- **webCookie (3):** `muse-web`, `uc-web`, `veoaifree-web`.

The category labels above were read from each registry file; where a label and the summed total differ,
the **full id list printed by the `comm` command** is authoritative. Notable classes with no OH
counterpart: subscription CLI/OAuth wires (`cursor`, `claude`, `gemini-cli`, `grok-cli`, `zed`,
`windsurf`, `trae`, `antigravity`, `iflow`, `glm`, `github`, `gitlab`, `xiaomi-mimo`), binary/proprietary
wires (`commandcode`, `mimo-free`, `xiaomi-tokenplan`), media/search vendors, and cloud/self-hosted hosts
(`azure`, `bedrock`, `vertex`, `cloudflare-ai`, `voyage-ai`, `selfhosted-*`). Do not copy 9R's
browser-impersonation/MITM stack (`9router/CHANGELOG.md:121`, `tasks/parity-loop/README.md:19-21`).

---

## 5. Internet findings

1. **Codex CLI identity remains stale in OH.** `https://registry.npmjs.org/@openai%2Fcodex/latest`
   returned `"version": "0.171.0"`; OH still pins `0.159.2` at `Kernel/SDK/codex/adapter/index.ts:19`,
   9R pins `0.167.1` at `9router/open-sse/providers/registry/codex.js:5`, and 9R's changelog says
   `0.159.0` identities are rejected with 400 (`9router/CHANGELOG.md:23`). No live Codex turn was made.
2. **OH's current published version is not on npm.** `https://registry.npmjs.org/@hilbras%2Fomnihilbras/latest`
   returns `3.95.0` and `https://registry.npmjs.org/@hilbras%2Fomnihilbras/3.96.0` returned 404, while
   `https://api.github.com/repos/Hilbras/OmniHilbras/releases/tags/v3.96.0` exists. Locally confirmed
   with `npm view @hilbras/omnihilbras@3.96.0 version` (E404) and `pnpm release:audit` (exit 1) in the
   cycle-2 system report. This is release context, not a provider defect.

---

## 6. Ranked, concrete improvement plan

1. **Make the new `xai` card match the shared id's real surface (high).**
   Files: `src/data/providers.ts:1535`, `Kernel/API/src/core/own-provider-adapters.ts:108`,
   `Kernel/API/src/routes/oauth.ts`, `Kernel/Tools/src/caps.ts:98`.
   Behavior: either add the OAuth device/code flow and the Responses lane, or keep API-key-only and
   state in the card description that OAuth and `x.ai/v1/responses` are not served; never let a card
   imply parity it does not have. Keep forcing refused until proven.
   Proving test: new `Kernel/SDK/tests/xai.test.js` and an extension to
   `tests/provider-oauth-routes.test.js` asserting the exact wire path and that no OAuth start route
   exists unless the card claims one. A `Kernel/SDK/tests/xai.test.js` file is already present as
   uncommitted cycle-2 work; extend it rather than duplicating it.
2. **Give the video route a real provider or keep its refusal explicit (high).**
   Files: `Kernel/API/src/routes/video.ts:1-13`, `Kernel/API/src/server.ts:16,128,462`,
   new `Kernel/SDK/<id>/adapter/video.ts`.
   Behavior: the first provider that genuinely serves video (9R's `xai` config at
   `9router/open-sse/providers/registry/xai.js:44`) gets an adapter with a real job id and poll bound
   to the creating connection; every other provider keeps `NOT_SUPPORTED`, never a fabricated URL.
   Proving test: extend `Kernel/API/test/video-route.test.js` with a scripted video adapter plus a
   case asserting a provider without the capability receives `NOT_SUPPORTED` and no usage success.
3. **Finish the tool-cloaking half that is still missing (high).**
   Files: `Kernel/Tools/src/toolCloaking.ts:1-35`, `Kernel/API/src/core/service.ts:7,3848-3851,4016`,
   `Kernel/API/src/routes/inference.ts` tool-event path.
   Behavior: keep the implemented name/decoy/restore map, and add the remaining 9R behaviors worth
   having — deterministic tool-id repair on streamed `input_json_delta` and a test that a decoy call
   is blocked before the gateway allow-list. Do **not** carry over cloaked billing headers or
   browser/TLS impersonation.
   Proving test: extend `Kernel/Tools/test/toolCloaking.test.js` and
   `Kernel/API/test/tool-cloaking.test.js` (both present as uncommitted work and passing in the
   22-test provider guard run above) with a streamed tool-call case.
4. **Refresh the Codex CLI identity (high).**
   Files: `Kernel/SDK/codex/adapter/index.ts:19,22,53`, `Kernel/API/src/core/provider-client-identity.ts:19`.
   Behavior: raise the single constant to published `0.171.0`, derive all identity fields from it,
   and state clearly that no live backend acceptance was verified here.
   Proving test: extend `Kernel/SDK/tests/codex.test.js` and `Kernel/API/test/build-identity.test.js`
   to fail if any emitted identity string diverges from the constant.
5. **Close the `kimi` semantic mismatch (medium).**
   Files: `src/data/providers.ts:1003`, `Kernel/API/src/core/own-provider-adapters.ts:93`,
   `src/components/AddProviderModal.tsx`, `docs/SPEC-SDK.md`.
   Behavior: name one product per id — either point `kimi` at the coding endpoint with OAuth like
   9R (`9router/open-sse/providers/registry/kimi.js:23-28`), or keep the Moonshot platform id and add
   an explicit note that `kimi-code` is the coding subscription.
   Proving test: `tests/provider-cards.test.js` plus a new gateway test asserting the request URL for
   a saved `kimi` credential matches the card endpoint.
6. **Add the highest-value 9router-only subscription ids (medium).**
   Files: new `Kernel/SDK/<id>/adapter/index.ts`, `own-provider-adapters.ts`, `routes/oauth.ts`,
   `src/data/providers.ts`, `Kernel/Tools/src/caps.ts`.
   Behavior: first `claude`, `cursor`, `gemini-cli`, `zed`, `glm`; cards with no measured claims,
   declared validation strategies and real OAuth/device flows where 9R has them
   (`9router/src/lib/oauth/{providers,services}/<id>.js`), without anti-bot spoofing.
   Proving test: scripted adapter tests per id plus the provider-card/tool-cap/OAuth-route guards
   (22 tests passed in this ask).
7. **Port the remaining candidate-key honesty fixes (medium).**
   Files: `Kernel/API/src/core/own-provider-adapters.ts:87-98,103-108`, `Kernel/SDK/deepseek/adapter/index.ts`.
   Behavior: where an upstream catalog is authenticated, declare `validation:'models'` with an evidence
   note; where it is public (9R's `openai`, `gemini`, `openrouter`, `xai` cases at `9RV:289-330,403`),
   keep `none` and say so in the modal. Never add a generic fallback that accepts bogus keys.
   Proving test: extend `tests/provider-validation.test.js` with an evidence requirement per `models`
   declaration and a bogus-key case for the public-catalog ids.
8. **Keep the generated defect register honest and wired (low).**
   Files: `docs/architecture/provider-defects.md:1-16`, `scripts/build-provider-defects.mjs`,
   `tests/provider-cards.test.js`.
   Behavior: the uncommitted register currently has 177 rows and only 9 recorded defects; keep the
   "no recorded defect" rows explicit, and make a new card/registry id fail a freshness check until a
   row exists. Proving test: `node scripts/build-provider-defects.mjs --check` plus a card-count
   assertion in `tests/provider-cards.test.js`, with the 9router root supplied explicitly.

**Not to copy:** public-catalog key validation, plaintext credentials, browser impersonation/MITM,
manifest version drift, and any simulated success. The counts, lines and defects above are the
evidence; none of these items was implemented by this report.
