# Provider defect register

**Generated file — do not edit by hand.** Regenerate with `node scripts/build-provider-defects.mjs`;
`node scripts/build-provider-defects.mjs --check` fails when the committed file is stale.
Source for the external half: `open-sse/providers/registry/*.js` in `/mnt/sda3/work/projects.old/9router`.
Source for the OmniHilbras half: `src/data/providers.ts` (71 cards).

| | Count |
| --- | --- |
| Provider ids with a row | 177 |
| OmniHilbras cards | 70 |
| 9router registry entries | 148 |
| Ids with a recorded defect | 11 |

A row is a **recorded claim**, not a live measurement. No provider was called to build this file.
`source` is a path + line a reader can open; `test` is the local check that proves the stated status.
An id with no recorded defect says so rather than acquiring a fabricated failure to fill the column.

| Provider id | In OH | In 9R | Failure | Source | Status | Proving test |
| --- | --- | --- | --- | --- | --- | --- |
| `100milionseek` | src/data/providers.ts:427 | — | No defect recorded. | — | no recorded defect | — |
| `agentrouter` | src/data/providers.ts:385 | — | No defect recorded. | — | no recorded defect | — |
| `agnes` | — | 9router/open-sse/providers/registry/agnes.js | No defect recorded. | — | no recorded defect | — |
| `agnes-ai` | src/data/providers.ts:364 | — | No defect recorded. | — | no recorded defect | — |
| `aion-labs` | src/data/providers.ts:406 | — | No defect recorded. | — | no recorded defect | — |
| `alicode` | — | 9router/open-sse/providers/registry/alicode.js | No defect recorded. | — | no recorded defect | — |
| `alicode-intl` | — | 9router/open-sse/providers/registry/alicode-intl.js | No defect recorded. | — | no recorded defect | — |
| `alims-intl` | — | 9router/open-sse/providers/registry/alims-intl.js | No defect recorded. | — | no recorded defect | — |
| `alitp-intl` | — | 9router/open-sse/providers/registry/alitp-intl.js | No defect recorded. | — | no recorded defect | — |
| `anthropic` | src/data/providers.ts:1541 | 9router/open-sse/providers/registry/anthropic.js | No defect recorded. | — | no recorded defect | — |
| `antigravity` | — | 9router/open-sse/providers/registry/antigravity.js | No defect recorded. | — | no recorded defect | — |
| `anyrouter` | src/data/providers.ts:559 | — | No defect recorded. | — | no recorded defect | — |
| `api-airforce` | — | 9router/open-sse/providers/registry/api-airforce.js | No defect recorded. | — | no recorded defect | — |
| `apinex` | src/data/providers.ts:783 | — | No defect recorded. | — | no recorded defect | — |
| `apmix` | src/data/providers.ts:761 | — | No defect recorded. | — | no recorded defect | — |
| `assemblyai` | — | 9router/open-sse/providers/registry/assemblyai.js | No defect recorded. | — | no recorded defect | — |
| `atria` | — | 9router/open-sse/providers/registry/atria.js | No defect recorded. | — | no recorded defect | — |
| `aws-polly` | — | 9router/open-sse/providers/registry/aws-polly.js | No defect recorded. | — | no recorded defect | — |
| `azure` | — | 9router/open-sse/providers/registry/azure.js | No defect recorded. | — | no recorded defect | — |
| `bai` | — | 9router/open-sse/providers/registry/bai.js | No defect recorded. | — | no recorded defect | — |
| `baidu` | — | 9router/open-sse/providers/registry/baidu.js | No defect recorded. | — | no recorded defect | — |
| `bazaarlink` | — | 9router/open-sse/providers/registry/bazaarlink.js | No defect recorded. | — | no recorded defect | — |
| `beatapi` | src/data/providers.ts:499 | — | No defect recorded. | — | no recorded defect | — |
| `bedrock` | — | 9router/open-sse/providers/registry/bedrock.js | No defect recorded. | — | no recorded defect | — |
| `bedrock-xai` | — | 9router/open-sse/providers/registry/bedrock-xai.js | No defect recorded. | — | no recorded defect | — |
| `black-forest-labs` | — | 9router/open-sse/providers/registry/black-forest-labs.js | No defect recorded. | — | no recorded defect | — |
| `blackbox` | — | 9router/open-sse/providers/registry/blackbox.js | No defect recorded. | — | no recorded defect | — |
| `bluesminds` | — | 9router/open-sse/providers/registry/bluesminds.js | No defect recorded. | — | no recorded defect | — |
| `brave-search` | — | 9router/open-sse/providers/registry/brave-search.js | No defect recorded. | — | no recorded defect | — |
| `byteplus` | — | 9router/open-sse/providers/registry/byteplus.js | No defect recorded. | — | no recorded defect | — |
| `cartesia` | — | 9router/open-sse/providers/registry/cartesia.js | No defect recorded. | — | no recorded defect | — |
| `cerebras` | src/data/providers.ts:1656 | 9router/open-sse/providers/registry/cerebras.js | No defect recorded. | — | no recorded defect | — |
| `chatgpt-web` | src/data/providers.ts:114 | 9router/open-sse/providers/registry/chatgpt-web.js | No defect recorded. | — | no recorded defect | — |
| `chutes` | — | 9router/open-sse/providers/registry/chutes.js | No defect recorded. | — | no recorded defect | — |
| `claude` | src/data/providers.ts:1099 | 9router/open-sse/providers/registry/claude.js | The reference ships a plain authorization-code + PKCE sign-in for claude; OmniHilbras had no flow for that id. | 9router/src/lib/oauth/providers/claude.js:2 | fixed — separate card, adapter and PKCE S256 flow on its own connection | Kernel/API/test/oauth-claude.test.js |
| `claude-code` | src/data/providers.ts:1066 | — | No defect recorded. | — | no recorded defect | — |
| `cline` | src/data/providers.ts:297 | 9router/open-sse/providers/registry/cline.js | No defect recorded. | — | no recorded defect | — |
| `clinepass` | src/data/providers.ts:318 | 9router/open-sse/providers/registry/clinepass.js | No defect recorded. | — | no recorded defect | — |
| `cloudflare-ai` | — | 9router/open-sse/providers/registry/cloudflare-ai.js | No defect recorded. | — | no recorded defect | — |
| `coarena` | src/data/providers.ts:1496 | — | No defect recorded. | — | no recorded defect | — |
| `codebuddy-cn` | src/data/providers.ts:1238 | 9router/open-sse/providers/registry/codebuddy-cn.js | No defect recorded. | — | no recorded defect | — |
| `codebuddy-intl` | src/data/providers.ts:1258 | 9router/open-sse/providers/registry/codebuddy-intl.js | No defect recorded. | — | no recorded defect | — |
| `codex` | src/data/providers.ts:1123 | 9router/open-sse/providers/registry/codex.js | The pinned CLI identity was older than the published client, so catalog entries gated by minimal_client_version could be absent in a 200. | Kernel/SDK/codex/adapter/index.ts:19 | fixed — identity raised to the published client version | Kernel/SDK/tests/codex.test.js |
| `cohere` | — | 9router/open-sse/providers/registry/cohere.js | No defect recorded. | — | no recorded defect | — |
| `comfyui` | — | 9router/open-sse/providers/registry/comfyui.js | No defect recorded. | — | no recorded defect | — |
| `commandcode` | — | 9router/open-sse/providers/registry/commandcode.js | No defect recorded. | — | no recorded defect | — |
| `coqui` | — | 9router/open-sse/providers/registry/coqui.js | No defect recorded. | — | no recorded defect | — |
| `cursor` | — | 9router/open-sse/providers/registry/cursor.js | The reference ships a registry/OAuth flow for this id; OmniHilbras has no card, adapter or flow. | 9router/open-sse/providers/registry/cursor.js:1 | gap — parity backlog | tests/9router-catalog.test.js |
| `custom` | src/data/providers.ts:1793 | — | No defect recorded. | — | no recorded defect | — |
| `dahl` | — | 9router/open-sse/providers/registry/dahl.js | No defect recorded. | — | no recorded defect | — |
| `deepgram` | — | 9router/open-sse/providers/registry/deepgram.js | No defect recorded. | — | no recorded defect | — |
| `deepseek` | src/data/providers.ts:1277 | 9router/open-sse/providers/registry/deepseek.js | The reference strips tool definitions on its wire; OmniHilbras refuses an unserved contract before spending a request instead. | 9router/open-sse/providers/registry/deepseek.js:31 | documented divergence | tests/tools-caps.test.js |
| `deepseek-web` | src/data/providers.ts:235 | 9router/open-sse/providers/registry/deepseek-web.js | No defect recorded. | — | no recorded defect | — |
| `deepseek-web-v2` | src/data/providers.ts:214 | — | No defect recorded. | — | no recorded defect | — |
| `devin-cli` | — | 9router/open-sse/providers/registry/devin-cli.js | No defect recorded. | — | no recorded defect | — |
| `duckduckgo-web` | src/data/providers.ts:930 | — | No defect recorded. | — | no recorded defect | — |
| `edge-tts` | — | 9router/open-sse/providers/registry/edge-tts.js | No defect recorded. | — | no recorded defect | — |
| `elevenlabs` | — | 9router/open-sse/providers/registry/elevenlabs.js | No defect recorded. | — | no recorded defect | — |
| `exa` | — | 9router/open-sse/providers/registry/exa.js | No defect recorded. | — | no recorded defect | — |
| `fal-ai` | — | 9router/open-sse/providers/registry/fal-ai.js | No defect recorded. | — | no recorded defect | — |
| `featherless` | — | 9router/open-sse/providers/registry/featherless.js | No defect recorded. | — | no recorded defect | — |
| `firecrawl` | — | 9router/open-sse/providers/registry/firecrawl.js | No defect recorded. | — | no recorded defect | — |
| `fireworks` | src/data/providers.ts:1611 | 9router/open-sse/providers/registry/fireworks.js | No defect recorded. | — | no recorded defect | — |
| `fish-audio` | — | 9router/open-sse/providers/registry/fish-audio.js | No defect recorded. | — | no recorded defect | — |
| `gemini` | src/data/providers.ts:1565 | 9router/open-sse/providers/registry/gemini.js | No defect recorded. | — | no recorded defect | — |
| `gemini-cli` | — | 9router/open-sse/providers/registry/gemini-cli.js | The reference ships a registry/OAuth flow for this id; OmniHilbras has no card, adapter or flow. | 9router/open-sse/providers/registry/gemini-cli.js:1 | gap — parity backlog | tests/9router-catalog.test.js |
| `gemini-web` | src/data/providers.ts:898 | 9router/open-sse/providers/registry/gemini-web.js | No defect recorded. | — | no recorded defect | — |
| `github` | — | 9router/open-sse/providers/registry/github.js | No defect recorded. | — | no recorded defect | — |
| `gitlab` | — | 9router/open-sse/providers/registry/gitlab.js | No defect recorded. | — | no recorded defect | — |
| `glm` | src/data/providers.ts:1371 | 9router/open-sse/providers/registry/glm.js | The reference ships a dual-auth Z.ai coding entry (OpenAI chat plus a Claude-header lane and ZCode CLI OAuth); OmniHilbras serves the paid key on the OpenAI-compatible chat path only. | 9router/open-sse/providers/registry/glm.js:1 | partial — keyed OpenAI-compatible chat only; no Claude headers, CLI identity or OAuth | Kernel/SDK/tests/glm.test.js |
| `glm-cn` | src/data/providers.ts:1397 | 9router/open-sse/providers/registry/glm-cn.js | The reference ships a mainland BigModel coding entry with a usage-quota URL and a listed model catalogue; OmniHilbras serves the keyed OpenAI-compatible chat path only and claims no measured usage or models. | 9router/open-sse/providers/registry/glm-cn.js:15 | partial — keyed OpenAI-compatible chat only; no usage probe, model list, OAuth or client identity | tests/provider-validation.test.js |
| `google-pse` | — | 9router/open-sse/providers/registry/google-pse.js | No defect recorded. | — | no recorded defect | — |
| `google-tts` | — | 9router/open-sse/providers/registry/google-tts.js | No defect recorded. | — | no recorded defect | — |
| `grok` | src/data/providers.ts:1448 | — | No defect recorded. | — | no recorded defect | — |
| `grok-cli` | — | 9router/open-sse/providers/registry/grok-cli.js | No defect recorded. | — | no recorded defect | — |
| `grok-web` | src/data/providers.ts:969 | 9router/open-sse/providers/registry/grok-web.js | No defect recorded. | — | no recorded defect | — |
| `groq` | src/data/providers.ts:1424 | 9router/open-sse/providers/registry/groq.js | No defect recorded. | — | no recorded defect | — |
| `huggingface` | — | 9router/open-sse/providers/registry/huggingface.js | No defect recorded. | — | no recorded defect | — |
| `hyperbolic` | — | 9router/open-sse/providers/registry/hyperbolic.js | No defect recorded. | — | no recorded defect | — |
| `iflow` | — | 9router/open-sse/providers/registry/iflow.js | No defect recorded. | — | no recorded defect | — |
| `inworld` | — | 9router/open-sse/providers/registry/inworld.js | No defect recorded. | — | no recorded defect | — |
| `jina-ai` | — | 9router/open-sse/providers/registry/jina-ai.js | No defect recorded. | — | no recorded defect | — |
| `jina-reader` | — | 9router/open-sse/providers/registry/jina-reader.js | No defect recorded. | — | no recorded defect | — |
| `kilo-gateway` | — | 9router/open-sse/providers/registry/kilo-gateway.js | No defect recorded. | — | no recorded defect | — |
| `kilocode` | src/data/providers.ts:1176 | 9router/open-sse/providers/registry/kilocode.js | No defect recorded. | — | no recorded defect | — |
| `kimchi` | — | 9router/open-sse/providers/registry/kimchi.js | No defect recorded. | — | no recorded defect | — |
| `kimi` | src/data/providers.ts:1017 | 9router/open-sse/providers/registry/kimi.js | No defect recorded. | — | no recorded defect | — |
| `kimi-code` | src/data/providers.ts:1044 | — | No defect recorded. | — | no recorded defect | — |
| `kiraai` | src/data/providers.ts:519 | — | No defect recorded. | — | no recorded defect | — |
| `kiro` | src/data/providers.ts:271 | 9router/open-sse/providers/registry/kiro.js | No defect recorded. | — | no recorded defect | — |
| `linkup` | — | 9router/open-sse/providers/registry/linkup.js | No defect recorded. | — | no recorded defect | — |
| `llm7` | — | 9router/open-sse/providers/registry/llm7.js | No defect recorded. | — | no recorded defect | — |
| `local-device` | — | 9router/open-sse/providers/registry/local-device.js | No defect recorded. | — | no recorded defect | — |
| `mimo-free` | src/data/providers.ts:1767 | 9router/open-sse/providers/registry/mimo-free.js | The reference ships a client-identity and validation story for this free router; OmniHilbras serves the plain API-key OpenAI-compatible chat path only. | 9router/open-sse/providers/registry/mimo-free.js:1 | partial — keyed OpenAI-compatible chat only; no impersonation, OAuth, model list or key check | Kernel/SDK/tests/mimo-free.test.js |
| `minimax` | — | 9router/open-sse/providers/registry/minimax.js | No defect recorded. | — | no recorded defect | — |
| `minimax-cn` | — | 9router/open-sse/providers/registry/minimax-cn.js | No defect recorded. | — | no recorded defect | — |
| `minimax-code` | src/data/providers.ts:1196 | 9router/open-sse/providers/registry/minimax-code.js | No defect recorded. | — | no recorded defect | — |
| `minimax-code-global` | src/data/providers.ts:1216 | 9router/open-sse/providers/registry/minimax-code-global.js | No defect recorded. | — | no recorded defect | — |
| `mistral` | src/data/providers.ts:675 | 9router/open-sse/providers/registry/mistral.js | No defect recorded. | — | no recorded defect | — |
| `mmf` | — | 9router/open-sse/providers/registry/mmf.js | No defect recorded. | — | no recorded defect | — |
| `morph` | — | 9router/open-sse/providers/registry/morph.js | No defect recorded. | — | no recorded defect | — |
| `muse` | — | 9router/open-sse/providers/registry/muse.js | No defect recorded. | — | no recorded defect | — |
| `muse-web` | — | 9router/open-sse/providers/registry/muse-web.js | No defect recorded. | — | no recorded defect | — |
| `nace` | — | 9router/open-sse/providers/registry/nace.js | No defect recorded. | — | no recorded defect | — |
| `nanobanana` | — | 9router/open-sse/providers/registry/nanobanana.js | No defect recorded. | — | no recorded defect | — |
| `nara-router` | src/data/providers.ts:716 | — | No defect recorded. | — | no recorded defect | — |
| `nebius` | src/data/providers.ts:1696 | 9router/open-sse/providers/registry/nebius.js | No defect recorded. | — | no recorded defect | — |
| `nous` | src/data/providers.ts:448 | 9router/open-sse/providers/registry/nous.js | No defect recorded. | — | no recorded defect | — |
| `numes` | src/data/providers.ts:471 | — | No defect recorded. | — | no recorded defect | — |
| `nvidia` | src/data/providers.ts:1472 | 9router/open-sse/providers/registry/nvidia.js | No defect recorded. | — | no recorded defect | — |
| `ollama` | src/data/providers.ts:619 | 9router/open-sse/providers/registry/ollama.js | No defect recorded. | — | no recorded defect | — |
| `ollama-local` | — | 9router/open-sse/providers/registry/ollama-local.js | No defect recorded. | — | no recorded defect | — |
| `ollama-search` | — | 9router/open-sse/providers/registry/ollama-search.js | No defect recorded. | — | no recorded defect | — |
| `openai` | src/data/providers.ts:1517 | 9router/open-sse/providers/registry/openai.js | No defect recorded. | — | no recorded defect | — |
| `opencode` | src/data/providers.ts:340 | 9router/open-sse/providers/registry/opencode.js | No defect recorded. | — | no recorded defect | — |
| `opencode-console` | src/data/providers.ts:94 | — | The free tier refuses direct requests from this host; the gateway must drive the local OpenCode service. | Kernel/API/src/core/opencode-service.ts:1 | documented and mitigated — falls back to the direct lane only when no service is running | Kernel/API/test/opencode-runtime-ui.test.js |
| `opencode-go` | src/data/providers.ts:651 | 9router/open-sse/providers/registry/opencode-go.js | No defect recorded. | — | no recorded defect | — |
| `opencode-zen` | — | 9router/open-sse/providers/registry/opencode-zen.js | No defect recorded. | — | no recorded defect | — |
| `openrouter` | src/data/providers.ts:695 | 9router/open-sse/providers/registry/openrouter.js | No defect recorded. | — | no recorded defect | — |
| `perplexity` | src/data/providers.ts:1716 | 9router/open-sse/providers/registry/perplexity.js | No defect recorded. | — | no recorded defect | — |
| `perplexity-agent` | — | 9router/open-sse/providers/registry/perplexity-agent.js | No defect recorded. | — | no recorded defect | — |
| `perplexity-web` | src/data/providers.ts:993 | 9router/open-sse/providers/registry/perplexity-web.js | No defect recorded. | — | no recorded defect | — |
| `playht` | — | 9router/open-sse/providers/registry/playht.js | No defect recorded. | — | no recorded defect | — |
| `poolside` | — | 9router/open-sse/providers/registry/poolside.js | No defect recorded. | — | no recorded defect | — |
| `qoder` | src/data/providers.ts:1156 | 9router/open-sse/providers/registry/qoder.js | No defect recorded. | — | no recorded defect | — |
| `qoder-cn` | — | 9router/open-sse/providers/registry/qoder-cn.js | No defect recorded. | — | no recorded defect | — |
| `qwen` | src/data/providers.ts:1301 | — | No defect recorded. | — | no recorded defect | — |
| `qwen-token-plan` | src/data/providers.ts:1325 | — | No defect recorded. | — | no recorded defect | — |
| `qwen-web` | src/data/providers.ts:146 | — | No defect recorded. | — | no recorded defect | — |
| `recraft` | — | 9router/open-sse/providers/registry/recraft.js | No defect recorded. | — | no recorded defect | — |
| `runcrate` | — | 9router/open-sse/providers/registry/runcrate.js | No defect recorded. | — | no recorded defect | — |
| `runwayml` | — | 9router/open-sse/providers/registry/runwayml.js | No defect recorded. | — | no recorded defect | — |
| `sambanova` | src/data/providers.ts:1636 | 9router/open-sse/providers/registry/sambanova.js | No defect recorded. | — | no recorded defect | — |
| `sdwebui` | — | 9router/open-sse/providers/registry/sdwebui.js | No defect recorded. | — | no recorded defect | — |
| `searchapi` | — | 9router/open-sse/providers/registry/searchapi.js | No defect recorded. | — | no recorded defect | — |
| `searxng` | — | 9router/open-sse/providers/registry/searxng.js | No defect recorded. | — | no recorded defect | — |
| `selfhosted-embedding` | — | 9router/open-sse/providers/registry/selfhosted-embedding.js | No defect recorded. | — | no recorded defect | — |
| `selfhosted-stt` | — | 9router/open-sse/providers/registry/selfhosted-stt.js | No defect recorded. | — | no recorded defect | — |
| `selfhosted-tts` | — | 9router/open-sse/providers/registry/selfhosted-tts.js | No defect recorded. | — | no recorded defect | — |
| `sensenova` | — | 9router/open-sse/providers/registry/sensenova.js | No defect recorded. | — | no recorded defect | — |
| `sensenova-intl` | — | 9router/open-sse/providers/registry/sensenova-intl.js | No defect recorded. | — | no recorded defect | — |
| `serper` | — | 9router/open-sse/providers/registry/serper.js | No defect recorded. | — | no recorded defect | — |
| `siliconflow` | src/data/providers.ts:1676 | 9router/open-sse/providers/registry/siliconflow.js | No defect recorded. | — | no recorded defect | — |
| `stability-ai` | — | 9router/open-sse/providers/registry/stability-ai.js | No defect recorded. | — | no recorded defect | — |
| `synthetic` | — | 9router/open-sse/providers/registry/synthetic.js | No defect recorded. | — | no recorded defect | — |
| `tavily` | — | 9router/open-sse/providers/registry/tavily.js | No defect recorded. | — | no recorded defect | — |
| `tencent` | — | 9router/open-sse/providers/registry/tencent.js | No defect recorded. | — | no recorded defect | — |
| `tiarina` | src/data/providers.ts:805 | — | No defect recorded. | — | no recorded defect | — |
| `tinyfish` | — | 9router/open-sse/providers/registry/tinyfish.js | No defect recorded. | — | no recorded defect | — |
| `together` | src/data/providers.ts:1589 | 9router/open-sse/providers/registry/together.js | No defect recorded. | — | no recorded defect | — |
| `tokenharbor` | src/data/providers.ts:737 | 9router/open-sse/providers/registry/tokenharbor.js | No defect recorded. | — | no recorded defect | — |
| `tokenharbor-web` | src/data/providers.ts:859 | — | No defect recorded. | — | no recorded defect | — |
| `tokenrouter` | — | 9router/open-sse/providers/registry/tokenrouter.js | No defect recorded. | — | no recorded defect | — |
| `topaz` | — | 9router/open-sse/providers/registry/topaz.js | No defect recorded. | — | no recorded defect | — |
| `tortoise` | — | 9router/open-sse/providers/registry/tortoise.js | No defect recorded. | — | no recorded defect | — |
| `trae` | — | 9router/open-sse/providers/registry/trae.js | No defect recorded. | — | no recorded defect | — |
| `uc-web` | — | 9router/open-sse/providers/registry/uc-web.js | No defect recorded. | — | no recorded defect | — |
| `unorouter` | src/data/providers.ts:599 | — | No defect recorded. | — | no recorded defect | — |
| `v1m` | — | 9router/open-sse/providers/registry/v1m.js | No defect recorded. | — | no recorded defect | — |
| `vengetic` | src/data/providers.ts:539 | — | No defect recorded. | — | no recorded defect | — |
| `venice` | — | 9router/open-sse/providers/registry/venice.js | No defect recorded. | — | no recorded defect | — |
| `veoaifree-web` | — | 9router/open-sse/providers/registry/veoaifree-web.js | No defect recorded. | — | no recorded defect | — |
| `vercel-ai-gateway` | — | 9router/open-sse/providers/registry/vercel-ai-gateway.js | No defect recorded. | — | no recorded defect | — |
| `vertex` | — | 9router/open-sse/providers/registry/vertex.js | No defect recorded. | — | no recorded defect | — |
| `vertex-partner` | — | 9router/open-sse/providers/registry/vertex-partner.js | No defect recorded. | — | no recorded defect | — |
| `volcengine-ark` | — | 9router/open-sse/providers/registry/volcengine-ark.js | No defect recorded. | — | no recorded defect | — |
| `voyage-ai` | — | 9router/open-sse/providers/registry/voyage-ai.js | No defect recorded. | — | no recorded defect | — |
| `windsurf` | — | 9router/open-sse/providers/registry/windsurf.js | No defect recorded. | — | no recorded defect | — |
| `xai` | src/data/providers.ts:1738 | 9router/open-sse/providers/registry/xai.js | The reference ships an async video lane for xAI; OmniHilbras served /v1/videos but refused every job. | 9router/open-sse/providers/registry/xai.js:44 | fixed — dedicated SDK adapter creates and polls real jobs with the pinned connection | Kernel/API/test/video-route.test.js |
| `xiaomi-mimo` | — | 9router/open-sse/providers/registry/xiaomi-mimo.js | No defect recorded. | — | no recorded defect | — |
| `xiaomi-tokenplan` | — | 9router/open-sse/providers/registry/xiaomi-tokenplan.js | No defect recorded. | — | no recorded defect | — |
| `xkiro` | src/data/providers.ts:827 | — | No defect recorded. | — | no recorded defect | — |
| `xquik` | — | 9router/open-sse/providers/registry/xquik.js | No defect recorded. | — | no recorded defect | — |
| `youcom` | — | 9router/open-sse/providers/registry/youcom.js | No defect recorded. | — | no recorded defect | — |
| `zcode` | src/data/providers.ts:1345 | — | No defect recorded. | — | no recorded defect | — |
| `zed` | — | 9router/open-sse/providers/registry/zed.js | The reference ships a registry/OAuth flow for this id; OmniHilbras has no card, adapter or flow. | 9router/open-sse/providers/registry/zed.js:1 | gap — parity backlog | tests/9router-catalog.test.js |
| `zro` | src/data/providers.ts:579 | — | No defect recorded. | — | no recorded defect | — |

