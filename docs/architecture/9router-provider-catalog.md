# 9router provider and model catalog

**Generated file — do not edit by hand.**
Source: `open-sse/providers/registry/*.js` in `/mnt/sda3/work/projects.old/9router`.
Regenerate with `node scripts/build-9router-catalog.mjs`; `node scripts/build-9router-catalog.mjs --check`
fails when the committed file is stale.

| | Count |
| --- | --- |
| Registry entries | 148 |
| Models declared in the registry | 1384 |
| Entries with a static model list | 115 |
| Entries that resolve models at runtime | 33 |

A model id here is a **string the registry declares**. Nothing in this file is a measurement:
none of it was confirmed by calling a provider, and a model id being present is not evidence
that the model is reachable, that it still exists, or that any account can use it. Several
entries list models that only a paid tier serves.

## Entries by category

| Category | Entries |
| --- | --- |
| `apikey` | 91 |
| `oauth` | 25 |
| `freeTier` | 20 |
| `webCookie` | 7 |
| `free` | 5 |

## Models by kind

| Kind | Models |
| --- | --- |
| chat / language | 1006 |
| embeddings (`embedding`) | 131 |
| image generation (`image`) | 117 |
| text-to-speech (`tts`) | 47 |
| video (`video`) | 44 |
| speech-to-text (`stt`) | 25 |
| system (non-LLM) (`systemone`) | 14 |

## Providers

Each entry lists every model the registry file declares. `kind` is shown only when it is
something other than chat.

### apikey

#### `alicode-intl` — Alibaba Coding <sub>[site](https://www.alibabacloud.com/product/coding)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `qwen3.5-plus` | Qwen3.5 Plus | chat |
| `kimi-k2.5` | Kimi K2.5 | chat |
| `glm-5` | GLM 5 | chat |
| `MiniMax-M2.5` | MiniMax M2.5 | chat |
| `qwen3-coder-next` | Qwen3 Coder Next | chat |
| `qwen3-coder-plus` | Qwen3 Coder Plus | chat |
| `glm-4.7` | GLM 4.7 | chat |

#### `alicode` — Alibaba <sub>[site](https://bailian.console.aliyun.com)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `qwen3.5-plus` | Qwen3.5 Plus | chat |
| `kimi-k2.5` | Kimi K2.5 | chat |
| `glm-5` | GLM 5 | chat |
| `MiniMax-M2.5` | MiniMax M2.5 | chat |
| `qwen3-max-2026-01-23` | Qwen3 Max | chat |
| `qwen3-coder-next` | Qwen3 Coder Next | chat |
| `qwen3-coder-plus` | Qwen3 Coder Plus | chat |
| `glm-4.7` | GLM 4.7 | chat |

#### `alims-intl` — Alibaba Studio <sub>[site](https://modelstudio.console.alibabacloud.com)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `qwen3.5-plus` | Qwen3.5 Plus | chat |
| `kimi-k2.5` | Kimi K2.5 | chat |
| `glm-5` | GLM 5 | chat |
| `MiniMax-M2.5` | MiniMax M2.5 | chat |
| `qwen3-coder-next` | Qwen3 Coder Next | chat |
| `qwen3-coder-plus` | Qwen3 Coder Plus | chat |
| `glm-4.7` | GLM 4.7 | chat |

#### `alitp-intl` — Alibaba Token Plan <sub>[site](https://www.alibabacloud.com/campaign/ai-landing-page-token)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `qwen3.8-max-preview` | Qwen3.8 Max Preview | chat |
| `qwen3.7-max` | Qwen3.7 Max | chat |
| `qwen3.7-plus` | Qwen3.7 Plus | chat |
| `qwen3.6-flash` | Qwen3.6 Flash | chat |
| `glm-5.2` | GLM 5.2 | chat |
| `deepseek-v4-pro` | DeepSeek V4 Pro | chat |

#### `anthropic` — Anthropic <sub>[site](https://console.anthropic.com) · `llm`, `imageToText`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `claude-sonnet-4-20250514` | Claude Sonnet 4 | chat |
| `claude-opus-4-20250514` | Claude Opus 4 | chat |
| `claude-3-5-sonnet-20241022` | Claude 3.5 Sonnet | chat |

#### `assemblyai` — AssemblyAI <sub>[site](https://assemblyai.com) · `stt`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `universal-3-pro` | Universal 3 Pro | speech-to-text |
| `universal-2` | Universal 2 | speech-to-text |
| `best` | Best (Nano + Universal) | speech-to-text |
| `nano` | Nano (Fast) | speech-to-text |

#### `atria` — Atria Dawn <sub>[site](https://atria-asi.ai)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `Atria-Dawn-Preview` | Atria Dawn Preview | chat |

#### `aws-polly` — AWS Polly <sub>[site](https://aws.amazon.com/polly/) · `tts`</sub>

- No static model list. This entry resolves its models at runtime — from the account, the
  provider's own catalogue endpoint, or a local daemon — so nothing can be enumerated here.

#### `azure` — Azure OpenAI <sub>[site](https://azure.microsoft.com/en-us/products/ai-services/openai-service)</sub>

- No static model list. This entry resolves its models at runtime — from the account, the
  provider's own catalogue endpoint, or a local daemon — so nothing can be enumerated here.

#### `bai` — B.AI <sub>[site](https://b.ai)</sub>

- No static model list. This entry resolves its models at runtime — from the account, the
  provider's own catalogue endpoint, or a local daemon — so nothing can be enumerated here.

#### `baidu` — Baidu Qianfan <sub>[site](https://cloud.baidu.com/product/qianfan.html)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `deepseek-v4-pro` | DeepSeek V4 Pro | chat |
| `deepseek-v4-flash` | DeepSeek V4 Flash | chat |
| `glm-5.2` | GLM 5.2 | chat |
| `glm-5.1` | GLM 5.1 | chat |
| `kimi-k2.6` | Kimi K2.6 | chat |
| `qwen3.5-397b-a17b` | Qwen 3.5 397B A17B | chat |
| `qwen3.5-27b` | Qwen 3.5 27B | chat |

#### `bedrock-xai` — AWS Bedrock (xAI) <sub>[site](https://aws.amazon.com/bedrock/)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `us.xai.grok-4.6` | Grok 4.6 | chat |
| `global.xai.grok-4.6` | Grok 4.6 (global) | chat |

#### `bedrock` — AWS Bedrock <sub>[site](https://aws.amazon.com/bedrock/)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `us.anthropic.claude-opus-5` | Claude Opus 5 | chat |
| `us.anthropic.claude-sonnet-5` | Claude Sonnet 5 | chat |
| `us.anthropic.claude-fable-5` | Claude Fable 5 | chat |
| `us.anthropic.claude-opus-4-8` | Claude Opus 4.8 | chat |
| `us.anthropic.claude-opus-4-7` | Claude Opus 4.7 | chat |
| `us.anthropic.claude-sonnet-4-6` | Claude Sonnet 4.6 | chat |
| `us.anthropic.claude-3-haiku-20240307-v1:0` | Claude 3 Haiku | chat |

#### `black-forest-labs` — Black Forest Labs <sub>[site](https://blackforestlabs.ai) · `image`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `flux-pro-1.1` | FLUX Pro 1.1 | image generation |
| `flux-pro-1.1-ultra` | FLUX Pro 1.1 Ultra | image generation |
| `flux-pro` | FLUX Pro | image generation |
| `flux-dev` | FLUX Dev | image generation |
| `flux-kontext-pro` | FLUX Kontext Pro (Edit) | image generation |
| `flux-kontext-max` | FLUX Kontext Max (Edit) | image generation |

#### `blackbox` — Blackbox AI <sub>[site](https://blackbox.ai) · `llm`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `claude-fable-5` | Claude Fable 5 | chat |
| `claude-opus-4.8` | Claude Opus 4.8 | chat |
| `claude-sonnet-4.6` | Claude Sonnet 4.6 | chat |
| `gpt-5.5` | GPT-5.5 | chat |
| `gpt-5.4-pro` | GPT-5.4 Pro | chat |
| `gpt-5.4` | GPT-5.4 | chat |
| `gpt-5.3-codex` | GPT-5.3 Codex | chat |
| `gpt-5.4-nano` | GPT-5.4 Nano | chat |
| `deepseek-v4-flash` | DeepSeek V4 Flash | chat |
| `grok-4.3` | Grok 4.3 | chat |

#### `bluesminds` — BluesMinds <sub>[site](https://bluesminds.com)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `gpt-4.1` | GPT-4.1 | chat |
| `gpt-4.1-mini` | GPT-4.1 Mini | chat |
| `gpt-4.1-nano` | GPT-4.1 Nano | chat |
| `claude-sonnet-4-5` | Claude Sonnet 4.5 | chat |
| `claude-haiku-4-5` | Claude Haiku 4.5 | chat |
| `gemini-2.0-flash` | Gemini 2.0 Flash | chat |
| `gemini-2.0-flash-exp` | Gemini 2.0 Flash (Exp) | chat |
| `qwen-turbo` | Qwen Turbo | chat |
| `kimi-k2` | Kimi K2 | chat |
| `kimi-k2-thinking` | Kimi K2 Thinking | chat |
| `glm-4.7` | GLM 4.7 | chat |
| `minimax-m2.5` | MiniMax M2.5 | chat |
| `claude-opus-4-5` | Claude Opus 4.5 (VIP) | chat |
| `gemini-2.5-pro` | Gemini 2.5 Pro (VIP) | chat |

#### `brave-search` — Brave Search <sub>[site](https://brave.com/search/api) · `webSearch`</sub>

- No static model list. This entry resolves its models at runtime — from the account, the
  provider's own catalogue endpoint, or a local daemon — so nothing can be enumerated here.

#### `cartesia` — Cartesia <sub>[site](https://cartesia.ai) · `tts`</sub>

- No static model list. This entry resolves its models at runtime — from the account, the
  provider's own catalogue endpoint, or a local daemon — so nothing can be enumerated here.

#### `cerebras` — Cerebras <sub>[site](https://www.cerebras.ai)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `gpt-oss-120b` | GPT OSS 120B | chat |
| `zai-glm-4.7` | ZAI GLM 4.7 | chat |
| `llama-3.3-70b` | Llama 3.3 70B | chat |
| `llama-4-scout-17b-16e-instruct` | Llama 4 Scout | chat |
| `qwen-3-235b-a22b-instruct-2507` | Qwen3 235B A22B | chat |
| `qwen-3-32b` | Qwen3 32B | chat |

#### `chutes` — Chutes AI <sub>[site](https://chutes.ai)</sub>

- No static model list. This entry resolves its models at runtime — from the account, the
  provider's own catalogue endpoint, or a local daemon — so nothing can be enumerated here.

#### `cohere` — Cohere <sub>[site](https://cohere.com)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `command-r-plus-08-2024` | Command R+ (Aug 2024) | chat |
| `command-r-08-2024` | Command R (Aug 2024) | chat |
| `command-a-03-2025` | Command A (Mar 2025) | chat |

#### `comfyui` — ComfyUI <sub>[site](https://github.com/comfyanonymous/ComfyUI) · `image`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `flux-dev` | FLUX Dev | image generation |
| `sdxl` | SDXL | image generation |

#### `commandcode` — Command Code <sub>[site](https://commandcode.ai)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `deepseek/deepseek-v4-pro` | DeepSeek V4 Pro | chat |
| `deepseek/deepseek-v4-flash` | DeepSeek V4 Flash | chat |
| `moonshotai/Kimi-K3.1-Pro` | Kimi K3.1 Pro | chat |
| `moonshotai/Kimi-K2.7-Code` | Kimi K2.7 Code | chat |
| `moonshotai/Kimi-K2.7-Code-Highspeed` | Kimi K2.7 Code HighSpeed | chat |
| `moonshotai/Kimi-K2.6` | Kimi K2.6 | chat |
| `moonshotai/Kimi-K2.5` | Kimi K2.5 | chat |
| `zai-org/GLM-5.2` | GLM 5.2 | chat |
| `zai-org/GLM-5.2-Fast` | GLM 5.2 Fast | chat |
| `zai-org/GLM-5.1` | GLM 5.1 | chat |
| `zai-org/GLM-5` | GLM 5 | chat |
| `MiniMaxAI/MiniMax-M3` | MiniMax M3 | chat |
| `MiniMaxAI/MiniMax-M2.7` | MiniMax M2.7 | chat |
| `MiniMaxAI/MiniMax-M2.5` | MiniMax M2.5 | chat |
| `xiaomi/mimo-v2.5-pro` | MiMo V2.5 Pro | chat |
| `xiaomi/mimo-v2.5` | MiMo V2.5 | chat |
| `Qwen/Qwen3.6-Max-Preview` | Qwen 3.6 Max Preview | chat |
| `Qwen/Qwen3.6-Plus` | Qwen 3.6 Plus | chat |
| `Qwen/Qwen3.7-Max` | Qwen 3.7 Max | chat |
| `Qwen/Qwen3.7-Plus` | Qwen 3.7 Plus | chat |
| `stepfun/Step-3.7-Flash` | Step 3.7 Flash | chat |
| `stepfun/Step-3.5-Flash` | Step 3.5 Flash | chat |
| `nvidia/nemotron-3-ultra-550b-a55b` | Nemotron 3 Ultra | chat |
| `google/gemini-4-carbon` | Gemini 4 Carbon | chat |
| `claude-fable-5-2` | Claude Fable 5.2 | chat |

#### `dahl` — Dahl Inference <sub>[site](https://dahl.global)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `zai-org/GLM-5.3-Flash` | GLM-5.3 Flash | chat |
| `deepseek-ai/DeepSeek-V4-Flash-0731` | DeepSeek V4 Flash 0731 | chat |
| `MiniMaxAI/MiniMax-M2.7` | MiniMax M2.7 | chat |

#### `deepgram` — Deepgram <sub>[site](https://deepgram.com) · `stt`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `nova-3` | Nova 3 | speech-to-text |
| `nova-2` | Nova 2 | speech-to-text |
| `whisper-large` | Whisper Large | speech-to-text |
| `nova` | Nova | speech-to-text |

#### `deepseek` — DeepSeek <sub>[site](https://deepseek.com)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `deepseek-v4-pro` | DeepSeek V4 Pro | chat |
| `deepseek-v4-pro-max` | DeepSeek V4 Pro Max | chat |
| `deepseek-v4-pro-none` | DeepSeek V4 Pro No Thinking | chat |
| `deepseek-v4.1-flash` | DeepSeek V4.1 Flash | chat |
| `deepseek-v4-flash` | DeepSeek V4 Flash | chat |
| `deepseek-v4-flash-vision-exp` | DeepSeek V4 Flash Vision (Exp) | chat |
| `deepseek-chat` | DeepSeek V3.2 Chat | chat |
| `deepseek-reasoner` | DeepSeek V3.2 Reasoner | chat |

#### `elevenlabs` — ElevenLabs <sub>[site](https://elevenlabs.io) · `tts`, `stt`</sub>

- No static model list. This entry resolves its models at runtime — from the account, the
  provider's own catalogue endpoint, or a local daemon — so nothing can be enumerated here.

#### `exa` — Exa <sub>[site](https://exa.ai) · `webSearch`, `webFetch`</sub>

- No static model list. This entry resolves its models at runtime — from the account, the
  provider's own catalogue endpoint, or a local daemon — so nothing can be enumerated here.

#### `fal-ai` — Fal.ai <sub>[site](https://fal.ai) · `image`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `fal-ai/flux/schnell` | FLUX Schnell | image generation |
| `fal-ai/flux/dev` | FLUX Dev | image generation |
| `fal-ai/flux-pro/v1.1` | FLUX Pro v1.1 | image generation |
| `fal-ai/flux-pro/v1.1-ultra` | FLUX Pro v1.1 Ultra | image generation |
| `fal-ai/recraft-v3` | Recraft V3 | image generation |
| `fal-ai/ideogram/v2` | Ideogram V2 | image generation |
| `fal-ai/stable-diffusion-v35-large` | SD 3.5 Large | image generation |

#### `featherless` — Featherless <sub>[site](https://featherless.ai)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `deepseek-ai/DeepSeek-V4-Pro` | DeepSeek V4 Pro | chat |
| `deepseek-ai/DeepSeek-V4-Flash` | DeepSeek V4 Flash | chat |
| `zai-org/GLM-5.2` | GLM 5.2 | chat |
| `zai-org/GLM-5.1` | GLM 5.1 | chat |
| `moonshotai/Kimi-K2.7-Code` | Kimi K2.7 Code | chat |
| `moonshotai/Kimi-K2.6` | Kimi K2.6 | chat |
| `moonshotai/Kimi-K2.5` | Kimi K2.5 | chat |

#### `firecrawl` — Firecrawl <sub>[site](https://firecrawl.dev) · `webFetch`</sub>

- No static model list. This entry resolves its models at runtime — from the account, the
  provider's own catalogue endpoint, or a local daemon — so nothing can be enumerated here.

#### `fireworks` — Fireworks AI <sub>[site](https://fireworks.ai) · `llm`, `embedding`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `accounts/fireworks/models/deepseek-v3p1` | DeepSeek V3.1 | chat |
| `accounts/fireworks/models/llama-v3p3-70b-instruct` | Llama 3.3 70B | chat |
| `accounts/fireworks/models/qwen3-235b-a22b` | Qwen3 235B | chat |
| `nomic-ai/nomic-embed-text-v1.5` | Nomic Embed Text v1.5 | embeddings |

#### `fish-audio` — Fish Audio <sub>[site](https://fish.audio) · `tts`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `s2.1-pro-free` | S2.1 Pro Free | chat |
| `s2.1-pro` | S2.1 Pro | chat |
| `s2-pro` | S2 Pro | chat |
| `s1` | S1 | chat |

#### `glm-cn` — GLM (China) <sub>[site](https://open.bigmodel.cn)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `glm-5.3` | GLM 5.3 | chat |
| `glm-5.3-flash` | GLM 5.3 Flash (Vision) | chat |
| `glm-5.2` | GLM 5.2 | chat |
| `glm-5.1` | GLM 5.1 | chat |
| `glm-5-turbo` | GLM 5 Turbo | chat |
| `glm-5` | GLM 5 | chat |
| `glm-4.7` | GLM-4.7 | chat |
| `glm-4.6v` | GLM 4.6V (Vision) | chat |
| `glm-4.6` | GLM-4.6 | chat |
| `glm-4.5-air` | GLM-4.5-Air | chat |

#### `google-pse` — Google PSE <sub>[site](https://programmablesearchengine.google.com) · `webSearch`</sub>

- No static model list. This entry resolves its models at runtime — from the account, the
  provider's own catalogue endpoint, or a local daemon — so nothing can be enumerated here.

#### `groq` — Groq <sub>[site](https://groq.com) · `llm`, `imageToText`, `stt`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `llama-3.3-70b-versatile` | Llama 3.3 70B | chat |
| `meta-llama/llama-4-maverick-17b-128e-instruct` | Llama 4 Maverick | chat |
| `qwen/qwen3-32b` | Qwen3 32B | chat |
| `openai/gpt-oss-120b` | GPT-OSS 120B | chat |
| `whisper-large-v3` | Whisper Large v3 | speech-to-text |
| `whisper-large-v3-turbo` | Whisper Large v3 Turbo | speech-to-text |
| `distil-whisper-large-v3-en` | Distil Whisper Large v3 EN | speech-to-text |

#### `huggingface` — HuggingFace <sub>[site](https://huggingface.co) · `image`, `stt`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `black-forest-labs/FLUX.1-schnell` | FLUX.1 Schnell | image generation |
| `black-forest-labs/FLUX.1-dev` | FLUX.1 Dev | image generation |
| `black-forest-labs/FLUX.1-Krea-dev` | FLUX.1 Krea | image generation |
| `black-forest-labs/FLUX.1-Kontext-dev` | FLUX.1 Kontext | image generation |
| `black-forest-labs/FLUX.2-dev` | FLUX.2 Dev | image generation |
| `black-forest-labs/FLUX.2-klein-9B` | FLUX.2 Klein 9B | image generation |
| `black-forest-labs/FLUX.2-klein-4B` | FLUX.2 Klein 4B | image generation |
| `black-forest-labs/FLUX.2-klein-base-9B` | FLUX.2 Klein Base 9B | image generation |
| `black-forest-labs/FLUX.2-klein-base-4B` | FLUX.2 Klein Base 4B | image generation |
| `stabilityai/stable-diffusion-xl-base-1.0` | SDXL Base 1.0 | image generation |
| `stabilityai/stable-diffusion-3.5-large` | Stable Diffusion 3.5 Large | image generation |
| `stabilityai/stable-diffusion-3.5-large-turbo` | Stable Diffusion 3.5 Large Turbo | image generation |
| `Qwen/Qwen-Image` | Qwen Image | image generation |
| `Qwen/Qwen-Image-2512` | Qwen Image 2512 | image generation |
| `Qwen/Qwen-Image-Edit` | Qwen Image Edit | image generation |
| `Qwen/Qwen-Image-Edit-2509` | Qwen Image Edit 2509 | image generation |
| `Qwen/Qwen-Image-Edit-2511` | Qwen Image Edit 2511 | image generation |
| `ideogram-ai/ideogram-4-fp8` | Ideogram 4 | image generation |
| `tencent/HunyuanImage-3.0` | HunyuanImage 3.0 | image generation |
| `Tongyi-MAI/Z-Image-Turbo` | Z-Image Turbo | image generation |
| `krea/Krea-2-Turbo` | Krea 2 Turbo | image generation |
| `HiDream-ai/HiDream-I1-Fast` | HiDream I1 Fast | image generation |
| `playgroundai/playground-v2.5-1024px-aesthetic` | Playground v2.5 | image generation |
| `openai/whisper-large-v3` | Whisper Large v3 (HF) | speech-to-text |
| `openai/whisper-large-v3-turbo` | Whisper Large v3 Turbo (HF) | speech-to-text |

#### `hyperbolic` — Hyperbolic <sub>[site](https://hyperbolic.xyz)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `Qwen/QwQ-32B` | QwQ 32B | chat |
| `deepseek-ai/DeepSeek-R1` | DeepSeek R1 | chat |
| `deepseek-ai/DeepSeek-V3` | DeepSeek V3 | chat |
| `meta-llama/Llama-3.3-70B-Instruct` | Llama 3.3 70B | chat |
| `meta-llama/Llama-3.2-3B-Instruct` | Llama 3.2 3B | chat |
| `Qwen/Qwen2.5-72B-Instruct` | Qwen 2.5 72B | chat |
| `Qwen/Qwen2.5-Coder-32B-Instruct` | Qwen 2.5 Coder 32B | chat |
| `NousResearch/Hermes-3-Llama-3.1-70B` | Hermes 3 70B | chat |

#### `inworld` — Inworld TTS <sub>[site](https://inworld.ai) · `tts`</sub>

- No static model list. This entry resolves its models at runtime — from the account, the
  provider's own catalogue endpoint, or a local daemon — so nothing can be enumerated here.

#### `jina-ai` — Jina AI <sub>[site](https://jina.ai) · `embedding`</sub>

- No static model list. This entry resolves its models at runtime — from the account, the
  provider's own catalogue endpoint, or a local daemon — so nothing can be enumerated here.

#### `jina-reader` — Jina Reader <sub>[site](https://jina.ai/reader) · `webFetch`</sub>

- No static model list. This entry resolves its models at runtime — from the account, the
  provider's own catalogue endpoint, or a local daemon — so nothing can be enumerated here.

#### `linkup` — Linkup <sub>[site](https://linkup.so) · `webSearch`</sub>

- No static model list. This entry resolves its models at runtime — from the account, the
  provider's own catalogue endpoint, or a local daemon — so nothing can be enumerated here.

#### `llm7` — LLM7 <sub>[site](https://llm7.io)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `gpt-5.5` | GPT-5.5 (LLM7) | chat |
| `claude-opus-5` | Claude Opus 5 (LLM7) | chat |
| `deepseek-v4-flash` | DeepSeek V4 Flash (LLM7) | chat |
| `grok-4.5` | Grok 4.5 (LLM7) | chat |
| `kimi-k3` | Kimi K3 (LLM7) | chat |

#### `minimax-cn` — Minimax (China) <sub>[site](https://www.minimaxi.com) · `llm`, `tts`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `MiniMax-M3` | MiniMax M3 | chat |
| `MiniMax-M2.7` | MiniMax M2.7 | chat |
| `MiniMax-M2.5` | MiniMax M2.5 | chat |
| `MiniMax-M2.1` | MiniMax M2.1 | chat |
| `speech-2.8-hd` | Speech 2.8 HD | text-to-speech |
| `speech-2.8-turbo` | Speech 2.8 Turbo | text-to-speech |
| `speech-2.6-hd` | Speech 2.6 HD | text-to-speech |
| `speech-2.6-turbo` | Speech 2.6 Turbo | text-to-speech |
| `speech-02-hd` | Speech 02 HD | text-to-speech |
| `speech-02-turbo` | Speech 02 Turbo | text-to-speech |
| `speech-01-hd` | Speech 01 HD | text-to-speech |
| `speech-01-turbo` | Speech 01 Turbo | text-to-speech |

#### `minimax` — Minimax Coding <sub>[site](https://www.minimaxi.com) · `llm`, `image`, `imageToText`, `webSearch`, `tts`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `MiniMax-M3` | MiniMax M3 | chat |
| `MiniMax-M2.7` | MiniMax M2.7 | chat |
| `MiniMax-M2.5` | MiniMax M2.5 | chat |
| `MiniMax-M2.1` | MiniMax M2.1 | chat |
| `minimax-image-01` | MiniMax Image 01 | image generation |
| `speech-2.8-hd` | Speech 2.8 HD | text-to-speech |
| `speech-2.8-turbo` | Speech 2.8 Turbo | text-to-speech |
| `speech-2.6-hd` | Speech 2.6 HD | text-to-speech |
| `speech-2.6-turbo` | Speech 2.6 Turbo | text-to-speech |
| `speech-02-hd` | Speech 02 HD | text-to-speech |
| `speech-02-turbo` | Speech 02 Turbo | text-to-speech |
| `speech-01-hd` | Speech 01 HD | text-to-speech |
| `speech-01-turbo` | Speech 01 Turbo | text-to-speech |

#### `mistral` — Mistral <sub>[site](https://mistral.ai) · `llm`, `imageToText`, `embedding`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `mistral-large-latest` | Mistral Large 3 | chat |
| `codestral-latest` | Codestral | chat |
| `mistral-medium-latest` | Mistral Medium 3 | chat |
| `mistral-embed` | Mistral Embed | embeddings |

#### `mmf` — MMF

| Model id | Name | Kind |
| --- | --- | --- |
| `mimo-auto` | MiMo Auto | chat |

#### `morph` — Morph <sub>[site](https://morphllm.com)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `morph-v3-large` | Morph v3 Large | chat |
| `morph-v3-fast` | Morph v3 Fast | chat |
| `morph-qwen35-397b` | Qwen 3.5 397B (Morph) | chat |
| `morph-minimax27-230b` | MiniMax M2.7 (Morph) | chat |
| `morph-qwen36-27b` | Qwen 3.6 27B (Morph) | chat |
| `morph-dsv4flash` | DeepSeek V4 Flash (Morph) | chat |

#### `nace` — Nace Drex <sub>[site](https://console.nace.ai) · `systemone`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `drex-max` | Drex Max | system (non-LLM) |
| `drex-v2.0` | Drex 2.0 | system (non-LLM) |

#### `nanobanana` — NanoBanana API <sub>[site](https://nanobananaapi.ai) · `image`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `nanobanana-flash` | NanoBanana Flash | image generation |
| `nanobanana-pro` | NanoBanana Pro | image generation |

#### `nebius` — Nebius AI <sub>[site](https://nebius.com) · `llm`, `embedding`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `meta-llama/Llama-3.3-70B-Instruct` | Llama 3.3 70B Instruct | chat |
| `Qwen/Qwen3-Embedding-8B` | Qwen3 Embedding 8B | embeddings |

#### `ollama-local` — Ollama Local <sub>[site](https://ollama.com) · `llm`, `systemone`, `tts`, `embedding`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `clef` | Clef | system (non-LLM) |
| `clef-flash` | Clef Flash | system (non-LLM) |
| `phonon:latest` | Phonon (Latest) | text-to-speech |
| `phonon` | Phonon | text-to-speech |
| `phonon:multilingual` | Phonon Multilingual | text-to-speech |
| `phonon:40m-multilingual` | Phonon 40M Multilingual | text-to-speech |
| `phonon:en` | Phonon English | text-to-speech |
| `phonon:31m-en` | Phonon 31M English | text-to-speech |
| `phonon:40m-en` | Phonon 40M English | text-to-speech |
| `phonon:de` | Phonon German | text-to-speech |
| `phonon:40m-de` | Phonon 40M German | text-to-speech |
| `phonon:es` | Phonon Spanish | text-to-speech |
| `phonon:40m-es` | Phonon 40M Spanish | text-to-speech |
| `phonon:fr` | Phonon French | text-to-speech |
| `phonon:40m-fr` | Phonon 40M French | text-to-speech |
| `phonon:pt` | Phonon Portuguese | text-to-speech |
| `phonon:40m-pt` | Phonon 40M Portuguese | text-to-speech |
| `nomic-embed-text` | Nomic Embed Text | embeddings |
| `nomic-embed-text:latest` | Nomic Embed Text (Latest) | embeddings |
| `nomic-embed-text:v1.5` | Nomic Embed Text v1.5 | embeddings |
| `nomic-embed-text:137m-v1.5-fp16` | Nomic Embed Text 137M v1.5 (FP16) | embeddings |
| `nomic-embed-text-v2-moe` | Nomic Embed Text v2 MoE | embeddings |
| `nomic-embed-text-v2-moe:latest` | Nomic Embed Text v2 MoE (Latest) | embeddings |
| `qwen3-embedding` | Qwen3 Embedding | embeddings |
| `qwen3-embedding:latest` | Qwen3 Embedding (Latest) | embeddings |
| `qwen3-embedding:8b` | Qwen3 Embedding 8B | embeddings |
| `qwen3-embedding:8b-q4_K_M` | Qwen3 Embedding 8B (Q4_K_M) | embeddings |
| `qwen3-embedding:8b-q8_0` | Qwen3 Embedding 8B (Q8_0) | embeddings |
| `qwen3-embedding:8b-fp16` | Qwen3 Embedding 8B (FP16) | embeddings |
| `qwen3-embedding:4b` | Qwen3 Embedding 4B | embeddings |
| `qwen3-embedding:4b-q4_K_M` | Qwen3 Embedding 4B (Q4_K_M) | embeddings |
| `qwen3-embedding:4b-q8_0` | Qwen3 Embedding 4B (Q8_0) | embeddings |
| `qwen3-embedding:4b-fp16` | Qwen3 Embedding 4B (FP16) | embeddings |
| `qwen3-embedding:0.6b` | Qwen3 Embedding 0.6B | embeddings |
| `qwen3-embedding:0.6b-q8_0` | Qwen3 Embedding 0.6B (Q8_0) | embeddings |
| `qwen3-embedding:0.6b-fp16` | Qwen3 Embedding 0.6B (FP16) | embeddings |
| `bge-m3` | BGE M3 | embeddings |
| `bge-m3:latest` | BGE M3 (Latest) | embeddings |
| `bge-m3:567m` | BGE M3 567M | embeddings |
| `bge-m3:567m-fp16` | BGE M3 567M (FP16) | embeddings |
| `bge-large` | BGE Large | embeddings |
| `bge-large:latest` | BGE Large (Latest) | embeddings |
| `bge-large:335m` | BGE Large 335M | embeddings |
| `bge-large:335m-en-v1.5-fp16` | BGE Large 335M EN v1.5 (FP16) | embeddings |
| `mxbai-embed-large` | mxbai Embed Large | embeddings |
| `mxbai-embed-large:latest` | mxbai Embed Large (Latest) | embeddings |
| `mxbai-embed-large:335m` | mxbai Embed Large 335M | embeddings |
| `mxbai-embed-large:v1` | mxbai Embed Large v1 | embeddings |
| `mxbai-embed-large:335m-v1-fp16` | mxbai Embed Large 335M v1 (FP16) | embeddings |
| `embeddinggemma` | EmbeddingGemma | embeddings |
| `embeddinggemma:latest` | EmbeddingGemma (Latest) | embeddings |
| `embeddinggemma:300m` | EmbeddingGemma 300M | embeddings |
| `embeddinggemma:300m-bf16` | EmbeddingGemma 300M (BF16) | embeddings |
| `embeddinggemma:300m-qat-q4_0` | EmbeddingGemma 300M (QAT Q4_0) | embeddings |
| `embeddinggemma:300m-qat-q8_0` | EmbeddingGemma 300M (QAT Q8_0) | embeddings |
| `embeddinggemma-2` | EmbeddingGemma 2 | embeddings |
| `embeddinggemma-2:latest` | EmbeddingGemma 2 (Latest) | embeddings |
| `embeddinggemma-2:740m` | EmbeddingGemma 2 740M | embeddings |
| `embeddinggemma-2:740m-bf16` | EmbeddingGemma 2 740M (BF16) | embeddings |
| `embeddinggemma-2:740m-q8_0` | EmbeddingGemma 2 740M (Q8_0) | embeddings |
| `embeddinggemma-2:570m` | EmbeddingGemma 2 570M | embeddings |
| `embeddinggemma-2:570m-bf16-text-audio` | EmbeddingGemma 2 570M Audio (BF16) | embeddings |
| `embeddinggemma-2:570m-q8_0-text-audio` | EmbeddingGemma 2 570M Audio (Q8_0) | embeddings |
| `embeddinggemma-2:440m` | EmbeddingGemma 2 440M | embeddings |
| `embeddinggemma-2:440m-bf16-text-vision` | EmbeddingGemma 2 440M Vision (BF16) | embeddings |
| `embeddinggemma-2:440m-q8_0-text-vision` | EmbeddingGemma 2 440M Vision (Q8_0) | embeddings |
| `embeddinggemma-2:270m` | EmbeddingGemma 2 270M | embeddings |
| `embeddinggemma-2:270m-bf16-text` | EmbeddingGemma 2 270M Text (BF16) | embeddings |
| `embeddinggemma-2:270m-q8_0-text` | EmbeddingGemma 2 270M Text (Q8_0) | embeddings |
| `all-minilm` | All-MiniLM | embeddings |
| `all-minilm:latest` | All-MiniLM (Latest) | embeddings |
| `all-minilm:33m` | All-MiniLM 33M (L12) | embeddings |
| `all-minilm:22m` | All-MiniLM 22M (L6) | embeddings |
| `all-minilm:l12-v2` | All-MiniLM L12 v2 | embeddings |
| `all-minilm:l6-v2` | All-MiniLM L6 v2 | embeddings |
| `all-minilm:33m-l12-v2-fp16` | All-MiniLM 33M L12 v2 (FP16) | embeddings |
| `all-minilm:22m-l6-v2-fp16` | All-MiniLM 22M L6 v2 (FP16) | embeddings |
| `snowflake-arctic-embed` | Snowflake Arctic Embed | embeddings |
| `snowflake-arctic-embed:latest` | Snowflake Arctic Embed (Latest) | embeddings |
| `snowflake-arctic-embed:335m` | Snowflake Arctic Embed 335M (L) | embeddings |
| `snowflake-arctic-embed:137m` | Snowflake Arctic Embed 137M (M-Long) | embeddings |
| `snowflake-arctic-embed:110m` | Snowflake Arctic Embed 110M (M) | embeddings |
| `snowflake-arctic-embed:33m` | Snowflake Arctic Embed 33M (S) | embeddings |
| `snowflake-arctic-embed:22m` | Snowflake Arctic Embed 22M (XS) | embeddings |
| `snowflake-arctic-embed:l` | Snowflake Arctic Embed L | embeddings |
| `snowflake-arctic-embed:m` | Snowflake Arctic Embed M | embeddings |
| `snowflake-arctic-embed:m-long` | Snowflake Arctic Embed M-Long | embeddings |
| `snowflake-arctic-embed:s` | Snowflake Arctic Embed S | embeddings |
| `snowflake-arctic-embed:xs` | Snowflake Arctic Embed XS | embeddings |
| `snowflake-arctic-embed:335m-l-fp16` | Snowflake Arctic Embed 335M L (FP16) | embeddings |
| `snowflake-arctic-embed:137m-m-long-fp16` | Snowflake Arctic Embed 137M M-Long (FP16) | embeddings |
| `snowflake-arctic-embed:110m-m-fp16` | Snowflake Arctic Embed 110M M (FP16) | embeddings |
| `snowflake-arctic-embed:33m-s-fp16` | Snowflake Arctic Embed 33M S (FP16) | embeddings |
| `snowflake-arctic-embed:22m-xs-fp16` | Snowflake Arctic Embed 22M XS (FP16) | embeddings |
| `snowflake-arctic-embed2` | Snowflake Arctic Embed 2 | embeddings |
| `snowflake-arctic-embed2:latest` | Snowflake Arctic Embed 2 (Latest) | embeddings |
| `snowflake-arctic-embed2:568m` | Snowflake Arctic Embed 2 568M | embeddings |
| `snowflake-arctic-embed2:568m-l-fp16` | Snowflake Arctic Embed 2 568M L (FP16) | embeddings |
| `granite-embedding` | Granite Embedding | embeddings |
| `granite-embedding:latest` | Granite Embedding (Latest) | embeddings |
| `granite-embedding:278m` | Granite Embedding 278M (Multilingual) | embeddings |
| `granite-embedding:30m` | Granite Embedding 30M (EN) | embeddings |
| `granite-embedding:30m-en` | Granite Embedding 30M EN | embeddings |
| `granite-embedding:278m-fp16` | Granite Embedding 278M (FP16) | embeddings |
| `granite-embedding:30m-en-fp16` | Granite Embedding 30M EN (FP16) | embeddings |
| `paraphrase-multilingual` | Paraphrase Multilingual | embeddings |
| `paraphrase-multilingual:latest` | Paraphrase Multilingual (Latest) | embeddings |
| `paraphrase-multilingual:278m` | Paraphrase Multilingual 278M | embeddings |
| `paraphrase-multilingual:278m-mpnet-base-v2-fp16` | Paraphrase Multilingual 278M (FP16) | embeddings |
| `laya` | Laya | embeddings |
| `laya:latest` | Laya (Latest) | embeddings |
| `laya:421m-english-bf16` | Laya 421M English (BF16) | embeddings |
| `laya:322m-multilingual-bf16` | Laya 322M Multilingual (BF16) | embeddings |
| `laya:421m-typed-decisions-bf16` | Laya 421M Decisions (BF16) | embeddings |

#### `ollama-search` — Ollama Search <sub>[site](https://ollama.com) · `webSearch`</sub>

- No static model list. This entry resolves its models at runtime — from the account, the
  provider's own catalogue endpoint, or a local daemon — so nothing can be enumerated here.

#### `openai` — OpenAI <sub>[site](https://platform.openai.com) · `llm`, `embedding`, `tts`, `stt`, `image`, `imageToText`, `webSearch`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `gpt-5.5` | GPT-5.5 | chat |
| `gpt-5.4` | GPT-5.4 | chat |
| `gpt-5.4-mini` | GPT-5.4 Mini | chat |
| `gpt-5.4-nano` | GPT-5.4 Nano | chat |
| `gpt-5.2` | GPT-5.2 | chat |
| `gpt-5.1` | GPT-5.1 | chat |
| `gpt-5` | GPT-5 | chat |
| `gpt-5-mini` | GPT-5 Mini | chat |
| `gpt-5-nano` | GPT-5 Nano | chat |
| `gpt-4o` | GPT-4o | chat |
| `gpt-4o-mini` | GPT-4o Mini | chat |
| `gpt-4-turbo` | GPT-4 Turbo | chat |
| `gpt-4.1` | GPT-4.1 | chat |
| `gpt-4.1-mini` | GPT-4.1 Mini | chat |
| `gpt-4.1-nano` | GPT-4.1 Nano | chat |
| `o3` | O3 | chat |
| `o3-mini` | O3 Mini | chat |
| `o3-pro` | O3 Pro | chat |
| `o4-mini` | O4 Mini | chat |
| `o1` | O1 | chat |
| `o1-mini` | O1 Mini | chat |
| `text-embedding-3-large` | Text Embedding 3 Large | embeddings |
| `text-embedding-3-small` | Text Embedding 3 Small | embeddings |
| `text-embedding-ada-002` | Text Embedding Ada 002 | embeddings |
| `tts-1` | TTS-1 | text-to-speech |
| `tts-1-hd` | TTS-1 HD | text-to-speech |
| `gpt-4o-mini-tts` | GPT-4o Mini TTS | text-to-speech |
| `whisper-1` | Whisper 1 | speech-to-text |
| `gpt-4o-transcribe` | GPT-4o Transcribe | speech-to-text |
| `gpt-4o-mini-transcribe` | GPT-4o Mini Transcribe | speech-to-text |
| `gpt-image-2.5` | GPT Image 2.5 | image generation |
| `gpt-image-2.5-flare` | GPT Image 2.5 Flare | image generation |
| `gpt-image-2.5-sunburst` | GPT Image 2.5 Sunburst | image generation |
| `gpt-image-1` | GPT Image 1 | image generation |
| `dall-e-3` | DALL-E 3 | image generation |
| `dall-e-2` | DALL-E 2 | image generation |

#### `opencode-go` — OpenCode Go <sub>[site](https://opencode.ai/auth)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `deepseek-flash` | DeepSeek Flash | chat |
| `glm-5.3-flash` | GLM 5.3 Flash (Vision) | chat |
| `glm-5.3` | GLM 5.3 | chat |
| `glm-5.2` | GLM 5.2 | chat |
| `glm-5.1` | GLM 5.1 | chat |
| `glm-5` | GLM 5 | chat |
| `kimi-k2.7-code` | Kimi K2.7 Code | chat |
| `kimi-k2.6` | Kimi K2.6 | chat |
| `kimi-k2.5` | Kimi K2.5 | chat |
| `kimi-k3` | Kimi K3 | chat |
| `kimi-k3.1-pro` | Kimi K3.1 Pro | chat |
| `deepseek-v4-pro` | DeepSeek V4 Pro | chat |
| `deepseek-v4-flash` | DeepSeek V4 Flash | chat |
| `deepseek-v4-flash-vision-exp` | DeepSeek V4 Flash Vision (Exp) | chat |
| `deepseek-v4.1-flash` | DeepSeek V4.1 Flash | chat |
| `longcat-2.0` | LongCat 2.0 | chat |
| `mimo-v2.6-flash` | MiMo V2.6 Flash | chat |
| `mimo-v2.6-pro` | MiMo V2.6 Pro | chat |
| `mimo-v2.5` | MiMo V2.5 | chat |
| `mimo-v2.5-pro` | MiMo V2.5 Pro | chat |
| `mimo-v2-pro` | MiMo V2 Pro | chat |
| `mimo-v2-omni` | MiMo V2 Omni | chat |
| `minimax-m3` | MiniMax M3 | chat |
| `minimax-m2.7` | MiniMax M2.7 | chat |
| `minimax-m2.5` | MiniMax M2.5 | chat |
| `space-bunny-free` | Space Bunny Free | chat |
| `qwen3.8-max` | Qwen 3.8 Max | chat |
| `qwen3.8-flash` | Qwen 3.8 Flash | chat |
| `qwen3.7-max` | Qwen 3.7 Max | chat |
| `qwen3.7-plus` | Qwen 3.7 Plus | chat |
| `qwen3.6-plus` | Qwen 3.6 Plus | chat |
| `qwen3.5-plus` | Qwen 3.5 Plus | chat |
| `hy4-preview` | Hy4 Preview | chat |
| `hy3` | Hy3 | chat |
| `hy3-preview` | Hy3 Preview | chat |
| `omen-alpha` | Omen Alpha | chat |
| `grok-4.7` | Grok 4.7 | chat |
| `grok-4.6` | Grok 4.6 | chat |
| `grok-4.5` | Grok 4.5 | chat |
| `gpt-5.6-luna` | GPT 5.6 Luna | chat |
| `gpt-6-luna` | GPT 6 Luna | chat |
| `muse-spark-1.2-contributor` | Muse Spark 1.2 Contributor | chat |
| `muse-spark-1.3-contributor` | Muse Spark 1.3 Contributor | chat |
| `claude-haiku-5-5` | Claude Haiku 5.5 | chat |

#### `opencode-zen` — OpenCode Zen <sub>[site](https://opencode.ai/auth) · `llm`, `systemone`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `claude-fable-5` | Claude Fable 5 | chat |
| `claude-opus-5` | Claude Opus 5 | chat |
| `claude-opus-4-8` | Claude Opus 4.8 | chat |
| `claude-opus-4-7` | Claude Opus 4.7 | chat |
| `claude-opus-4-6` | Claude Opus 4.6 | chat |
| `claude-opus-4-5` | Claude Opus 4.5 | chat |
| `claude-sonnet-5` | Claude Sonnet 5 | chat |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | chat |
| `claude-sonnet-4-5` | Claude Sonnet 4.5 | chat |
| `claude-sonnet-4` | Claude Sonnet 4 | chat |
| `claude-haiku-4-5` | Claude Haiku 4.5 | chat |
| `gemini-3.6-flash` | Gemini 3.6 Flash | chat |
| `gemini-3.8-flash` | Gemini 3.8 Flash | chat |
| `gemini-3.7-flash` | Gemini 3.7 Flash | chat |
| `gemini-3.5-flash-lite` | Gemini 3.5 Flash Lite | chat |
| `gemini-3.5-flash` | Gemini 3.5 Flash | chat |
| `gemini-3.1-pro` | Gemini 3.1 Pro | chat |
| `gemini-3-flash` | Gemini 3 Flash | chat |
| `gpt-6-astra` | GPT 6 Astra | chat |
| `gpt-5.6-sol` | GPT 5.6 Sol | chat |
| `gpt-5.6-terra` | GPT 5.6 Terra | chat |
| `gpt-5.6-luna` | GPT 5.6 Luna | chat |
| `gpt-5.5` | GPT 5.5 | chat |
| `gpt-5.5-pro` | GPT 5.5 Pro | chat |
| `gpt-5.4` | GPT 5.4 | chat |
| `gpt-5.4-pro` | GPT 5.4 Pro | chat |
| `gpt-5.4-mini` | GPT 5.4 Mini | chat |
| `gpt-5.4-nano` | GPT 5.4 Nano | chat |
| `gpt-5.3-codex-spark` | GPT 5.3 Codex Spark | chat |
| `gpt-5.3-codex` | GPT 5.3 Codex | chat |
| `gpt-5.2` | GPT 5.2 | chat |
| `gpt-5.2-codex` | GPT 5.2 Codex | chat |
| `gpt-5.1` | GPT 5.1 | chat |
| `gpt-5.1-codex-max` | GPT 5.1 Codex Max | chat |
| `gpt-5.1-codex` | GPT 5.1 Codex | chat |
| `gpt-5.1-codex-mini` | GPT 5.1 Codex Mini | chat |
| `gpt-5` | GPT 5 | chat |
| `gpt-5-codex` | GPT 5 Codex | chat |
| `gpt-5-nano` | GPT 5 Nano | chat |
| `grok-build-0.1` | Grok Build 0.1 | chat |
| `grok-4.6` | Grok 4.6 | chat |
| `grok-4.5` | Grok 4.5 | chat |
| `muse-spark-1.3` | Muse Spark 1.3 | chat |
| `muse-spark-1.2` | Muse Spark 1.2 | chat |
| `qwen3.6-plus` | Qwen 3.6 Plus | chat |
| `qwen3.5-plus` | Qwen 3.5 Plus | chat |
| `deepseek-v4-pro` | DeepSeek V4 Pro | chat |
| `deepseek-v4-flash` | DeepSeek V4 Flash | chat |
| `deepseek-v4-flash-vision-exp` | DeepSeek V4 Flash Vision Exp | chat |
| `glm-5.3-flash` | GLM 5.3 Flash (Vision) | chat |
| `glm-5.3` | GLM 5.3 | chat |
| `glm-5.2` | GLM 5.2 | chat |
| `glm-5.1` | GLM 5.1 | chat |
| `glm-5` | GLM 5 | chat |
| `minimax-m3` | MiniMax M3 | chat |
| `minimax-m2.7` | MiniMax M2.7 | chat |
| `minimax-m2.5` | MiniMax M2.5 | chat |
| `kimi-k3` | Kimi K3 | chat |
| `kimi-k2.7-code` | Kimi K2.7 Code | chat |
| `kimi-k2.6` | Kimi K2.6 | chat |
| `kimi-k2.5` | Kimi K2.5 | chat |
| `big-pickle` | Big Pickle | chat |
| `union-alpha` | Union Alpha | chat |
| `deepseek-v4-flash-free` | DeepSeek V4 Flash Free | chat |
| `mimo-v2.6-flash-free` | MiMo V2.6 Flash Free | chat |
| `mimo-v2.5-free` | MiMo V2.5 Free | chat |
| `ling-3.0-flash-fin-free` | Ling 3.0 Flash Fin Free | chat |
| `nemotron-3-ultra-free` | Nemotron 3 Ultra Free | chat |
| `nemotron-3.5-lightning-free` | Nemotron 3.5 Lightning Free | chat |
| `muse-spark-1.3-contributor-free` | Muse Spark 1.3 Contributor Free | chat |
| `muse-spark-1.2-contributor-free` | Muse Spark 1.2 Contributor Free | chat |
| `jev-1.13` | Jev 1.13 | system (non-LLM) |
| `jev-1.13-free` | Jev 1.13 Free | system (non-LLM) |

#### `perplexity-agent` — Perplexity Agent <sub>[site](https://www.perplexity.ai) · `llm`, `webSearch`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `perplexity/sonar` | Perplexity Sonar | chat |
| `openai/gpt-5.5` | GPT-5.5 | chat |
| `openai/gpt-5.4` | GPT-5.4 | chat |
| `openai/gpt-5.4-mini` | GPT-5.4 Mini | chat |
| `anthropic/claude-sonnet-4-6` | Claude Sonnet 4.6 | chat |
| `anthropic/claude-opus-4-8` | Claude Opus 4.8 | chat |
| `google/gemini-3.1-pro-preview` | Gemini 3.1 Pro | chat |
| `xai/grok-4.20-reasoning` | Grok 4.20 Reasoning | chat |
| `perplexity/glm-5.2` | GLM 5.2 | chat |
| `perplexity/kimi-k2.7-code` | Kimi K2.7 Code | chat |
| `nvidia/nemotron-3-super-120b-a12b` | Nemotron 3 Super 120B | chat |

#### `perplexity` — Perplexity <sub>[site](https://www.perplexity.ai) · `llm`, `webSearch`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `sonar-pro` | Sonar Pro | chat |
| `sonar` | Sonar | chat |

#### `playht` — PlayHT <sub>[site](https://play.ht) · `tts`</sub>

- No static model list. This entry resolves its models at runtime — from the account, the
  provider's own catalogue endpoint, or a local daemon — so nothing can be enumerated here.

#### `recraft` — Recraft <sub>[site](https://recraft.ai) · `image`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `recraftv3` | Recraft V3 | image generation |
| `recraftv2` | Recraft V2 | image generation |

#### `runcrate` — Runcrate <sub>[site](https://www.runcrate.ai/inference/free?utm_source=9router&utm_medium=directory&utm_campaign=gpu_pricing)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `deepseek-ai/DeepSeek-V4.1-Flash` | DeepSeek V4.1 Flash | chat |
| `deepseek-ai/DeepSeek-V4.1-Flash-1017` | DeepSeek V4.1 Flash 1017 | chat |
| `zai-org/GLM-5.3` | GLM 5.3 | chat |
| `zai-org/GLM-5.3-Flash` | GLM 5.3 Flash | chat |
| `Qwen/Qwen3.8-Flash` | Qwen3.8 Flash | chat |
| `openai/gpt-oss-120b` | gpt-oss 120B | chat |

#### `runwayml` — Runway ML <sub>[site](https://runwayml.com) · `image`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `gen4_image` | Gen-4 Image | image generation |
| `gen4_image_turbo` | Gen-4 Image Turbo | image generation |
| `gen4_turbo` | Gen-4 Turbo | video |
| `gen3a_turbo` | Gen-3 Alpha Turbo | video |

#### `sambanova` — SambaNova <sub>[site](https://sambanova.ai)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `MiniMax-M2.7` | MiniMax M2.7 | chat |

#### `sdwebui` — SD WebUI <sub>[site](https://github.com/AUTOMATIC1111/stable-diffusion-webui) · `image`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `stable-diffusion-v1-5` | Stable Diffusion v1.5 | image generation |
| `sdxl-base-1.0` | SDXL Base 1.0 | image generation |

#### `searchapi` — SearchAPI <sub>[site](https://www.searchapi.io) · `webSearch`</sub>

- No static model list. This entry resolves its models at runtime — from the account, the
  provider's own catalogue endpoint, or a local daemon — so nothing can be enumerated here.

#### `selfhosted-embedding` — Self-hosted Embedding <sub>[site](https://github.com/ggml-org/llama.cpp) · `embedding`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `embedding` | Self-hosted embedding model | embeddings |

#### `selfhosted-stt` — Self-hosted STT <sub>[site](https://github.com/ggml-org/whisper.cpp) · `stt`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `whisper-1` | Whisper (self-hosted) | speech-to-text |

#### `selfhosted-tts` — Self-hosted TTS <sub>[site](https://github.com/remsky/Kokoro-FastAPI) · `tts`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `kokoro` | Kokoro (self-hosted) | text-to-speech |

#### `sensenova-intl` — SenseNova (Intl) <sub>[site](https://platform.sensenova.ai) · `llm`, `image`, `imageToText`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `sensenova-6.8-flash` | SenseNova 6.8 Flash | chat |
| `sensenova-6.8-flash-lite` | SenseNova 6.8 Flash Lite | chat |
| `sensenova-6.7-flash-lite` | SenseNova 6.7 Flash Lite | chat |

#### `sensenova` — SenseNova <sub>[site](https://token.sensenova.cn) · `llm`, `image`, `imageToText`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `sensenova-6.8-flash` | SenseNova 6.8 Flash | chat |
| `sensenova-6.8-flash-lite` | SenseNova 6.8 Flash Lite | chat |
| `deepseek-flash` | DeepSeek V4.1 Flash | chat |
| `deepseek-v4-flash` | DeepSeek V4 Flash | chat |
| `glm-5.3` | GLM-5.3 | chat |
| `glm-5.2` | GLM-5.2 | chat |
| `kimi-k3` | Kimi K3 | chat |

#### `serper` — Serper <sub>[site](https://serper.dev) · `webSearch`</sub>

- No static model list. This entry resolves its models at runtime — from the account, the
  provider's own catalogue endpoint, or a local daemon — so nothing can be enumerated here.

#### `siliconflow` — SiliconFlow <sub>[site](https://cloud.siliconflow.com)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `deepseek-ai/DeepSeek-V4-Pro` | DeepSeek V4 Pro | chat |
| `deepseek-ai/DeepSeek-V4-Flash` | DeepSeek V4 Flash | chat |
| `deepseek-ai/DeepSeek-V3.2` | DeepSeek V3.2 | chat |
| `deepseek-ai/DeepSeek-V3.2-Exp` | DeepSeek V3.2 Exp | chat |
| `deepseek-ai/DeepSeek-V3.1` | DeepSeek V3.1 | chat |
| `deepseek-ai/DeepSeek-V3.1-Terminus` | DeepSeek V3.1 Terminus | chat |
| `deepseek-ai/DeepSeek-R1` | DeepSeek R1 | chat |
| `Qwen/Qwen3.5-397B-A17B` | Qwen 3.5 397B A17B | chat |
| `Qwen/Qwen3.5-122B-A10B` | Qwen 3.5 122B A10B | chat |
| `zai-org/GLM-5.1` | GLM 5.1 | chat |
| `zai-org/GLM-5` | GLM 5 | chat |
| `moonshotai/Kimi-K2.6` | Kimi K2.6 | chat |
| `moonshotai/Kimi-K2.5` | Kimi K2.5 | chat |
| `openai/gpt-oss-120b` | GPT OSS 120B | chat |
| `MiniMaxAI/MiniMax-M2.5` | MiniMax M2.5 | chat |
| `inclusionAI/Ling-flash-2.0` | Ling Flash 2.0 | chat |

#### `stability-ai` — Stability AI <sub>[site](https://stability.ai) · `image`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `stable-image-ultra` | Stable Image Ultra | image generation |
| `stable-image-core` | Stable Image Core | image generation |
| `sd3.5-large` | Stable Diffusion 3.5 Large | image generation |
| `sd3.5-large-turbo` | Stable Diffusion 3.5 Large Turbo | image generation |
| `sd3.5-medium` | Stable Diffusion 3.5 Medium | image generation |

#### `synthetic` — Synthetic <sub>[site](https://synthetic.new)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `hf:zai-org/GLM-5.3` | GLM 5.3 | chat |
| `hf:zai-org/GLM-5.3-Flash` | GLM 5.3 Flash | chat |
| `hf:zai-org/GLM-4.7-Flash` | GLM 4.7 Flash | chat |
| `hf:moonshotai/Kimi-K3` | Kimi K3 | chat |
| `hf:deepseek-ai/DeepSeek-V4.1-Flash` | DeepSeek V4.1 Flash | chat |
| `hf:deepseek-ai/DeepSeek-V4.1-Flash-1017` | DeepSeek V4.1 Flash 1017 | chat |
| `hf:Qwen/Qwen3.8-27B` | Qwen3.8 27B | chat |
| `hf:openai/gpt-oss-120b` | GPT-OSS 120B | chat |
| `hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4` | Nemotron 3 Super 120B | chat |

#### `tavily` — Tavily <sub>[site](https://tavily.com) · `webSearch`, `webFetch`</sub>

- No static model list. This entry resolves its models at runtime — from the account, the
  provider's own catalogue endpoint, or a local daemon — so nothing can be enumerated here.

#### `tencent` — Tencent Hunyuan <sub>[site](https://cloud.tencent.com/product/hunyuan)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `hunyuan-turbos-latest` | Hunyuan TurboS Latest | chat |
| `hunyuan-t1-latest` | Hunyuan T1 Latest | chat |

#### `tinyfish` — TinyFish <sub>[site](https://www.tinyfish.ai/) · `webSearch`, `webFetch`</sub>

- No static model list. This entry resolves its models at runtime — from the account, the
  provider's own catalogue endpoint, or a local daemon — so nothing can be enumerated here.

#### `together` — Together AI <sub>[site](https://www.together.ai) · `llm`, `embedding`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `meta-llama/Llama-3.3-70B-Instruct-Turbo` | Llama 3.3 70B Turbo | chat |
| `deepseek-ai/DeepSeek-R1` | DeepSeek R1 | chat |
| `Qwen/Qwen3-235B-A22B` | Qwen3 235B | chat |
| `meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` | Llama 4 Maverick | chat |
| `BAAI/bge-large-en-v1.5` | BGE Large EN v1.5 | embeddings |
| `togethercomputer/m2-bert-80M-8k-retrieval` | M2 BERT 80M 8K | embeddings |

#### `tokenharbor` — Token Harbor <sub>[site](https://tokenharbor.ai)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `claude-opus-5.5` | Claude Opus 5.5 | chat |
| `claude-sonnet-5` | Claude Sonnet 5 | chat |
| `gpt-6-astra` | GPT-6 Astra | chat |
| `gpt-6-sol` | GPT-6 Sol | chat |
| `deepseek-v4.1-flash:free` | DeepSeek V4.1 Flash (Free) | chat |
| `grok-4.7` | Grok 4.7 | chat |

#### `tokenrouter` — TokenRouter <sub>[site](https://www.tokenrouter.com) · `llm`, `embedding`, `image`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `anthropic/claude-haiku-4.5` | Claude Haiku 4.5 | chat |
| `anthropic/claude-sonnet-4.6` | Claude Sonnet 4.6 | chat |
| `anthropic/claude-opus-4.8` | Claude Opus 4.8 | chat |
| `anthropic/claude-opus-4.8-fast` | Claude Opus 4.8 Fast | chat |
| `openai/gpt-5.4` | Gpt 5.4 | chat |
| `openai/gpt-5.4-mini` | Gpt 5.4 Mini | chat |
| `openai/gpt-5.4-pro` | Gpt 5.4 Pro | chat |
| `openai/gpt-5.5` | Gpt 5.5 | chat |
| `openai/gpt-5.6-sol` | Gpt 5.6 Sol | chat |
| `google/gemini-3.5-flash` | Gemini 3.5 Flash | chat |
| `google/gemini-3.6-flash` | Gemini 3.6 Flash | chat |
| `deepseek/deepseek-v4-flash` | Deepseek V4 Flash | chat |
| `deepseek/deepseek-v4-pro` | Deepseek V4 Pro | chat |
| `qwen/qwen3-coder-next` | Qwen3 Coder Next | chat |
| `qwen/qwen3.7-max` | Qwen3.7 Max | chat |
| `qwen/qwen3.8-max` | Qwen3.8 Max | chat |
| `moonshotai/kimi-k2.7-code` | Kimi K2.7 Code | chat |
| `moonshotai/kimi-k3-free` | Kimi K3 Free | chat |
| `z-ai/glm-5.3-free` | Glm 5.3 Free | chat |
| `z-ai/glm-5.2` | Glm 5.2 | chat |
| `z-ai/glm-5-turbo` | Glm 5 Turbo | chat |
| `x-ai/grok-4.5` | Grok 4.5 | chat |

#### `topaz` — Topaz <sub>[site](https://topazlabs.com) · `image`</sub>

- No static model list. This entry resolves its models at runtime — from the account, the
  provider's own catalogue endpoint, or a local daemon — so nothing can be enumerated here.

#### `v1m` — v1m (System One) <sub>[site](https://v1m.ir) · `systemone`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `rev-latest` | v1m Rev Latest (Calibrated) | system (non-LLM) |
| `v1m-decision-engine` | v1m Decision Engine | system (non-LLM) |

#### `venice` — Venice AI <sub>[site](https://venice.ai) · `llm`, `embedding`, `image`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `venice-uncensored-1-2` | Venice Uncensored 1.2 | chat |
| `zai-org-glm-5` | GLM-5 | chat |
| `qwen3-235b-a22b-instruct-2507` | Qwen3 235B A22B Instruct | chat |
| `qwen3-coder-480b-a35b-instruct-turbo` | Qwen3 Coder 480B A35B Turbo | chat |
| `qwen3-vl-235b-a22b` | Qwen3 VL 235B A22B | chat |
| `deepseek-v4-pro` | DeepSeek V4 Pro | chat |
| `llama-3.3-70b` | Llama 3.3 70B | chat |
| `hermes-3-llama-3.1-405b` | Hermes 3 Llama 3.1 405B | chat |
| `mistral-small-3-2-24b-instruct` | Mistral Small 3.2 24B | chat |
| `text-embedding-3-large` | Text Embedding 3 Large | embeddings |
| `text-embedding-bge-m3` | BGE-M3 Embedding | embeddings |
| `text-embedding-qwen3-8b` | Qwen3 8B Embedding | embeddings |
| `venice-sd35` | Venice SD3.5 | image generation |
| `flux-2-pro` | FLUX.2 Pro | image generation |
| `gpt-image-2` | GPT Image 2 (via Venice) | image generation |

#### `veoaifree-web` — Veo AI Free Web <sub>[site](https://veoaifree.com) · `image`, `video`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `veo` | VEO 3.1 (Free) | video |
| `seedance` | Seedance (Free) | video |
| `nano-banana` | Nano Banana (Free) | image generation |

#### `vercel-ai-gateway` — Vercel AI Gateway <sub>[site](https://vercel.com/ai-gateway) · `llm`, `embedding`, `image`, `imageToText`, `webSearch`</sub>

- No static model list. This entry resolves its models at runtime — from the account, the
  provider's own catalogue endpoint, or a local daemon — so nothing can be enumerated here.

#### `vertex-partner` — Vertex Partner <sub>[site](https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-partner-models)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `deepseek-ai/deepseek-v3.2-maas` | DeepSeek V3.2 (Vertex) | chat |
| `qwen/qwen3-next-80b-a3b-thinking-maas` | Qwen3 Next 80B Thinking (Vertex) | chat |
| `qwen/qwen3-next-80b-a3b-instruct-maas` | Qwen3 Next 80B Instruct (Vertex) | chat |
| `zai-org/glm-5-maas` | GLM-5 (Vertex) | chat |

#### `volcengine-ark` — Volcengine Ark <sub>[site](https://ark.cn-beijing.volces.com)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `Doubao-Seed-2.0-Code` | Doubao-Seed-2.0-Code | chat |
| `Doubao-Seed-2.0-pro` | Doubao-Seed-2.0-pro | chat |
| `Doubao-Seed-2.0-lite` | Doubao-Seed-2.0-lite | chat |
| `Doubao-Seed-Code` | Doubao-Seed-Code | chat |
| `DeepSeek-V4-Flash` | DeepSeek-V4-Flash | chat |
| `DeepSeek-V4-Pro` | DeepSeek-V4-Pro | chat |
| `GLM-5.1` | GLM-5.1 | chat |
| `MiniMax-M2.7` | MiniMax-M2.7 | chat |
| `Kimi-K2.6` | Kimi-K2.6 | chat |

#### `voyage-ai` — Voyage AI <sub>[site](https://www.voyageai.com) · `embedding`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `voyage-3-large` | Voyage 3 Large | embeddings |
| `voyage-3.5` | Voyage 3.5 | embeddings |
| `voyage-3.5-lite` | Voyage 3.5 Lite | embeddings |
| `voyage-code-3` | Voyage Code 3 | embeddings |
| `voyage-finance-2` | Voyage Finance 2 | embeddings |
| `voyage-law-2` | Voyage Law 2 | embeddings |
| `voyage-multilingual-2` | Voyage Multilingual 2 | embeddings |

#### `xiaomi-tokenplan` — Xiaomi MiMo (Token Plan) <sub>[site](https://mimo.xiaomi.com)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `mimo-v2.6-pro` | MiMo V2.6 Pro | chat |
| `mimo-v2.6-flash` | MiMo V2.6 Flash | chat |
| `mimo-v2.5-asr` | MiMo V2.5 ASR | speech-to-text |
| `mimo-v2.5-tts` | MiMo V2.5 TTS | text-to-speech |
| `mimo-v2.5-tts-voiceclone` | MiMo V2.5 TTS Voice Clone | text-to-speech |
| `mimo-v2.5-tts-voicedesign` | MiMo V2.5 TTS Voice Design | text-to-speech |

#### `xquik` — Xquik <sub>[site](https://docs.xquik.com/api-reference/x/search-tweets) · `webSearch`</sub>

- No static model list. This entry resolves its models at runtime — from the account, the
  provider's own catalogue endpoint, or a local daemon — so nothing can be enumerated here.

#### `youcom` — You.com Search <sub>[site](https://you.com) · `webSearch`</sub>

- No static model list. This entry resolves its models at runtime — from the account, the
  provider's own catalogue endpoint, or a local daemon — so nothing can be enumerated here.

### free

#### `devin-cli` — Devin CLI <sub>[site](https://devin.ai)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `swe-1.6-fast` | SWE-1.6 Fast | chat |
| `swe-1.6` | SWE-1.6 | chat |
| `swe-1.5-fast` | SWE-1.5 Fast | chat |
| `swe-1.5` | SWE-1.5 | chat |
| `claude-opus-4.7-max` | Claude Opus 4.7 Max | chat |
| `claude-opus-4.7-high` | Claude Opus 4.7 High | chat |
| `claude-opus-4.7-medium` | Claude Opus 4.7 Medium | chat |
| `claude-opus-4.7-low` | Claude Opus 4.7 Low | chat |
| `claude-sonnet-4.6-thinking-1m` | Claude Sonnet 4.6 Thinking 1M | chat |
| `claude-sonnet-4.6-thinking` | Claude Sonnet 4.6 Thinking | chat |
| `claude-sonnet-4.6` | Claude Sonnet 4.6 | chat |
| `claude-opus-4.6-thinking` | Claude Opus 4.6 Thinking | chat |
| `claude-opus-4.6` | Claude Opus 4.6 | chat |
| `claude-sonnet-4.5` | Claude Sonnet 4.5 | chat |
| `claude-haiku-4.5` | Claude Haiku 4.5 | chat |
| `gpt-5.5-xhigh` | GPT-5.5 XHigh | chat |
| `gpt-5.5-high` | GPT-5.5 High | chat |
| `gpt-5.5-medium` | GPT-5.5 Medium | chat |
| `gpt-5.5-low` | GPT-5.5 Low | chat |
| `gpt-5.4-high` | GPT-5.4 High | chat |
| `gpt-5.4-medium` | GPT-5.4 Medium | chat |
| `gpt-5.4-low` | GPT-5.4 Low | chat |
| `gpt-5.3-codex-high` | GPT-5.3 Codex High | chat |
| `gpt-5.3-codex-medium` | GPT-5.3 Codex Medium | chat |
| `gpt-5.3-codex-low` | GPT-5.3 Codex Low | chat |
| `gpt-5.2-high` | GPT-5.2 High | chat |
| `gpt-5.2-medium` | GPT-5.2 Medium | chat |
| `gpt-5.2-low` | GPT-5.2 Low | chat |
| `gemini-3.1-pro-high` | Gemini 3.1 Pro High | chat |
| `gemini-3.1-pro-low` | Gemini 3.1 Pro Low | chat |
| `gemini-3.0-flash-high` | Gemini 3 Flash High | chat |
| `gemini-2.5-pro` | Gemini 2.5 Pro | chat |
| `deepseek-v4` | DeepSeek V4 | chat |
| `kimi-k2.6` | Kimi K2.6 | chat |
| `glm-5.1` | GLM-5.1 | chat |

#### `gemini-cli` — Gemini CLI <sub>[site](https://github.com/google-gemini/gemini-cli)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `gemini-3.1-pro-preview` | Gemini 3.1 Pro Preview | chat |
| `gemini-3-pro-preview` | Gemini 3 Pro Preview | chat |
| `gemini-3-flash-preview` | Gemini 3 Flash Preview | chat |
| `gemini-3.1-flash-lite-preview` | Gemini 3.1 Flash Lite Preview | chat |
| `gemini-2.5-pro` | Gemini 2.5 Pro | chat |
| `gemini-2.5-flash` | Gemini 2.5 Flash | chat |
| `gemini-2.5-flash-lite` | Gemini 2.5 Flash Lite | chat |

#### `kiro` — Kiro AI <sub>[site](https://kiro.dev)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `claude-opus-5.5` | Claude Opus 5.5 | chat |
| `claude-opus-5.5-thinking` | Claude Opus 5.5 (Thinking) | chat |
| `claude-opus-5.5-agentic` | Claude Opus 5.5 (Agentic) | chat |
| `claude-opus-5.5-thinking-agentic` | Claude Opus 5.5 (Thinking + Agentic) | chat |
| `claude-opus-5` | Claude Opus 5 | chat |
| `claude-opus-5-thinking` | Claude Opus 5 (Thinking) | chat |
| `claude-opus-5-agentic` | Claude Opus 5 (Agentic) | chat |
| `claude-opus-5-thinking-agentic` | Claude Opus 5 (Thinking + Agentic) | chat |
| `claude-opus-4.8` | Claude Opus 4.8 | chat |
| `claude-opus-4.8-thinking` | Claude Opus 4.8 (Thinking) | chat |
| `claude-opus-4.8-agentic` | Claude Opus 4.8 (Agentic) | chat |
| `claude-opus-4.8-thinking-agentic` | Claude Opus 4.8 (Thinking + Agentic) | chat |
| `claude-opus-4.7` | Claude Opus 4.7 | chat |
| `claude-opus-4.7-thinking` | Claude Opus 4.7 (Thinking) | chat |
| `claude-opus-4.7-agentic` | Claude Opus 4.7 (Agentic) | chat |
| `claude-opus-4.7-thinking-agentic` | Claude Opus 4.7 (Thinking + Agentic) | chat |
| `claude-opus-4.5` | Claude Opus 4.5 | chat |
| `claude-opus-4.5-thinking` | Claude Opus 4.5 (Thinking) | chat |
| `claude-opus-4.5-agentic` | Claude Opus 4.5 (Agentic) | chat |
| `claude-opus-4.5-thinking-agentic` | Claude Opus 4.5 (Thinking + Agentic) | chat |
| `claude-sonnet-5` | Claude Sonnet 5 | chat |
| `claude-sonnet-4.5` | Claude Sonnet 4.5 | chat |
| `claude-haiku-4.5` | Claude Haiku 4.5 | chat |
| `deepseek-3.2` | DeepSeek 3.2 | chat |
| `qwen3-coder-next` | Qwen3 Coder Next | chat |
| `glm-5` | GLM 5 | chat |
| `MiniMax-M2.5` | MiniMax M2.5 | chat |
| `gpt-5.6-sol` | GPT 5.6 Sol | chat |
| `gpt-5.6-terra` | GPT 5.6 Terra | chat |
| `gpt-5.6-luna` | GPT 5.6 Luna | chat |
| `claude-sonnet-5-thinking` | Claude Sonnet 5 (Thinking) | chat |
| `claude-sonnet-4.5-thinking` | Claude Sonnet 4.5 (Thinking) | chat |
| `claude-haiku-4.5-thinking` | Claude Haiku 4.5 (Thinking) | chat |
| `gpt-5.6-sol-thinking` | GPT 5.6 Sol (Thinking) | chat |
| `gpt-5.6-terra-thinking` | GPT 5.6 Terra (Thinking) | chat |
| `gpt-5.6-luna-thinking` | GPT 5.6 Luna (Thinking) | chat |
| `claude-sonnet-5-agentic` | Claude Sonnet 5 (Agentic) | chat |
| `claude-sonnet-4.5-agentic` | Claude Sonnet 4.5 (Agentic) | chat |
| `claude-haiku-4.5-agentic` | Claude Haiku 4.5 (Agentic) | chat |
| `gpt-5.6-sol-agentic` | GPT 5.6 Sol (Agentic) | chat |
| `gpt-5.6-terra-agentic` | GPT 5.6 Terra (Agentic) | chat |
| `gpt-5.6-luna-agentic` | GPT 5.6 Luna (Agentic) | chat |
| `claude-sonnet-5-thinking-agentic` | Claude Sonnet 5 (Thinking + Agentic) | chat |
| `claude-sonnet-4.5-thinking-agentic` | Claude Sonnet 4.5 (Thinking + Agentic) | chat |
| `claude-haiku-4.5-thinking-agentic` | Claude Haiku 4.5 (Thinking + Agentic) | chat |
| `gpt-5.6-sol-thinking-agentic` | GPT 5.6 Sol (Thinking + Agentic) | chat |
| `gpt-5.6-terra-thinking-agentic` | GPT 5.6 Terra (Thinking + Agentic) | chat |
| `gpt-5.6-luna-thinking-agentic` | GPT 5.6 Luna (Thinking + Agentic) | chat |

#### `mimo-free` — MiMo Code Free

| Model id | Name | Kind |
| --- | --- | --- |
| `mimo-auto` | MiMo Auto | chat |

#### `opencode` — OpenCode Free <sub>`llm`, `systemone`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `muse-spark-1.2-contributor-free` | Muse Spark 1.2 Contributor Free | chat |
| `muse-spark-1.3-contributor-free` | Muse Spark 1.3 Contributor Free | chat |
| `union-alpha` | Union Alpha Free | chat |
| `jev-1.13-free` | Jev 1.13 Free | system (non-LLM) |

### freeTier

#### `agnes` — Agnes AI <sub>[site](https://agnes-ai.com)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `agnes-2.5-flash` | Agnes 2.5 Flash | chat |
| `agnes-2.5-pro` | Agnes 2.5 Pro | chat |
| `agnes-2.5-pro-beta` | Agnes 2.5 Pro Beta | chat |
| `agnes-3.0-flash` | Agnes 3.0 Flash | chat |

#### `api-airforce` — API.airforce <sub>[site](https://api.airforce)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `gpt-oss-120b` | GPT-OSS 120B (Free) | chat |
| `gpt-oss-20b` | GPT-OSS 20B (Free) | chat |
| `kimi-k2.7-code` | Kimi K2.7 Code (Free) | chat |

#### `bazaarlink` — Bazaarlink <sub>[site](https://bazaarlink.ai)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `auto:free` | Auto Free (Zero Cost) | chat |
| `claude-opus-4.7` | Claude Opus 4.7 | chat |
| `claude-sonnet-4.6` | Claude Sonnet 4.6 | chat |
| `claude-haiku-4.5` | Claude Haiku 4.5 | chat |
| `gpt-5.5` | GPT-5.5 | chat |
| `gpt-5.4` | GPT-5.4 | chat |
| `gpt-5.4-mini` | GPT-5.4 Mini | chat |
| `gpt-5.4-nano` | GPT-5.4 Nano | chat |
| `grok-4.3` | Grok 4.3 | chat |
| `grok-4.20` | Grok 4.20 | chat |
| `gemini-3.1-pro-preview` | Gemini 3.1 Pro | chat |
| `gemini-3-flash-preview` | Gemini 3 Flash | chat |
| `gemini-3.1-flash-lite-preview` | Gemini 3.1 Flash Lite | chat |
| `kimi-k2.6` | Kimi K2.6 | chat |
| `kimi-k2.5` | Kimi K2.5 | chat |
| `glm-5.1` | GLM 5.1 | chat |
| `glm-5` | GLM 5 | chat |
| `mimo-v2.5-pro` | MiMo-V2.5-Pro | chat |
| `mimo-v2.5` | MiMo-V2.5 | chat |
| `minimax-m3` | MiniMax M3 | chat |
| `minimax-m2.7` | MiniMax M2.7 | chat |
| `minimax-m2.5` | MiniMax M2.5 | chat |
| `qwen3.6-plus` | Qwen 3.6 Plus | chat |
| `nemotron-3-super-120b-a12b` | Nemotron 3 Super | chat |

#### `byteplus` — BytePlus ModelArk <sub>[site](https://console.byteplus.com/ark) · `llm`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `seed-2-0-pro-260328` | Seed 2.0 Pro | chat |
| `seed-2-0-code-preview-260328` | Seed 2.0 Code Preview | chat |
| `seed-2-0-mini-260215` | Seed 2.0 Mini | chat |
| `seed-2-0-lite-260228` | Seed 2.0 Lite | chat |
| `kimi-k2-thinking-251104` | Kimi K2 Thinking | chat |
| `glm-4-7-251222` | GLM 4.7 | chat |
| `gpt-oss-120b-250805` | GPT-OSS-120B | chat |

#### `cloudflare-ai` — Cloudflare <sub>[site](https://developers.cloudflare.com/workers-ai/) · `llm`, `image`, `systemone`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `@cf/cloudflare/clef-flash` | Clef Flash | system (non-LLM) |
| `@cf/meta/llama-3.2-1b-instruct` | Llama 3.2 1B Instruct | chat |
| `@cf/meta/llama-3.2-3b-instruct` | Llama 3.2 3B Instruct | chat |
| `@cf/meta/llama-3.1-8b-instruct-fp8-fast` | Llama 3.1 8B Instruct FP8 Fast | chat |
| `@cf/meta/llama-3.1-8b-instruct-awq` | Llama 3.1 8B Instruct AWQ | chat |
| `@cf/mistralai/mistral-small-3.1-24b-instruct` | Mistral Small 3.1 24B Instruct | chat |
| `@cf/meta/llama-3.1-70b-instruct-fp8-fast` | Llama 3.1 70B Instruct FP8 Fast | chat |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Llama 3.3 70B Instruct FP8 Fast | chat |
| `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` | DeepSeek R1 Distill Qwen 32B | chat |
| `@cf/moonshotai/kimi-k2.5` | Kimi K2.5 | chat |
| `@cf/moonshotai/kimi-k2.6` | Kimi K2.6 | chat |
| `@cf/zai-org/glm-4.7-flash` | GLM 4.7 Flash | chat |
| `@cf/qwen/qwq-32b` | QwQ 32B | chat |
| `@cf/qwen/qwen2.5-coder-32b-instruct` | Qwen 2.5 Coder 32B Instruct | chat |
| `@cf/black-forest-labs/flux-2-klein-9b` | FLUX.2 Klein 9B | image generation |
| `@cf/black-forest-labs/flux-2-klein-4b` | FLUX.2 Klein 4B | image generation |
| `@cf/black-forest-labs/flux-2-dev` | FLUX.2 Dev | image generation |
| `@cf/leonardo/lucid-origin` | Lucid Origin | image generation |
| `@cf/leonardo/phoenix-1.0` | Phoenix 1.0 | image generation |
| `@cf/black-forest-labs/flux-1-schnell` | FLUX.1 Schnell | image generation |
| `@cf/bytedance/stable-diffusion-xl-lightning` | SDXL Lightning | image generation |
| `@cf/lykon/dreamshaper-8-lcm` | DreamShaper 8 LCM | image generation |
| `@cf/runwayml/stable-diffusion-v1-5-img2img` | Stable Diffusion v1.5 Img2Img | image generation |
| `@cf/runwayml/stable-diffusion-v1-5-inpainting` | Stable Diffusion v1.5 Inpainting | image generation |
| `@cf/stabilityai/stable-diffusion-xl-base-1.0` | SDXL Base 1.0 | image generation |

#### `coqui` — Coqui TTS <sub>[site](https://github.com/coqui-ai/TTS) · `tts`</sub>

- No static model list. This entry resolves its models at runtime — from the account, the
  provider's own catalogue endpoint, or a local daemon — so nothing can be enumerated here.

#### `edge-tts` — Edge TTS <sub>`tts`</sub>

- No static model list. This entry resolves its models at runtime — from the account, the
  provider's own catalogue endpoint, or a local daemon — so nothing can be enumerated here.

#### `gemini` — Gemini <sub>[site](https://ai.google.dev) · `llm`, `embedding`, `image`, `imageToText`, `webSearch`, `tts`, `stt`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `gemini-4-argon` | Gemini 4 Argon | chat |
| `gemini-3.8-flash` | Gemini 3.8 Flash | chat |
| `gemini-3.7-flash` | Gemini 3.7 Flash | chat |
| `gemini-3.6-flash` | Gemini 3.6 Flash | chat |
| `gemini-3.5-flash-lite` | Gemini 3.5 Flash Lite | chat |
| `gemini-3.1-pro-preview` | Gemini 3.1 Pro Preview | chat |
| `gemini-3.1-flash-lite-preview` | Gemini 3.1 Flash Lite Preview | chat |
| `gemini-3-flash-preview` | Gemini 3 Flash Preview | chat |
| `gemini-2.5-pro` | Gemini 2.5 Pro | chat |
| `gemini-2.5-flash` | Gemini 2.5 Flash | chat |
| `gemini-2.5-flash-lite` | Gemini 2.5 Flash Lite | chat |
| `gemma-4-31b-it` | Gemma 4 31B IT | chat |
| `gemini-embedding-2-preview` | Gemini Embedding 2 Preview | embeddings |
| `gemini-embedding-001` | Gemini Embedding 001 | embeddings |
| `text-embedding-005` | Text Embedding 005 | embeddings |
| `text-embedding-004` | Text Embedding 004 (Legacy) | embeddings |
| `gemini-3.1-flash-image-preview` | Gemini 3.1 Flash Image (Nano Banana 2) | image generation |
| `gemini-3-pro-image-preview` | Gemini 3 Pro Image (Nano Banana Pro) | image generation |
| `gemini-2.5-flash-image` | Gemini 2.5 Flash Image (Nano Banana) | image generation |
| `gemini-2.5-pro` | Gemini 2.5 Pro (Best) | speech-to-text |
| `gemini-2.5-flash` | Gemini 2.5 Flash | speech-to-text |
| `gemini-2.5-flash-lite` | Gemini 2.5 Flash Lite (Cheapest) | speech-to-text |
| `gemini-2.0-flash` | Gemini 2.0 Flash | speech-to-text |
| `gemini-2.5-flash-native-audio-preview-09-17` | Gemini Live Transcription (Realtime) | speech-to-text |
| `gemini-3.1-flash-tts-preview` | Gemini 3.1 Flash TTS | text-to-speech |
| `gemini-2.5-flash-preview-tts` | Gemini 2.5 Flash TTS | text-to-speech |
| `gemini-2.5-pro-preview-tts` | Gemini 2.5 Pro TTS | text-to-speech |
| `embedding-001` | Embedding 001 | embeddings |

#### `google-tts` — Google TTS <sub>`tts`</sub>

- No static model list. This entry resolves its models at runtime — from the account, the
  provider's own catalogue endpoint, or a local daemon — so nothing can be enumerated here.

#### `kilo-gateway` — Kilo Gateway <sub>[site](https://kilo.ai)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `kilo-auto/free` | Kilo Auto Free | chat |
| `nvidia/nemotron-3-super-120b-a12b:free` | Nemotron 3 Super 120B (Free) | chat |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | Nemotron 3 Ultra 550B (Free) | chat |
| `kwaipilot/kat-coder-pro-v2.5:free` | Kat Coder Pro v2.5 (Free) | chat |
| `kilo-auto/frontier` | Kilo Auto Frontier | chat |
| `kilo-auto/balanced` | Kilo Auto Balanced | chat |

#### `kimchi` — Kimchi <sub>[site](https://kimchi.dev) · `llm`, `imageToText`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `minimax-m3` | MiniMax-M3 | chat |
| `kimi-k2.7` | Kimi-K2.7 | chat |
| `kimi-k2.6` | Kimi-K2.6 | chat |
| `kimi-k2.5` | Kimi-K2.5 | chat |
| `nemotron-3-ultra-fp4` | Nemotron 3 Ultra FP4 | chat |
| `minimax-m2.7` | MiniMax-M2.7 | chat |
| `claude-opus-4-6` | Claude Opus 4.6 | chat |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | chat |

#### `local-device` — Local Device <sub>`tts`</sub>

- No static model list. This entry resolves its models at runtime — from the account, the
  provider's own catalogue endpoint, or a local daemon — so nothing can be enumerated here.

#### `nous` — Nous Research <sub>[site](https://nousresearch.com) · `llm`, `imageToText`</sub>

- No static model list. This entry resolves its models at runtime — from the account, the
  provider's own catalogue endpoint, or a local daemon — so nothing can be enumerated here.

#### `nvidia` — NVIDIA NIM <sub>[site](https://developer.nvidia.com/nim) · `llm`, `tts`, `embedding`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `nvidia/nemotron-3.5-lightning-30b-a3b` | Nemotron 3.5 Lightning | chat |
| `nvidia/nemotron-3.5-bolt-e4b` | Nemotron 3.5 Bolt | chat |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | Nemotron 3 Nano Omni | chat |
| `nvidia/nemotron-3-ultra-550b-a55b` | Nemotron 3 Ultra | chat |
| `poolside/laguna-xs-2.1` | Laguna XS 2.1 | chat |
| `meta/llama-guard-4-12b` | Llama Guard 4 12B | chat |
| `nvidia/riva-translate-4b-instruct-v2` | Riva Translate 4B v2 | chat |
| `meta/llama-3.3-70b-instruct` | Llama 3.3 70B Instruct | chat |
| `minimaxai/minimax-m2.7` | MiniMax M2.7 | chat |
| `minimaxai/minimax-m3` | MiniMax M3 | chat |
| `z-ai/glm-5.2` | GLM 5.2 | chat |
| `deepseek-ai/deepseek-v4-pro` | DeepSeek V4 Pro | chat |
| `deepseek-ai/deepseek-v4-flash` | DeepSeek V4 Flash | chat |
| `moonshotai/kimi-k2.6` | Kimi K2.6 | chat |
| `nvidia/nv-embedqa-e5-v5` | NV EmbedQA E5 v5 | embeddings |
| `nvidia/parakeet-ctc-1.1b-asr` | Parakeet CTC 1.1B | speech-to-text |
| `fastpitch` | FastPitch | text-to-speech |
| `tacotron2` | Tacotron2 | text-to-speech |

#### `ollama` — Ollama Cloud <sub>[site](https://ollama.com) · `llm`, `webFetch`, `systemone`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `gpt-oss:120b` | GPT OSS 120B | chat |
| `kimi-k2.5` | Kimi K2.5 | chat |
| `glm-5` | GLM 5 | chat |
| `minimax-m2.5` | MiniMax M2.5 | chat |
| `glm-4.7-flash` | GLM 4.7 Flash | chat |
| `qwen3.5` | Qwen3.5 | chat |
| `minimax-m3` | MiniMax M3 | chat |
| `deepseek-v4.1-flash:cloud` | DeepSeek V4.1 Flash | chat |
| `clef` | Clef | system (non-LLM) |
| `clef-flash` | Clef Flash | system (non-LLM) |
| `clef:cloud` | Clef (Cloud) | system (non-LLM) |

#### `openrouter` — OpenRouter <sub>[site](https://openrouter.ai) · `llm`, `embedding`, `tts`, `imageToText`, `video`, `systemone`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `openai/text-embedding-3-large` | OpenAI Text Embedding 3 Large | embeddings |
| `openai/text-embedding-3-small` | OpenAI Text Embedding 3 Small | embeddings |
| `openai/text-embedding-ada-002` | OpenAI Text Embedding Ada 002 | embeddings |
| `qwen/qwen3-embedding-8b` | Qwen3 Embedding 8B | embeddings |
| `perplexity/pplx-embed-v1-4b` | Perplexity Embed V1 4B | embeddings |
| `perplexity/pplx-embed-v1-0.6b` | Perplexity Embed V1 0.6B | embeddings |
| `nvidia/llama-nemotron-embed-vl-1b-v2:free` | NVIDIA Nemotron Embed VL 1B V2 (Free) | embeddings |
| `openai/gpt-4o-mini-tts` | GPT-4o Mini TTS | text-to-speech |
| `openai/tts-1-hd` | TTS-1 HD | text-to-speech |
| `openai/tts-1` | TTS-1 | text-to-speech |
| `openai/dall-e-3` | DALL-E 3 (via OpenRouter) | image generation |
| `openai/gpt-image-1` | GPT Image 1 (via OpenRouter) | image generation |
| `google/imagen-3.0-generate-002` | Imagen 3 (via OpenRouter) | image generation |
| `black-forest-labs/FLUX.1-schnell` | FLUX.1 Schnell (via OpenRouter) | image generation |
| `google/veo-3.1` | Veo 3.1 (via OpenRouter) | video |
| `openai/sora-2-pro` | Sora 2 Pro (via OpenRouter) | video |
| `bytedance/seedance-2.0` | Seedance 2.0 (via OpenRouter) | video |
| `typesafe/jev-1.13` | Jev 1.13 | system (non-LLM) |

#### `poolside` — Poolside <sub>[site](https://poolside.ai)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `poolside/laguna-s-2.1` | Laguna S 2.1 | chat |
| `poolside/laguna-xs-2.1` | Laguna XS 2.1 | chat |

#### `searxng` — SearXNG <sub>[site](https://docs.searxng.org) · `webSearch`</sub>

- No static model list. This entry resolves its models at runtime — from the account, the
  provider's own catalogue endpoint, or a local daemon — so nothing can be enumerated here.

#### `tortoise` — Tortoise TTS <sub>[site](https://github.com/neonbjb/tortoise-tts) · `tts`</sub>

- No static model list. This entry resolves its models at runtime — from the account, the
  provider's own catalogue endpoint, or a local daemon — so nothing can be enumerated here.

#### `vertex` — Vertex AI <sub>[site](https://cloud.google.com/vertex-ai) · `llm`, `imageToText`, `video`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `gemini-4-argon` | Gemini 4 Argon | chat |
| `gemini-3.1-pro-preview` | Gemini 3.1 Pro Preview | chat |
| `gemini-3.1-flash-lite-preview` | Gemini 3.1 Flash Lite Preview | chat |
| `gemini-3-flash-preview` | Gemini 3 Flash Preview | chat |
| `gemini-2.5-flash` | Gemini 2.5 Flash | chat |
| `veo-3.1-generate-preview` | Veo 3.1 (Preview) | video |
| `veo-3.1-fast-generate-preview` | Veo 3.1 Fast (Preview) | video |
| `veo-3.0-generate-001` | Veo 3 | video |
| `veo-2.0-generate-001` | Veo 2 | video |

### oauth

#### `antigravity` — Antigravity <sub>[site](https://antigravity.google) · `llm`, `image`, `webSearch`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `gemini-4-carbon-high` | Gemini 4 Carbon (High) | chat |
| `gemini-4-carbon-medium` | Gemini 4 Carbon (Medium) | chat |
| `gemini-4-carbon-low` | Gemini 4 Carbon (Low) | chat |
| `gemini-4-carbon` | Gemini 4 Carbon | chat |
| `gemini-4-argon-high` | Gemini 4 Argon (High) | chat |
| `gemini-4-argon-medium` | Gemini 4 Argon (Medium) | chat |
| `gemini-4-argon-low` | Gemini 4 Argon (Low) | chat |
| `gemini-3.8-flash-high` | Gemini 3.8 Flash (High) | chat |
| `gemini-3.8-flash-medium` | Gemini 3.8 Flash (Medium) | chat |
| `gemini-3.8-flash-low` | Gemini 3.8 Flash (Low) | chat |
| `gemini-3.8-flash` | Gemini 3.8 Flash | chat |
| `gemini-3.7-flash-high` | Gemini 3.7 Flash (High) | chat |
| `gemini-3.7-flash-medium` | Gemini 3.7 Flash (Medium) | chat |
| `gemini-3.7-flash-low` | Gemini 3.7 Flash (Low) | chat |
| `gemini-3.6-flash-high` | Gemini 3.6 Flash (High) | chat |
| `gemini-3.6-flash-medium` | Gemini 3.6 Flash (Medium) | chat |
| `gemini-3.6-flash-low` | Gemini 3.6 Flash (Low) | chat |
| `gemini-3.1-pro-high` | Gemini 3.1 Pro (High) | chat |
| `gemini-pro-agent` | Gemini 3.1 Pro (High) | chat |
| `gemini-3.1-pro-low` | Gemini 3.1 Pro (Low) | chat |
| `claude-sonnet-5-5-high` | Claude Sonnet 5.5 (High) | chat |
| `claude-sonnet-5-5-medium` | Claude Sonnet 5.5 (Medium) | chat |
| `claude-sonnet-5-5-low` | Claude Sonnet 5.5 (Low) | chat |
| `claude-sonnet-5-5` | Claude Sonnet 5.5 (Thinking) | chat |
| `claude-opus-5-5-high` | Claude Opus 5.5 (High) | chat |
| `claude-opus-5-5-medium` | Claude Opus 5.5 (Medium) | chat |
| `claude-opus-5-5-low` | Claude Opus 5.5 (Low) | chat |
| `claude-opus-5-5` | Claude Opus 5.5 (Thinking) | chat |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 (Thinking) | chat |
| `claude-opus-4-6-thinking` | Claude Opus 4.6 (Thinking) | chat |
| `gpt-oss-120b-medium` | GPT-OSS 120B (Medium) | chat |
| `gemini-3.1-flash-image` | Gemini 3.1 Flash (Image) | image generation |

#### `claude` — Claude Code <sub>[site](https://claude.ai)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `claude-fable-5-2` | Claude Fable 5.2 | chat |
| `claude-opus-5-5` | Claude Opus 5.5 | chat |
| `claude-opus-5` | Claude Opus 5 | chat |
| `claude-fable-5` | Claude Fable 5 | chat |
| `claude-sonnet-5-5` | Claude Sonnet 5.5 | chat |
| `claude-sonnet-5` | Claude Sonnet 5 | chat |
| `claude-haiku-5-5` | Claude Haiku 5.5 | chat |
| `claude-haiku-4-5-20251001` | Claude 4.5 Haiku | chat |

#### `cline` — Cline <sub>[site](https://cline.bot)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `anthropic/claude-opus-4.7` | Claude Opus 4.7 | chat |
| `anthropic/claude-sonnet-4.6` | Claude Sonnet 4.6 | chat |
| `anthropic/claude-opus-4.6` | Claude Opus 4.6 | chat |
| `openai/gpt-5.3-codex` | GPT-5.3 Codex | chat |
| `openai/gpt-5.4` | GPT-5.4 | chat |
| `google/gemini-3.1-pro-preview` | Gemini 3.1 Pro Preview | chat |
| `google/gemini-3.1-flash-lite-preview` | Gemini 3.1 Flash Lite Preview | chat |
| `kwaipilot/kat-coder-pro` | KAT Coder Pro | chat |

#### `clinepass` — ClinePass <sub>[site](https://cline.bot)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `cline-pass/glm-5.2` | GLM-5.2 (ClinePass) | chat |
| `cline-pass/kimi-k2.7-code` | Kimi K2.7 Code (ClinePass) | chat |
| `cline-pass/kimi-k2.6` | Kimi K2.6 (ClinePass) | chat |
| `cline-pass/deepseek-v4-pro` | DeepSeek V4 Pro (ClinePass) | chat |
| `cline-pass/deepseek-v4-flash` | DeepSeek V4 Flash (ClinePass) | chat |
| `cline-pass/mimo-v2.5` | MiMo-V2.5 (ClinePass) | chat |
| `cline-pass/mimo-v2.5-pro` | MiMo-V2.5-Pro (ClinePass) | chat |
| `cline-pass/minimax-m3` | MiniMax M3 (ClinePass) | chat |
| `cline-pass/qwen3.7-max` | Qwen3.7 Max (ClinePass) | chat |
| `cline-pass/qwen3.7-plus` | Qwen3.7 Plus (ClinePass) | chat |

#### `codebuddy-cn` — CodeBuddy CN <sub>[site](https://copilot.tencent.com)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `glm-5.2` | GLM-5.2 | chat |
| `glm-5.1` | GLM-5.1 | chat |
| `minimax-m3` | MiniMax-M3 | chat |
| `hy3` | Hy3 | chat |
| `hy4-preview` | Hy4-Preview | chat |
| `glm-5.3` | GLM-5.3 | chat |
| `glm-5.3-flash` | GLM-5.3-Flash | chat |
| `kimi-k3-1` | Kimi-K3 | chat |
| `kimi-k2.8-preview` | Kimi-K2.8-Preview | chat |
| `deepseek-v4-pro` | DeepSeek-V4-Pro | chat |
| `deepseek-v4.1-flash` | DeepSeek-V4.1-Flash | chat |

#### `codebuddy-intl` — CodeBuddy <sub>[site](https://www.codebuddy.ai)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `glm-5.2` | GLM-5.2 | chat |
| `glm-5.1` | GLM-5.1 | chat |
| `glm-5.0` | GLM-5.0 | chat |
| `glm-5.0-turbo` | GLM-5.0-Turbo | chat |
| `glm-5v-turbo` | GLM-5v-Turbo | chat |
| `glm-4.7` | GLM-4.7 | chat |
| `minimax-m3` | MiniMax-M3 | chat |
| `minimax-m2.7` | MiniMax-M2.7 | chat |
| `kimi-k2.7` | Kimi-K2.7-Code | chat |
| `kimi-k2.6` | Kimi-K2.6 | chat |
| `kimi-k2.5` | Kimi-K2.5 | chat |
| `hy3-preview` | Hy3 Preview | chat |
| `deepseek-v4-pro` | DeepSeek-V4-Pro | chat |
| `deepseek-v4.1-flash` | DeepSeek-V4.1-Flash | chat |
| `deepseek-v3-2-volc` | DeepSeek-V3.2 | chat |

#### `codex` — OpenAI Codex <sub>[site](https://chatgpt.com/codex) · `llm`, `image`, `stt`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `gpt-6.1-sol` | GPT 6.1 Sol | chat |
| `gpt-6.1-terra` | GPT 6.1 Terra | chat |
| `gpt-6-astra` | GPT 6.0 Astra | chat |
| `gpt-6-astra[1m]` | GPT 6.0 Astra (extended context) | chat |
| `gpt-6-sol` | GPT 6.0 Sol | chat |
| `gpt-6-sol[1m]` | GPT 6.0 Sol (extended context) | chat |
| `gpt-6-luna` | GPT 6.0 Luna | chat |
| `gpt-6-luna[1m]` | GPT 6.0 Luna (extended context) | chat |
| `gpt-5.6-sol` | GPT 5.6 Sol | chat |
| `gpt-5.6-sol[1m]` | GPT 5.6 Sol (extended context) | chat |
| `gpt-5.6-sol-review` | GPT 5.6 Sol Review | chat |
| `gpt-5.6-terra` | GPT 5.6 Terra | chat |
| `gpt-5.6-terra[1m]` | GPT 5.6 Terra (extended context) | chat |
| `gpt-5.6-terra-review` | GPT 5.6 Terra Review | chat |
| `gpt-5.6-luna` | GPT 5.6 Luna | chat |
| `gpt-5.6-luna[1m]` | GPT 5.6 Luna (extended context) | chat |
| `gpt-5.6-luna-review` | GPT 5.6 Luna Review | chat |
| `gpt-daybreak-blue-latest` | GPT Daybreak Blue | chat |
| `gpt-reserve` | GPT Reserve | chat |
| `codex-auto-review` | Codex Auto Review | chat |
| `gpt-image-2.5` | GPT Image 2.5 | image generation |
| `gpt-image-2.5-flare` | GPT Image 2.5 Flare | image generation |
| `gpt-image-2.5-sunburst` | GPT Image 2.5 Sunburst | image generation |
| `gpt-image-2.6-flare` | GPT Image 2.6 Flare | image generation |
| `gpt-image-2.6-sunburst` | GPT Image 2.6 Sunburst | image generation |
| `gpt-image-2` | GPT Image 2 | image generation |
| `gpt-image-1.5` | GPT Image 1.5 | image generation |
| `gpt-6-sol-image` | GPT 6.0 Sol Image | image generation |
| `transcribe` | Codex Transcription | speech-to-text |

#### `cursor` — Cursor IDE <sub>[site](https://cursor.com)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `default` | Auto (Server Picks) | chat |
| `claude-4.5-opus-high-thinking` | Claude 4.5 Opus High Thinking | chat |
| `claude-4.5-opus-high` | Claude 4.5 Opus High | chat |
| `claude-4.5-sonnet-thinking` | Claude 4.5 Sonnet Thinking | chat |
| `claude-4.5-sonnet` | Claude 4.5 Sonnet | chat |
| `claude-4.5-haiku` | Claude 4.5 Haiku | chat |
| `claude-4.5-opus` | Claude 4.5 Opus | chat |
| `gpt-5.2-codex` | GPT 5.2 Codex | chat |
| `claude-4.6-opus-max` | Claude 4.6 Opus Max | chat |
| `claude-4.6-sonnet-medium-thinking` | Claude 4.6 Sonnet Medium Thinking | chat |
| `kimi-k2.5` | Kimi K2.5 | chat |
| `gemini-3-flash-preview` | Gemini 3 Flash Preview | chat |
| `gpt-5.2` | GPT 5.2 | chat |
| `gpt-5.3-codex` | GPT 5.3 Codex | chat |

#### `github` — GitHub Copilot <sub>[site](https://github.com/features/copilot) · `llm`, `embedding`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `gpt-5-mini` | GPT-5 Mini | chat |
| `gpt-5.3-codex` | GPT-5.3 Codex | chat |
| `gpt-5.4` | GPT-5.4 | chat |
| `gpt-5.4-mini` | GPT-5.4 Mini | chat |
| `gpt-5.5` | GPT-5.5 | chat |
| `gpt-5.6-luna` | GPT-5.6 Luna | chat |
| `gpt-5.6-sol` | GPT-5.6 Sol | chat |
| `gpt-5.6-terra` | GPT-5.6 Terra | chat |
| `gpt-6-astra` | GPT-6 Astra | chat |
| `gpt-6-luna` | GPT-6 Luna | chat |
| `gpt-6-sol` | GPT-6 Sol | chat |
| `gpt-6.1-sol` | GPT-6.1 Sol | chat |
| `claude-fable-5` | Claude Fable 5 | chat |
| `claude-haiku-4.5` | Claude Haiku 4.5 | chat |
| `claude-haiku-5.5` | Claude Haiku 5.5 | chat |
| `claude-opus-4.8` | Claude Opus 4.8 | chat |
| `claude-opus-4.8-fast` | Claude Opus 4.8 (Fast) | chat |
| `claude-opus-5` | Claude Opus 5 | chat |
| `claude-opus-5.5` | Claude Opus 5.5 | chat |
| `claude-sonnet-4.6` | Claude Sonnet 4.6 | chat |
| `claude-sonnet-5` | Claude Sonnet 5 | chat |
| `claude-sonnet-5.5` | Claude Sonnet 5.5 | chat |
| `gemini-3.7-flash` | Gemini 3.7 Flash | chat |
| `gemini-3.8-flash` | Gemini 3.8 Flash | chat |
| `gemini-4-argon` | Gemini 4 Argon | chat |
| `kimi-k3` | Kimi K3 | chat |
| `mai-code-1.1-flash` | MAI-Code-1.1-Flash | chat |
| `text-embedding-3-small` | Text Embedding 3 Small (GitHub) | embeddings |
| `text-embedding-ada-002` | Text Embedding Ada 002 (GitHub) | embeddings |

#### `gitlab` — GitLab Duo <sub>[site](https://gitlab.com)</sub>

- No static model list. This entry resolves its models at runtime — from the account, the
  provider's own catalogue endpoint, or a local daemon — so nothing can be enumerated here.

#### `glm` — Zai GLM Coding <sub>[site](https://open.bigmodel.cn) · `llm`, `webSearch`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `glm-5.3` | GLM 5.3 | chat |
| `glm-5.3-flash` | GLM 5.3 Flash (Vision) | chat |
| `glm-5.2` | GLM 5.2 | chat |
| `glm-5.1` | GLM 5.1 | chat |
| `glm-5-turbo` | GLM 5 Turbo | chat |
| `glm-5` | GLM 5 | chat |
| `glm-4.7` | GLM 4.7 | chat |
| `glm-4.6v` | GLM 4.6V (Vision) | chat |

#### `grok-cli` — Grok CLI (Grok Build) <sub>[site](https://x.ai)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `grok-4.7` | Grok 4.7 | chat |
| `grok-4.5` | Grok 4.5 | chat |
| `grok-4.5-high` | Grok 4.5 (High) | chat |
| `grok-4.5-medium` | Grok 4.5 (Medium) | chat |
| `grok-4.5-low` | Grok 4.5 (Low) | chat |

#### `iflow` — iFlow AI <sub>[site](https://iflow.cn)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `qwen3-coder-plus` | Qwen3 Coder Plus | chat |
| `qwen3-max` | Qwen3 Max | chat |
| `qwen3-vl-plus` | Qwen3 VL Plus | chat |
| `qwen3-max-preview` | Qwen3 Max Preview | chat |
| `qwen3-235b` | Qwen3 235B A22B | chat |
| `qwen3-235b-a22b-instruct` | Qwen3 235B A22B Instruct | chat |
| `qwen3-235b-a22b-thinking-2507` | Qwen3 235B A22B Thinking | chat |
| `qwen3-32b` | Qwen3 32B | chat |
| `kimi-k2` | Kimi K2 | chat |
| `deepseek-v3.2` | DeepSeek V3.2 Exp | chat |
| `deepseek-v3.1` | DeepSeek V3.1 Terminus | chat |
| `deepseek-v3` | DeepSeek V3 671B | chat |
| `deepseek-r1` | DeepSeek R1 | chat |
| `glm-4.7` | GLM 4.7 | chat |
| `iflow-rome-30ba3b` | iFlow ROME | chat |

#### `kilocode` — Kilo Code <sub>[site](https://kilocode.ai)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `anthropic/claude-sonnet-4-20250514` | Claude Sonnet 4 | chat |
| `anthropic/claude-opus-4-20250514` | Claude Opus 4 | chat |
| `google/gemini-2.5-pro` | Gemini 2.5 Pro | chat |
| `google/gemini-2.5-flash` | Gemini 2.5 Flash | chat |
| `openai/gpt-4.1` | GPT-4.1 | chat |
| `openai/o3` | o3 | chat |
| `deepseek/deepseek-chat` | DeepSeek Chat | chat |
| `deepseek/deepseek-reasoner` | DeepSeek Reasoner | chat |

#### `kimi` — Kimi <sub>[site](https://kimi.moonshot.cn) · `llm`, `webSearch`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `kimi-k3` | Kimi K3 | chat |
| `k3` | Kimi K3 (Code) | chat |
| `kimi-for-coding` | Kimi for Coding | chat |
| `kimi-for-coding-highspeed` | Kimi for Coding Highspeed | chat |
| `kimi-k2.7-code` | Kimi K2.7 Code | chat |
| `kimi-k2.7-code-highspeed` | Kimi K2.7 Code Highspeed | chat |
| `kimi-k2.6` | Kimi K2.6 | chat |
| `kimi-k2.5` | Kimi K2.5 | chat |
| `kimi-k2.5-thinking` | Kimi K2.5 Thinking | chat |
| `kimi-latest` | Kimi Latest | chat |

#### `minimax-code-global` — MiniMax Code (Global) <sub>[site](https://agent.minimax.io)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `MiniMax-M3.1-Flash-Preview` | MiniMax M3.1 Flash Preview | chat |
| `MiniMax-M3` | MiniMax M3 | chat |
| `MiniMax-M2.7` | MiniMax M2.7 | chat |
| `MiniMax-M2.7-highspeed` | MiniMax M2.7 Highspeed | chat |

#### `minimax-code` — MiniMax Code <sub>[site](https://agent.minimax.cn)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `MiniMax-M3.1-Flash-Preview` | MiniMax M3.1 Flash Preview | chat |
| `MiniMax-M3` | MiniMax M3 | chat |
| `MiniMax-M2.7` | MiniMax M2.7 | chat |
| `MiniMax-M2.7-highspeed` | MiniMax M2.7 Highspeed | chat |

#### `muse` — Muse (Meta Model API) <sub>[site](https://muse.ai)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `muse-spark-1.3` | Muse Spark 1.3 | chat |
| `muse-spark-1.2` | Muse Spark 1.2 | chat |
| `muse-spark-1.1` | Muse Spark 1.1 | chat |
| `muse-spark-1.3-contributor` | Muse Spark 1.3 Contributor | chat |
| `muse-spark-1.2-contributor` | Muse Spark 1.2 Contributor | chat |

#### `qoder-cn` — Qoder CN <sub>[site](https://qoder.com.cn)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `ultimate` | Ultimate | chat |
| `auto` | Auto | chat |
| `performance` | Performance | chat |
| `efficient` | Efficient | chat |
| `lite` | Lite | chat |
| `qmodel_38max` | Qwen3.8-Max | chat |
| `qmodel_latest` | Qwen3.7-Max | chat |
| `qmodel` | Qwen3.7-Plus | chat |
| `qfmodel` | Qwen3.8-Flash | chat |
| `kmodel_latest` | Kimi-K3 | chat |
| `kmodel` | Kimi-K2.7-Code | chat |
| `gmodel` | GLM-5.3 | chat |
| `gfmodel` | GLM-5.3-Flash | chat |
| `dmodel` | DeepSeek-V4-Pro | chat |
| `dfmodel` | DeepSeek-V4-Flash | chat |
| `mmodel` | MiniMax-M3 | chat |

#### `qoder` — Qoder <sub>[site](https://qoder.com)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `ultimate` | Ultimate | chat |
| `auto` | Auto | chat |
| `performance` | Performance | chat |
| `efficient` | Efficient | chat |
| `lite` | Lite | chat |
| `qmodel_38max` | Qwen3.8-Max | chat |
| `qmodel_latest` | Qwen3.7-Max | chat |
| `qmodel` | Qwen3.7-Plus | chat |
| `qfmodel` | Qwen3.8-Flash | chat |
| `kmodel_latest` | Kimi-K3 | chat |
| `kmodel` | Kimi-K2.7-Code | chat |
| `gmodel` | GLM-5.3 | chat |
| `gfmodel` | GLM-5.3-Flash | chat |
| `dmodel` | DeepSeek-V4-Pro | chat |
| `dfmodel` | DeepSeek-V4-Flash | chat |
| `mmodel` | MiniMax-M3 | chat |
| `smodel` | Sonus | chat |
| `cmodel` | Cantus | chat |

#### `trae` — Trae <sub>[site](https://www.trae.ai)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `auto` | Auto (Server Picks) | chat |
| `work` | Work (Fast) | chat |
| `gemini-3.1-pro` | Gemini 3.1 Pro | chat |
| `gemini-3-flash-solo` | Gemini 3 Flash | chat |
| `minimax-m3` | MiniMax M3 | chat |
| `minimax-m2.7` | MiniMax M2.7 | chat |
| `kimi-k2.5` | Kimi K2.5 | chat |
| `gpt-5.4` | GPT 5.4 | chat |
| `gpt-5.2` | GPT 5.2 | chat |

#### `windsurf` — Windsurf <sub>[site](https://windsurf.com)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `swe-1.6-fast` | SWE-1.6 Fast | chat |
| `swe-1.6` | SWE-1.6 | chat |
| `swe-1.5-fast` | SWE-1.5 Fast | chat |
| `swe-1.5` | SWE-1.5 | chat |
| `claude-opus-4.7-max` | Claude Opus 4.7 Max | chat |
| `claude-opus-4.7-xhigh` | Claude Opus 4.7 XHigh | chat |
| `claude-opus-4.7-high` | Claude Opus 4.7 High | chat |
| `claude-opus-4.7-medium` | Claude Opus 4.7 Medium | chat |
| `claude-opus-4.7-low` | Claude Opus 4.7 Low | chat |
| `claude-opus-4.7-review` | Claude Opus 4.7 Review | chat |
| `claude-sonnet-4.6-thinking-1m` | Claude Sonnet 4.6 Thinking 1M | chat |
| `claude-sonnet-4.6-1m` | Claude Sonnet 4.6 1M | chat |
| `claude-sonnet-4.6-thinking` | Claude Sonnet 4.6 Thinking | chat |
| `claude-sonnet-4.6` | Claude Sonnet 4.6 | chat |
| `claude-opus-4.6-thinking` | Claude Opus 4.6 Thinking | chat |
| `claude-opus-4.6` | Claude Opus 4.6 | chat |
| `claude-opus-4.5-thinking` | Claude Opus 4.5 Thinking | chat |
| `claude-opus-4.5` | Claude Opus 4.5 | chat |
| `claude-sonnet-4.5-thinking` | Claude Sonnet 4.5 Thinking | chat |
| `claude-sonnet-4.5` | Claude Sonnet 4.5 | chat |
| `claude-haiku-4.5` | Claude Haiku 4.5 | chat |
| `gpt-5.5-xhigh-fast` | GPT-5.5 XHigh Fast | chat |
| `gpt-5.5-xhigh` | GPT-5.5 XHigh | chat |
| `gpt-5.5-high-fast` | GPT-5.5 High Fast | chat |
| `gpt-5.5-high` | GPT-5.5 High | chat |
| `gpt-5.5-medium-fast` | GPT-5.5 Medium Fast | chat |
| `gpt-5.5-medium` | GPT-5.5 Medium | chat |
| `gpt-5.5-low-fast` | GPT-5.5 Low Fast | chat |
| `gpt-5.5-low` | GPT-5.5 Low | chat |
| `gpt-5.5-none-fast` | GPT-5.5 None Fast | chat |
| `gpt-5.5-none` | GPT-5.5 None | chat |
| `gpt-5.4-xhigh-fast` | GPT-5.4 XHigh Fast | chat |
| `gpt-5.4-xhigh` | GPT-5.4 XHigh | chat |
| `gpt-5.4-high-fast` | GPT-5.4 High Fast | chat |
| `gpt-5.4-high` | GPT-5.4 High | chat |
| `gpt-5.4-medium-fast` | GPT-5.4 Medium Fast | chat |
| `gpt-5.4-medium` | GPT-5.4 Medium | chat |
| `gpt-5.4-low-fast` | GPT-5.4 Low Fast | chat |
| `gpt-5.4-low` | GPT-5.4 Low | chat |
| `gpt-5.4-none-fast` | GPT-5.4 None Fast | chat |
| `gpt-5.4-none` | GPT-5.4 None | chat |
| `gpt-5.4-mini-xhigh` | GPT-5.4 Mini XHigh | chat |
| `gpt-5.4-mini-high` | GPT-5.4 Mini High | chat |
| `gpt-5.4-mini-medium` | GPT-5.4 Mini Medium | chat |
| `gpt-5.4-mini-low` | GPT-5.4 Mini Low | chat |
| `gpt-5.3-codex-xhigh-fast` | GPT-5.3 Codex XHigh Fast | chat |
| `gpt-5.3-codex-xhigh` | GPT-5.3 Codex XHigh | chat |
| `gpt-5.3-codex-high-fast` | GPT-5.3 Codex High Fast | chat |
| `gpt-5.3-codex-high` | GPT-5.3 Codex High | chat |
| `gpt-5.3-codex-medium-fast` | GPT-5.3 Codex Medium Fast | chat |
| `gpt-5.3-codex-medium` | GPT-5.3 Codex Medium | chat |
| `gpt-5.3-codex-low-fast` | GPT-5.3 Codex Low Fast | chat |
| `gpt-5.3-codex-low` | GPT-5.3 Codex Low | chat |
| `gpt-5.2-xhigh` | GPT-5.2 XHigh | chat |
| `gpt-5.2-high` | GPT-5.2 High | chat |
| `gpt-5.2-medium` | GPT-5.2 Medium | chat |
| `gpt-5.2-low` | GPT-5.2 Low | chat |
| `gpt-5.2-none` | GPT-5.2 None | chat |
| `gpt-5` | GPT-5 | chat |
| `gpt-4.1` | GPT-4.1 | chat |
| `gpt-4.1-mini` | GPT-4.1 Mini | chat |
| `gpt-4.1-nano` | GPT-4.1 Nano | chat |
| `gpt-4o` | GPT-4o | chat |
| `gpt-4o-mini` | GPT-4o Mini | chat |
| `gemini-3.1-pro-high` | Gemini 3.1 Pro High | chat |
| `gemini-3.1-pro-low` | Gemini 3.1 Pro Low | chat |
| `gemini-3.0-flash-high` | Gemini 3 Flash High | chat |
| `gemini-3.0-flash-medium` | Gemini 3 Flash Medium | chat |
| `gemini-3.0-flash-low` | Gemini 3 Flash Low | chat |
| `gemini-3.0-flash-minimal` | Gemini 3 Flash Minimal | chat |
| `gemini-2.5-pro` | Gemini 2.5 Pro | chat |
| `deepseek-v4` | DeepSeek V4 | chat |
| `kimi-k2.6` | Kimi K2.6 | chat |
| `kimi-k2.5` | Kimi K2.5 | chat |
| `glm-5.1` | GLM-5.1 | chat |

#### `xai` — xAI (Grok) <sub>[site](https://x.ai) · `llm`, `imageToText`, `webSearch`, `image`, `video`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `grok-4.7` | Grok 4.7 | chat |
| `grok-4.6` | Grok 4.6 | chat |
| `grok-4.5` | Grok 4.5 | chat |
| `grok-4` | Grok 4 | chat |
| `grok-4-fast-reasoning` | Grok 4 Fast Reasoning | chat |
| `grok-code-fast-1` | Grok Code Fast | chat |
| `grok-3` | Grok 3 | chat |
| `grok-2-image-1212` | Grok 2 Image | image generation |
| `grok-imagine-video` | Grok Imagine Video | video |

#### `xiaomi-mimo` — Xiaomi MiMo <sub>[site](https://xiaomimimo.com) · `llm`, `tts`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `mimo-v2.6-pro` | MiMo V2.6 Pro | chat |
| `mimo-v2.6-flash` | MiMo V2.6 Flash | chat |
| `mimo-v2.6-pro-ultraspeed` | MiMo V2.6 Pro UltraSpeed | chat |
| `mimo-v2.5-pro` | MiMo V2.5 Pro | chat |
| `mimo-v2.5` | MiMo V2.5 | chat |
| `mimo-v2-omni` | MiMo V2 Omni | chat |
| `mimo-v2-flash` | MiMo V2 Flash | chat |
| `mimo-v2.5-tts` | MiMo V2.5 TTS | text-to-speech |

#### `zed` — Zed <sub>[site](https://zed.dev)</sub>

- No static model list. This entry resolves its models at runtime — from the account, the
  provider's own catalogue endpoint, or a local daemon — so nothing can be enumerated here.

### webCookie

#### `chatgpt-web` — ChatGPT Web <sub>[site](https://chatgpt.com) · `image`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `gpt-5-6` | GPT-5.6 Sol — Instant | chat |
| `gpt-5-6-thinking` | GPT-5.6 Sol — Thinking | chat |
| `gpt-5-6-pro` | GPT-5.6 Sol — Pro | chat |
| `gpt-5.6-luna-free` | GPT-5.6 Luna — Free | chat |
| `gpt-5.6-luna-free-thinking` | GPT-5.6 Luna — Free Thinking | chat |
| `gpt-5-5-instant` | GPT-5.5 — Instant | chat |
| `gpt-5-5-thinking` | GPT-5.5 — Thinking | chat |
| `gpt-5-5-pro` | GPT-5.5 — Pro | chat |
| `gpt-image-2` | GPT Image 2 (web) | image generation |

#### `deepseek-web` — DeepSeek Web <sub>[site](https://chat.deepseek.com)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `deepseek-v4-pro` | DeepSeek V4 Pro | chat |
| `deepseek-v4-pro-think` | DeepSeek V4 Pro Think | chat |
| `deepseek-v4-pro-search` | DeepSeek V4 Pro Search | chat |
| `deepseek-v4-pro-think-search` | DeepSeek V4 Pro Think+Search | chat |
| `deepseek-v4-flash` | DeepSeek V4 Flash | chat |
| `deepseek-v4-flash-think` | DeepSeek V4 Flash Think | chat |
| `deepseek-v4-flash-search` | DeepSeek V4 Flash Search | chat |
| `deepseek-v4-flash-think-search` | DeepSeek V4 Flash Think+Search | chat |
| `deepseek-chat` | DeepSeek Chat | chat |
| `deepseek-reasoner` | DeepSeek Reasoner | chat |
| `DeepSeek-R1` | DeepSeek R1 | chat |
| `DeepSeek-R1-Search` | DeepSeek R1 Search | chat |
| `DeepSeek-V3.2` | DeepSeek V3.2 | chat |
| `DeepSeek-Search` | DeepSeek Search | chat |

#### `gemini-web` — Gemini Web <sub>[site](https://gemini.google.com) · `image`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `gemini-3.1-pro` | Gemini 3.1 Pro | chat |
| `gemini-3.7-flash` | Gemini 3.7 Flash | chat |
| `gemini-3.1-flash-lite` | Gemini 3.1 Flash-Lite | chat |
| `gemini-image` | Gemini Image (web) | image generation |

#### `grok-web` — Grok Web (Subscription) <sub>[site](https://grok.com) · `image`, `video`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `grok-image` | Grok Imagine Image | image generation |
| `grok-video` | Grok Imagine Video | video |
| `grok-3` | Grok 3 | chat |
| `grok-3-mini` | Grok 3 Mini (Thinking) | chat |
| `grok-3-thinking` | Grok 3 Thinking | chat |
| `grok-4` | Grok 4 | chat |
| `grok-4-mini` | Grok 4 Mini (Thinking) | chat |
| `grok-4-thinking` | Grok 4 Thinking | chat |
| `grok-4-heavy` | Grok 4 Heavy (SuperGrok) | chat |
| `grok-4.1-mini` | Grok 4.1 Mini (Thinking) | chat |
| `grok-4.1-fast` | Grok 4.1 Fast | chat |
| `grok-4.1-expert` | Grok 4.1 Expert | chat |
| `grok-4.1-thinking` | Grok 4.1 Thinking | chat |
| `grok-4.2` | Grok 4.2 (4.20 Beta) | chat |

#### `muse-web` — Muse Web <sub>[site](https://muse.ai) · `image`, `video`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `muse-chat` | Muse Chat | chat |
| `muse-image` | Muse Image | image generation |
| `muse-video` | Muse Video | video |

#### `perplexity-web` — Perplexity Web (Pro/Max) <sub>[site](https://www.perplexity.ai)</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `pplx-auto` | Perplexity Auto (Free) | chat |
| `pplx-sonar` | Perplexity Sonar | chat |
| `pplx-gpt` | GPT-5.4 (via Perplexity) | chat |
| `pplx-gemini` | Gemini 3.1 Pro (via Perplexity) | chat |
| `pplx-sonnet` | Claude Sonnet 4.6 (via Perplexity) | chat |
| `pplx-opus` | Claude Opus 4.6 (via Perplexity) | chat |
| `pplx-nemotron` | Nemotron 3 Super (via Perplexity) | chat |

#### `uc-web` — UC Web <sub>[site](https://uncensored.com) · `image`, `video`</sub>

| Model id | Name | Kind |
| --- | --- | --- |
| `seedream-v4.5` | Seedream v4.5 (UC) | image generation |
| `seedream-v5` | Seedream v5 (UC) | image generation |
| `seedream-v5-flash` | Seedream v5 Flash (UC) | image generation |
| `nano-banana-pro-ultra` | Nano Banana Pro Ultra (UC) | image generation |
| `nano-banana-pro` | Nano Banana Pro (UC) | image generation |
| `nano-banana` | Nano Banana (UC) | image generation |
| `nano-banana-2` | Nano Banana 2 (UC) | image generation |
| `gpt-image` | GPT Image 1.5 (UC) | image generation |
| `gpt-image-2` | GPT Image 2 (UC) | image generation |
| `gpt-image-2.5-flare` | GPT Image 2.5 Flare (UC) | image generation |
| `gpt-image-2.5-sunburst` | GPT Image 2.5 Sunburst (UC) | image generation |
| `wan-2.6-image` | Wan 2.6 Image (UC) | image generation |
| `wan-2.7-text-to-image` | Wan 2.7 (UC) | image generation |
| `wan-2.7-text-to-image-pro` | Wan 2.7 Pro (UC) | image generation |
| `prefect-pony-xl` | Prefect Pony XL (UC) | image generation |
| `1.0` | Flux.1 (UC) | image generation |
| `1.1` | Flux.1.1 (UC) | image generation |
| `2.0` | Flux.2 (UC) | image generation |
| `flux-2-max` | Flux 2 Max (UC) | image generation |
| `SDXL` | SDXL Uncensored (UC) | image generation |
| `realism` | Realism (UC) | image generation |
| `realism-2` | Realism 2 (UC) | image generation |
| `z-image-turbo` | Z-Image Turbo (UC) | image generation |
| `default` | Video Standard (UC) | video |
| `turbo` | Video Turbo (UC) | video |
| `wan-2.2-uncensored` | Wan Ultra Uncensored (UC) | video |
| `wan-2.2-uncensored-v2` | Wan Ultra Uncensored v2 (UC) | video |
| `wan-2.6` | Wan 2.6 Video (UC) | video |
| `wan-2.6-ultra` | Wan 2.6 Ultra Uncensored (UC) | video |
| `wan-2.7` | Wan 2.7 Video (UC) | video |
| `wan-2.7-pro` | Wan 2.7 Pro Video (UC) | video |
| `wan-2.7-uncensored` | Wan 2.7 Uncensored (UC) | video |
| `wan-2.7-uncensored-v2` | Wan 2.7 Uncensored v2 (UC) | video |
| `wan-3.0` | Wan 3.0 (UC) | video |
| `wan-3.0-uncensored` | Wan 3.0 Uncensored (UC) | video |
| `wan-3.0-uncensored-pro` | Wan 3.0 Uncensored Pro (UC) | video |
| `sora-2` | Sora 2 (UC) | video |
| `sora-2-pro` | Sora 2 Pro (UC) | video |
| `grok-imagine-video` | Grok Imagine Video (UC) | video |
| `bytedance-seedance-2.0` | Seedance 2.0 (UC) | video |
| `seedance-2.0-fast` | Seedance 2.0 Fast (UC) | video |
| `seedance-2.0-uncensored` | Seedance 2.0 Uncensored (UC) | video |
| `seedance-2.0-fast-uncensored` | Seedance 2.0 Fast Uncensored (UC) | video |
| `seedance-2.0-mini-uncensored` | Seedance 2.0 Mini Uncensored (UC) | video |
| `seedance-2.0-mini-turbo` | Seedance 2.0 Mini Turbo Uncensored (UC) | video |
| `seedance-v1.5-pro-uncensored` | Seedance v1.5 Pro Uncensored (UC) | video |
| `seedance-2.5-uncensored` | Seedance 2.5 Uncensored (UC) | video |
| `seedance-2.5` | Seedance 2.5 (UC) | video |
| `vidu-q3-uncensored` | Vidu Q3 Uncensored (UC) | video |
| `av-gen-v2` | AV-Gen v2 with audio (UC) | video |
| `cosmos-predict` | Cosmos Predict 2.5 (UC) | video |
| `minimax-h3` | MiniMax H3 (UC) | video |
| `happyhorse-1.0` | Happy Horse 1.0 (UC) | video |

## Entries with no static model list

These are listed separately because "no models" and "zero models" are different facts, and only
one of them is a statement about this registry.

| Entry | Category | Service kinds |
| --- | --- | --- |
| `aws-polly` | apikey | `tts` |
| `azure` | apikey | — |
| `bai` | apikey | — |
| `brave-search` | apikey | `webSearch` |
| `cartesia` | apikey | `tts` |
| `chutes` | apikey | — |
| `coqui` | freeTier | `tts` |
| `edge-tts` | freeTier | `tts` |
| `elevenlabs` | apikey | `tts`, `stt` |
| `exa` | apikey | `webSearch`, `webFetch` |
| `firecrawl` | apikey | `webFetch` |
| `gitlab` | oauth | — |
| `google-pse` | apikey | `webSearch` |
| `google-tts` | freeTier | `tts` |
| `inworld` | apikey | `tts` |
| `jina-ai` | apikey | `embedding` |
| `jina-reader` | apikey | `webFetch` |
| `linkup` | apikey | `webSearch` |
| `local-device` | freeTier | `tts` |
| `nous` | freeTier | `llm`, `imageToText` |
| `ollama-search` | apikey | `webSearch` |
| `playht` | apikey | `tts` |
| `searchapi` | apikey | `webSearch` |
| `searxng` | freeTier | `webSearch` |
| `serper` | apikey | `webSearch` |
| `tavily` | apikey | `webSearch`, `webFetch` |
| `tinyfish` | apikey | `webSearch`, `webFetch` |
| `topaz` | apikey | `image` |
| `tortoise` | freeTier | `tts` |
| `vercel-ai-gateway` | apikey | `llm`, `embedding`, `image`, `imageToText`, `webSearch` |
| `xquik` | apikey | `webSearch` |
| `youcom` | apikey | `webSearch` |
| `zed` | oauth | — |

