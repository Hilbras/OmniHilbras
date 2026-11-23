# 9router parity, cycle 4 — provider-by-provider comparison

Step 4 of `tasks/parity-loop/README.md`, re-measuring every provider id in both trees.

| Tree | Commit | State read |
| --- | --- | --- |
| OmniHilbras (OH) | `6a4484d48d0139df5120408cee1b830f13467bea` (2026-11-23 11:10:56 +0300, "Repair the v3.97.0 tag's version mismatch by committing the missing bump") | working tree dirty with five new OpenAI-compatible router cards/adapters and guard edits; 67 cards |
| 9router (9R) | `1855aa44473e88feac9d3f131b9c0c5fc9706b68` (v0.5.119) | unchanged; 148 registry entries excluding generated `index.js` |

Commands run in this ask:

```
git log -1 --format='%H %ad %s' --date=iso && git status --short                    # both trees
rg -o "id: '[a-z0-9-]+'" src/data/providers.ts | sed ... | sort -u | wc -l          -> 67
find 9router/open-sse/providers/registry -name '*.js' ! -name index.js | wc -l      -> 148
comm -12 -> 38 shared ; comm -13 -> 29 OH-only ; comm -23 -> 110 9R-only
node --test tests/provider-cards.test.js tests/tools-caps.test.js tests/provider-validation.test.js tests/provider-oauth-routes.test.js tests/tool-cloaking.test.js
  -> 26 tests, 26 pass, 0 fail
```

Counts use the current working tree: OH 67 ids, 9R 148 ids, **shared 38, OH-only 29, 9R-only 110**.
`9router/open-sse/providers/registry/index.js:1` is generated import glue, not a provider. Cycle 4
added five shared ids relative to cycle 3: `sambanova`, `cerebras`, `siliconflow`, `nebius`,
`perplexity` (`diff /tmp/oh_c3p.txt /tmp/oh_c4p.txt`). No source was edited by this report; no live
provider was called.

## 1. Source key

| Locator | Exact source |
| --- | --- |
| `C<line>` | `src/data/providers.ts:<line>` |
| `Cap:OA` / `Cap:FM` / `Cap:NO` / `Cap:WEB` | `Kernel/Tools/src/caps.ts:43-87`, `:88`, `:103`, `:122-132` |
| `Reg:OD` | `Kernel/API/src/core/own-provider-adapters.ts:68-114` |
| `Reg:DS` | `Kernel/API/src/core/service.ts:737-862` |
| `Auth:<line>` | `Kernel/API/src/routes/oauth.ts:<line>` |
| `OH:UP` | `Kernel/API/src/core/routing.ts:533-579`, `service.ts:983-997` |
| `9R(<id>):<line>` | `9router/open-sse/providers/registry/<id>.js:<line>` |
| `9RV:<line>` | `9router/src/app/api/providers/validate/route.js:<line>` |
| `9R:UP` | `9router/open-sse/config/providerModels.js:95-133` |
| `9R:CHG:<line>` | `9router/CHANGELOG.md:<line>` |

---

## 2. Every shared id (38)

| # | id | Credential OH / 9R | Upstream OH / 9R | Tool wire OH / 9R | Streaming OH / 9R | Known defects / differences |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `anthropic` | API key built-in (`Kernel/API/src/core/config.ts:227-233`) / apikey Check `9RV:303-308` | catalog or bare id (`OH:UP`) / static `9R(anthropic):24` | forced mapping `Cap:FM`, cloaked (`Kernel/Tools/src/toolCloaking.ts:19-35`, `service.ts:3848-3851`) / claude + cloaking `9R(anthropic):18` | native Messages SSE / native claude SSE | OH bare-catch fixed (`tasks/todo.md:3622`); 9R Zed `tool_result.is_error` 400 (`9R:CHG:29`). |
| 2 | `cerebras` | **New**: API key via `openAiRouter`, `validation:'none'` `Reg:OD:111`, `C1589` / apikey with `validateUrl` `9R(cerebras):15-18` | catalog id, slash ids preserved (`OH:UP`) / `9R(cerebras):23` | OpenAI forced `Cap:OA` / generic | inherited SSE / OpenAI chat | OH new and uncommitted; scripted test `Kernel/SDK/tests/cerebras.test.js`. 9R static catalog, no recorded defect. |
| 3 | `chatgpt-web` | Web cookie `Auth:678-688` / cookie paste `userToken` `9R(chatgpt-web):16-17` | page-driven / `9R(chatgpt-web):27` | web tools-off `Cap:WEB` / web executor | 1053-line page driver / OpenAI-shaped `9R(chatgpt-web):24` | OH signed-out fold fixed (`tasks/todo.md:3519`). 9R browser pool/TLS impersonation (`9R:CHG:121`) — not to copy. |
| 4 | `claude` | OAuth authorization-code + PKCE (`Kernel/SDK/claude/adapter/index.ts:57-79,464-529`), `C1085`, sign-in `service.ts:1860-1903` / oauth deprecated RISK_NOTICE `9R(claude):13-17` | catalog id / `9R:UP` | tools, forcing refused `Cap:NO` / `cloakToolsOnOAuth` `9R(claude):30` | native Messages stream (`Kernel/SDK/claude/adapter/index.ts:200-274`) / claude + `?beta=true` `9R(claude):18-20` | OH card carries consumer-terms warning; 9R marks Claude Code deprecated. No live sign-in performed. |
| 5 | `cline` | OAuth/API key, `validateOnSave` + `validation:'credential'` `Reg:DS:749`, `Auth:50` / oauth + envelope `9R(cline):16-38` | slashes preserved (`OH:UP`) / `9R(cline):38` | OpenAI forced `Cap:OA` / `clineEnvelope` | inherited SSE / OpenAI chat | OH real fixture (`docs/reports/provider-test-matrix.md:36`); 9R `workos:` prefix 401 fixed (`9R:CHG:357`). |
| 6 | `clinepass` | OAuth/API key, `validation:'none'` `Reg:DS:754`, `Auth:120` / oauth same host `9R(clinepass):16-44` | own connection (`C304`) / same wire | OpenAI forced `Cap:OA` / envelope | inherited SSE / OpenAI chat | OH distinct failure reason (`tasks/todo.md:4652`); 9R prefix 401 + quota tracker (`9R:CHG:357,8`). |
| 7 | `codebuddy-cn` | OAuth `Auth:321` / oauth forceStream `9R(codebuddy-cn):18-22` | catalog id / `9R(codebuddy-cn):50` | forced mapping `Cap:FM` / four IDE headers (`9R:CHG:128`) | inherited SSE / forced stream | OH restriction `403/11140` stops rotation (`docs/SPEC-SDK.md:246`); 9R header-less calls `400/11128` (`9R:CHG:128`). |
| 8 | `codebuddy-intl` | OAuth `Auth:340` / oauth `9R(codebuddy-intl):19-24` | catalog id / `9R(codebuddy-intl):50` | forced mapping `Cap:FM` / intl WAF (`9R:CHG:68`) | inherited SSE / forced stream | OH shares restriction rule; 9R identity sanitisation (`9R:CHG:68`). |
| 9 | `codex` | OAuth PKCE (`Kernel/API/src/providers/codexOAuth.ts:161-179`), `Auth:481` / oauth deprecated `9R(codex):28-37` | catalog id + Responses lane (`Kernel/API/src/core/provider-responses-lane.ts:38`) / suffix rewrite `9R:UP` | Responses tools, forcing refused `Cap:NO` + lifecycle (`Kernel/SDK/codex/lib/responses-tools.ts:8-72`) / `openai-responses` `9R(codex):41` | Responses SSE + tool deltas / passthrough | OH pin `0.171.0` (`Kernel/SDK/codex/adapter/index.ts:19`) now ahead of 9R `0.167.1` (`9R(codex):5`); OH silent tool-loop halt fixed (`144b73cb`,`2be26c3e`). |
| 10 | `deepseek` | API key `validation:'none'` `Reg:OD:94` / models Check (`9RV:401-413`) | catalog id (`OH:UP`) / `9R(deepseek):23,58` | OpenAI forced `Cap:OA` / strips client tools `9R(deepseek):31-38` | inherited SSE / OpenAI `9R(deepseek):47` | OH no candidate-key proof; 9R rejects custom/MCP tools (`9R(deepseek):31-38`). |
| 11 | `deepseek-web` | Web session `Auth:562` / cookie `9R(deepseek-web):16-17` | capture-driven / `9R(deepseek-web):24` | web tools-off `Cap:WEB` / web executor | 1292-line page driver / done terminator | OH four-endpoint capture (`docs/reports/deepseek-web-capture.md`); 9R deferred `[DONE]` watchdog (`9router/open-sse/utils/stream.js:28,137`). |
| 12 | `fireworks` | API key `openAiRouter` `validation:'none'` `Reg:OD:104`, `C1516` / models Check (`9RV:407`) | slash ids passed through (`OH:UP`) / `9R(fireworks):21` | OpenAI forced `Cap:OA` / no quirk | inherited SSE / OpenAI chat | Committed; no live probe. 9R static catalog, no recorded defect. |
| 13 | `gemini` | API key built-in / freeTier with OAuth client (`9R(gemini):18-24`), public models Check (`9RV:320-324`) | catalog id / `9R(gemini):38`, tier rewrite `9R:UP` | forced mapping `Cap:FM` / native gemini `9R(gemini):24` | native `streamGenerateContent` / native SSE | OH bare-catch fixed; 9R public-catalog key check (`9RV:320-324`), pricing (`9R:CHG:18`). |
| 14 | `gemini-web` | Web session `Auth:545-554` / cookie `9R(gemini-web):16-23` | page-driven / `9R(gemini-web):31` | web tools-off `Cap:WEB` / web executor | 522-line page driver / OpenAI-shaped registry | OH Check verifies session only; 9R needs browser runtime (`9R:CHG:121`). |
| 15 | `grok-web` | Web session `Auth:606-612` / cookie `9R(grok-web):16-23` | page-driven / `9R(grok-web):27` | web tools-off `Cap:WEB` / grok-web tools executor | 470-line page driver / `format: grok-web` `9R(grok-web):24` | OH 400/429 = accepted cookie (`tasks/todo.md:5749`); 9R TLS impersonation (`9R:CHG:121`) — do not copy. |
| 16 | `groq` | API key `validation:'none'` `Reg:OD:97` / models Check (`9RV:402`) | catalog id / `9R(groq):27` | OpenAI forced `Cap:OA` / reasoning replay stripped (`9R:CHG:312`) | inherited SSE / OpenAI chat | OH no candidate proof; 9R client metadata (`9R:CHG:312`). |
| 17 | `kilocode` | OAuth `Auth:297` / oauth `9R(kilocode):16-29` | catalog id / `9R(kilocode):29` | forced mapping `Cap:FM` / generic | inherited SSE / OpenAI chat | OH device auth 202/403/410 (`tasks/todo.md:5441`); 9R catalog/quota gaps (`9R:CHG:874,182`). |
| 18 | `kimi` | API key `api.moonshot.ai/v1` (`C1003`, `Reg:OD:93`) / **OAuth coding subscription** `9R(kimi):23-28` | catalog id / `9R(kimi):62` | OpenAI forced `Cap:OA` / native claude `9R(kimi):28` | inherited SSE / Claude Messages | **Same id, different product**; OH `kimi-code` (`C1027`, `Auth:242`) is the counterpart. 9R Responses lane (`9R:CHG:216`). |
| 19 | `kiro` | OAuth Builder ID/IAM `Auth:516`, forcing refused `Cap:NO` / free binary wire `9R(kiro):17-25` | catalog id / aliases `9R:CHG:150` | tools no forcing `Cap:NO` / eventstream translator | 1497-line binary adapter / `format: kiro` | OH aliasing guard (`routing.ts:768-783`); 9R region hostname bug (`9R:CHG:64`). |
| 20 | `minimax-code` | OAuth PKCE `Auth:363` / oauth claude `9R(minimax-code):23-30` | catalog id / `9R(minimax-code):53` | forced mapping `Cap:FM` / claude | 780-line Messages adapter / native SSE | OH preflight discarded good grant (`full-improvement-plan:53`); 9R lease mode/casing (`9R:CHG:37,150`). |
| 21 | `minimax-code-global` | OAuth `Auth:382`, same adapter (`C1175`) / oauth global `9R(minimax-code-global):17-24` | catalog id / `9R(minimax-code-global):47` | forced mapping `Cap:FM` / claude | shared adapter / native | OH no separate SDK package; 9R separate registry entry (`9R:CHG:37`). |
| 22 | `mistral` | API key `validation:'none'` `Reg:OD:87` / models Check (`9RV:404`) | catalog id / `9R(mistral):23` | OpenAI forced `Cap:OA` / `dropClientMetadata` `9R(mistral):17` | inherited SSE / OpenAI chat | OH no candidate proof; 9R client metadata (`9R:CHG:992`). |
| 23 | `nebius` | **New**: API key `openAiRouter`, `validation:'none'` `Reg:OD:113`, `C1627` / apikey with `validateUrl` `9R(nebius):15-19` | catalog id (`OH:UP`) / `9R(nebius):21` | OpenAI forced `Cap:OA` / 9R also has embeddingConfig `9R(nebius):26` | inherited SSE / OpenAI chat | OH new; scripted `Kernel/SDK/tests/nebius.test.js`. 9R additional embedding lane not in OH. |
| 24 | `nous` | OAuth or API key, `validateOnSave` + `validation:'credential'` `Reg:DS:759`, `Auth:274` / device-flow agent key `9R(nous):31-37` | ids with slashes (`OH:UP`) / suffix rewrite `9R:UP` | OpenAI forced `Cap:OA` / attribution tags (`9router/open-sse/executors/default.js:118-139`) | reasoning-only streams accepted (`Kernel/SDK/nous/adapter/index.ts`) / OpenAI SSE | OH reasoning-only and tags fixed (`comparison-9router-2026-11-20.md:132-159`); 9R tags once missing (`9R:CHG:175`). |
| 25 | `nvidia` | API key real probe `Reg:OD:101`, `Kernel/SDK/nvidia/adapter/index.ts:65-110` / public catalog Check (`9RV:401-413`) | `vendor/model` pass-through (`nvidia-provider-audit:§2`) / `9R:UP` | OpenAI forced `Cap:OA`; `supports_tools` parsed (`Kernel/SDK/openai/lib/model-normalize.ts:87`) / stale tools:false (`9router/open-sse/providers/capabilities.js:248`) | inherited SSE / nvidia-tts only `9R(nvidia):53` | OH audit P0/P1 fixed by `81d82d46`; 9R still validates with public catalog (`nvidia-provider-audit:§3`). |
| 26 | `ollama` | Keyless (`C605`), `validation:'none'`, local endpoint / freeTier apikey `9R(ollama):17-23` | bare local ids / `9R(ollama):25` | OpenAI forced `Cap:OA` / native format | inherited SSE / native | OH keyless path asserted (`tests/provider-card-honesty.test.js`); 9R host suffix normalisation (`9R:CHG:123`). |
| 27 | `openai` | API key built-in / public models Check (`9RV:289-294`) | catalog id / `9R(openai):30` | OpenAI forced `Cap:OA` / forced stream `9R(openai):73` | inherited SSE + embeddings/images (`Kernel/SDK/openai/adapter/index.ts:13-31`) / forced SSE | OH bare-catch fixed; 9R bogus key can pass public catalog (`9RV:289-294`). |
| 28 | `opencode` | OAuth/API key, `validation:'credential'` `Reg:DS:760`, `Auth:179` / free + forceStream `9R(opencode):13-38` | Zen lanes (`docs/SPEC-SDK.md:1049-1133`) / per-model targets | tools no forcing `Cap:NO` + read-only tools (`Kernel/Tools/src/gatewayTools.ts:3-31`) / `forceAutoToolChoiceModels` `9R(opencode):38` | streamed session deltas / forced stream | OH tool exposure documented (`AGENTS.md`); 9R proxy-keyed session cache (`9R:CHG:20`). |
| 29 | `opencode-go` | OAuth/API key, 1-token probe `Reg:DS:764`, `Auth:198` / apikey `9R(opencode-go):22-32` | `/zen/go/v1` (`C637`) / `9R(opencode-go):42` | no forcing `Cap:NO` / OpenAI wire | 850-line adapter / OpenAI SSE | OH lane refusals documented; 9R Claude reasoning on Messages (`9R:CHG:52`). |
| 30 | `openrouter` | API key built-in + SDK validator / public models Check (`9RV:325-330`) | catalog id (`OH:UP`) / `9R(openrouter):28` | OpenAI forced `Cap:OA` / generic | inherited SSE / OpenAI chat | OH real fixture (`provider-test-matrix.md:36`); 9R systemone/video lanes (`9R:CHG:303,345`). |
| 31 | `perplexity` | **New**: API key `openAiRouter`, `validation:'none'` `Reg:OD:114`, `C1646` / apikey with `validateUrl` `9R(perplexity):19-23` | catalog id (`OH:UP`) / `9R(perplexity):25` | OpenAI forced `Cap:OA` / generic | inherited SSE / OpenAI chat | OH new; scripted `Kernel/SDK/tests/perplexity.test.js`. Distinct from OH-only `perplexity-web` and 9R-only `perplexity-agent`. |
| 32 | `perplexity-web` | Web session `Auth:619-625` / cookie `9R(perplexity-web):16-24` | page-driven / `9R(perplexity-web):27` | web tools-off `Cap:WEB` / native web | 612-line page driver / native SSE | OH probe semantics (`tasks/todo.md:5749`); 9R separate Perplexity Agent id (still 9R-only). |
| 33 | `qoder` | OAuth device flow `Auth:405` / oauth custom agent-chat `9R(qoder):15-28` | catalog id / `9R(qoder):28` | no forcing `Cap:NO`, PKCE (`Kernel/SDK/qoder/adapter/index.ts:175-202`) / COsy | 674-line adapter / custom SSE | OH preflight tolerance issue (`full-improvement-plan:466`); 9R 10605 queue signals (`9R:CHG:146`). |
| 34 | `sambanova` | **New**: API key `openAiRouter`, `validation:'none'` `Reg:OD:110`, `C1570` / apikey with `validateUrl` `9R(sambanova):17-22` | catalog id (`OH:UP`) / `9R(sambanova):24` | OpenAI forced `Cap:OA` / generic | inherited SSE / OpenAI chat | OH new; scripted `Kernel/SDK/tests/sambanova.test.js`. 9R static catalog, no recorded defect. |
| 35 | `siliconflow` | **New**: API key `openAiRouter`, `validation:'none'` `Reg:OD:112`, `C1608` / apikey with `validateUrl` `9R(siliconflow):15-18` | catalog id (`OH:UP`) / `9R(siliconflow):21` | OpenAI forced `Cap:OA` / generic | inherited SSE / OpenAI chat | OH new; scripted `Kernel/SDK/tests/siliconflow.test.js`. 9R static catalog, no recorded defect. |
| 36 | `together` | API key `openAiRouter` `validation:'none'` `Reg:OD:103`, `C1495` / models Check (`9RV:406`) | slash ids passed through / `9R(together):21` | OpenAI forced `Cap:OA` / no quirk | inherited SSE / OpenAI chat | Committed; no live probe. 9R static catalog, no recorded defect. |
| 37 | `tokenharbor` | API key `validation:'none'` `Reg:OD:89`, `C723`; authenticated catalog makes saved Test real / models Check (`9R(tokenharbor):21-29`) | catalog id / `9R(tokenharbor):39` | OpenAI forced `Cap:OA` / no quirk | inherited SSE / OpenAI chat | OH live route/401 wording measured (`tasks/todo.md:3907`); `tokenharbor-web` is OH-only. |
| 38 | `xai` | API key `openAiRouter`, `validation:'none'` `Reg:OD:108`, `C1535` / oauth **and** apikey `9R(xai):15-25` with OAuth modules `9router/src/lib/oauth/{constants,providers,services}/xai.js` | catalog id (`OH:UP`) / suffix rewrite `9R:UP`, models `9R(xai):29` | tools served, forcing refused `Cap:NO` / grok patterns `9router/open-sse/providers/capabilities.js:573-584` | OpenAI SSE (`Kernel/SDK/xai/adapter/index.ts`) / chat + Responses `9R(xai):22-24` | OH lacks 9R's OAuth, image config `9R(xai):41`, video config `:44` and search-via-chat `:45`. |

### Cross-cutting change in cycle 4

Five routers moved from 9R-only to shared in the working tree: `sambanova`, `cerebras`, `siliconflow`,
`nebius`, `perplexity` (`src/data/providers.ts:1570-1646`, `own-provider-adapters.ts:110-114`, caps
rows at `Kernel/Tools/src/caps.ts:60,68,71,75,76`). All are generic OpenAI-compatible adapters with
`validation:'none'` and card endpoints matching 9router's `baseUrl` paths minus `/chat/completions`.
They are uncommitted and locally tested with scripted transports; no live key was used. The previous
cycle's `claude`, MCP-plugin bridge, video-refusal route and tool cloaking are now committed at
`6a4484d4`'s parent `a71f61d8`.

---

## 3. Workspace-only ids (29)

| id | card | What it adds |
| --- | --- | --- |
| `100milionseek` | `C413` | Free router `Reg:OD:79` |
| `agentrouter` | `C371` | Client identity + Responses lane (`Kernel/API/test/agentrouter-responses-lane.test.js`) |
| `agnes-ai` | `C350` | Free router `Reg:OD:68`; 9R has separate `agnes` (still 9R-only) |
| `aion-labs` | `C392` | Real 1-token probe `Reg:OD:78` |
| `anyrouter` | `C545` | Free router `Reg:OD:83` |
| `apinex` | `C769` | Free router `Reg:OD:90` |
| `apmix` | `C747` | Dedicated adapter `Reg:DS:755` |
| `beatapi` | `C485` | Dedicated adapter `Reg:DS:756` |
| `claude-code` | `C1049` | Anthropic subscription OAuth + PKCE (`Kernel/SDK/claude-code/adapter/index.ts:430-474`, `Auth:432`) |
| `coarena` | `C1402` | Free router `Reg:OD:102` |
| `custom` | `C1696` | Local OpenAI-compatible endpoint; resolver fallback (`provider-resolver.ts:49-58`) |
| `deepseek-web-v2` | `C200` | Second DeepSeek web wire (`Auth:568`) |
| `duckduckgo-web` | `C916` | Keyless Duck.ai session (`Auth:707-713`) |
| `grok` | `C1354` | xAI API-key adapter `Reg:OD:98`; distinct from `xai` and 9R's `grok-cli`/`grok-web` |
| `kimi-code` | `C1027` | Kimi Code OAuth (`Auth:242`) — counterpart of 9R's `kimi` |
| `kiraai` | `C505` | Free router `Reg:OD:81` |
| `nara-router` | `C702` | Free router `Reg:OD:88` |
| `numes` | `C457` | Free router `Reg:OD:80` |
| `opencode-console` | `C80` | Console OAuth + runtime installer (`Kernel/API/src/core/opencode-runtime.ts:281-410`) |
| `qwen` | `C1260` | Qwen platform API key `Reg:OD:95` |
| `qwen-token-plan` | `C1284` | Token-plan endpoint `Reg:OD:96` |
| `qwen-web` | `C132` | Qwen web session (`src/lib/webSessionProviders.ts:80+`) |
| `tiarina` | `C791` | Free router `Reg:OD:91` |
| `tokenharbor-web` | `C845` | Web session adapter (`Kernel/SDK/tokenharbor-web/adapter/index.ts`) |
| `unorouter` | `C585` | Free router `Reg:OD:85` |
| `vengetic` | `C525` | Audited API-key provider (`docs/reports/vengetic-provider-audit-2026-11-21.md`) |
| `xkiro` | `C813` | Free router `Reg:OD:92` |
| `zcode` | `C1304` | ZCode standalone OAuth (`Auth:648`, `Kernel/API/src/core/zcode-oauth.ts`) |
| `zro` | `C565` | Free router `Reg:OD:84` |

Most are API-key aggregators; the genuinely distinct ones are `claude-code`, `opencode-console`,
`qwen-web`, `deepseek-web-v2`, `duckduckgo-web`, `tokenharbor-web`, `zcode`.

---

## 4. 9router-only ids (110)

Full list from the `comm -23` command above:

`agnes`, `alicode`, `alicode-intl`, `alims-intl`, `alitp-intl`, `antigravity`, `api-airforce`, `assemblyai`, `atria`, `aws-polly`, `azure`, `bai`, `baidu`, `bazaarlink`, `bedrock`, `bedrock-xai`, `black-forest-labs`, `blackbox`, `bluesminds`, `brave-search`, `byteplus`, `cartesia`, `chutes`, `cloudflare-ai`, `cohere`, `comfyui`, `commandcode`, `coqui`, `cursor`, `dahl`, `deepgram`, `devin-cli`, `edge-tts`, `elevenlabs`, `exa`, `fal-ai`, `featherless`, `firecrawl`, `fish-audio`, `gemini-cli`, `github`, `gitlab`, `glm`, `glm-cn`, `google-pse`, `google-tts`, `grok-cli`, `huggingface`, `hyperbolic`, `iflow`, `inworld`, `jina-ai`, `jina-reader`, `kilo-gateway`, `kimchi`, `linkup`, `llm7`, `local-device`, `mimo-free`, `minimax`, `minimax-cn`, `mmf`, `morph`, `muse`, `muse-web`, `nace`, `nanobanana`, `ollama-local`, `ollama-search`, `opencode-zen`, `perplexity-agent`, `playht`, `poolside`, `qoder-cn`, `recraft`, `runcrate`, `runwayml`, `sdwebui`, `searchapi`, `searxng`, `selfhosted-embedding`, `selfhosted-stt`, `selfhosted-tts`, `sensenova`, `sensenova-intl`, `serper`, `stability-ai`, `synthetic`, `tavily`, `tencent`, `tinyfish`, `tokenrouter`, `topaz`, `tortoise`, `trae`, `uc-web`, `v1m`, `venice`, `veoaifree-web`, `vercel-ai-gateway`, `vertex`, `vertex-partner`, `volcengine-ark`, `voyage-ai`, `windsurf`, `xiaomi-mimo`, `xiaomi-tokenplan`, `xquik`, `youcom`, `zed`.

The highest-value remaining classes are subscription CLI/OAuth wires (`cursor`, `gemini-cli`,
`grok-cli`, `zed`, `windsurf`, `trae`, `glm`, `github`, `gitlab`), binary/proprietary wires
(`commandcode`, `mimo-free`, `xiaomi-tokenplan`), and media/search vendors. Do not copy 9router's
TLS impersonation or MITM stack (`9router/CHANGELOG.md:121`, `tasks/parity-loop/README.md:19-21`).

---

## 5. Internet findings

1. **OH's latest tag has no npm version, but its version mismatch was repaired in the working tree.**
   `https://registry.npmjs.org/@hilbras%2Fomnihilbras/latest` returns `3.95.0`; both `/3.96.0` and
   `/3.97.0` returned 404 and `npm view` E404; `https://api.github.com/repos/Hilbras/OmniHilbras/releases/tags/v3.97.0`
   exists. Commit `6a4484d4` repaired root/cli manifests to 3.97.0, but no publish was performed in
   this ask. Action: publish from `cli/` and poll the registry.
2. **Codex CLI is now ahead of 9router.** `https://registry.npmjs.org/@openai%2Fcodex/latest` returned
   `0.171.0`, matching `Kernel/SDK/codex/adapter/index.ts:19`; 9router pins `0.167.1`
   (`9router/open-sse/providers/registry/codex.js:5`). No live Codex turn was made.

---

## 6. Ranked, concrete improvement plan

1. **Publish the repaired tag and close both npm gaps (high).**
   Files: `cli/package.json`, `NPM-PUBLISH.md`, `tasks/parity-loop/state.json`.
   Behavior: publish `3.97.0` from `cli/`, poll `npm view @hilbras/omnihilbras@3.97.0 version` until
   it echoes `3.97.0`, decide explicitly whether `3.96.0` is republishable from its own tag (it is not
   if superseded code would be published), and re-run `pnpm release:audit` to exit 0. Proving test:
   `node --test tests/release-trail.test.js` green plus `pnpm release:audit` exit 0. **Not performed
   in this report** (publishing forbidden).
2. **Give video a real adapter or keep the refusal explicit (high).**
   Files: `Kernel/API/src/routes/video.ts:1-13,111,122`, new `Kernel/SDK/xai/adapter/video.ts`,
   `Kernel/API/src/server.ts:16,128,462`.
   Behavior: implement job creation and connection-bound poll for a provider that really serves video
   (`9router/open-sse/providers/registry/xai.js:44`), keeping `NOT_SUPPORTED` for the rest and never
   producing a synthetic URL. Proving test: extend `Kernel/API/test/video-route.test.js` with a
   scripted video transport and a poll bound to the creating connection.
3. **Close the highest-value remaining 9router-only ids (high).**
   Files: new SDK packages, `Kernel/API/src/core/own-provider-adapters.ts`,
   `Kernel/API/src/core/service.ts:737-862`, `src/data/providers.ts`, `Kernel/Tools/src/caps.ts`.
   Behavior: next `cursor`, `gemini-cli`, `zed`, `glm`, `commandcode`; no measured claims on cards,
   declared validation strategies, real OAuth/device flows where 9router has them
   (`9router/src/lib/oauth/{providers,services}/<id>.js`), no anti-bot spoofing. Proving test:
   scripted adapter tests per id plus `tests/provider-cards.test.js`, `tests/tools-caps.test.js`,
   `tests/provider-oauth-routes.test.js` (26 guard tests passed here).
4. **Resolve the `xai` and `kimi` id mismatches (medium).**
   Files: `src/data/providers.ts:1535,1003`, `Kernel/API/src/core/own-provider-adapters.ts:93,108`,
   `Kernel/SDK/xai/adapter/index.ts`, `src/components/AddProviderModal.tsx`, `docs/SPEC-SDK.md`.
   Behavior: for `xai`, either implement OAuth plus Responses/image/video/search lanes or state in
   the card that only the API-key chat lane is served; for `kimi`, point it at the coding endpoint
   with OAuth like `9router/open-sse/providers/registry/kimi.js:23-28` or say explicitly that
   `kimi-code` is the coding subscription. Proving test: extend `Kernel/SDK/tests/xai.test.js` and
   `tests/provider-cards.test.js` to assert endpoint/auth agreement with each card.
5. **Make candidate-key checks honest for the new and old router ids (medium).**
   Files: `Kernel/API/src/core/own-provider-adapters.ts:87-114`, `tests/provider-validation.test.js`.
   Behavior: declare `validation:'models'` only with an evidence note that the upstream catalog is
   authenticated; otherwise keep `none` and say so in the UI. Never add a generic fallback that
   accepts a bogus key. Proving test: bogus-key cases modeled on 9router's
   `9router/src/app/api/providers/validate/route.js:289-330,401-413` and an evidence requirement for
   each `models` declaration.
6. **Keep the defect register current as ids change (low).**
   Files: `docs/architecture/provider-defects.md:1-16`, `scripts/build-provider-defects.mjs`,
   `tests/provider-cards.test.js`.
   Behavior: the register predates the five new shared ids; add rows and a freshness check so a new
   card or registry id fails until it has an explicit row. Proving test:
   `node scripts/build-provider-defects.mjs --check` plus a card-count assertion, with the 9router
   root supplied explicitly.

**Not to copy:** plaintext credentials, public-catalog key validation, browser impersonation/MITM,
manifest version drift, and any simulated success. The safety rule in tasks/parity-loop/README.md:19-21
governs all six items.
