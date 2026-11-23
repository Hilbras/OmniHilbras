import type { ProviderRegistryRow } from './providerRegistryTypes.js';

/**
 * One registry row per catalog provider id. Generated from `src/data/providers.ts`; a guard fails if a card
 * has no row or a row has no card. The dashboard card remains the display layer, not the only source of
 * truth for a provider's base URL and wire format.
 */
export const PROVIDER_REGISTRY: Readonly<Record<string, ProviderRegistryRow>> = Object.freeze({
  "opencode-console": { id: "opencode-console", name: "OpenCode Console", baseUrl: "https://opencode.ai/inference/openai/v1", modelsUrl: "https://opencode.ai/inference/openai/v1/models", auth: "oauth", formats: ["openai"] },
  "chatgpt-web": { id: "chatgpt-web", name: "ChatGPT Web", baseUrl: "https://chatgpt.com", auth: "web", formats: ["web"] },
  "qwen-web": { id: "qwen-web", name: "Qwen Web", baseUrl: "https://chat.qwen.ai", auth: "web", formats: ["web"] },
  "deepseek-web-v2": { id: "deepseek-web-v2", name: "DeepSeek Web V2", baseUrl: "https://chat.deepseek.com", auth: "web", formats: ["web"] },
  "deepseek-web": { id: "deepseek-web", name: "DeepSeek Web", baseUrl: "https://chat.deepseek.com", auth: "web", formats: ["web"] },
  "kiro": { id: "kiro", name: "Kiro", baseUrl: "https://codewhisperer.us-east-1.amazonaws.com", modelsUrl: "https://codewhisperer.us-east-1.amazonaws.com/models", auth: "oauth", formats: ["claude"] },
  "cline": { id: "cline", name: "Cline", baseUrl: "https://api.cline.bot/api/v1", modelsUrl: "https://api.cline.bot/api/v1/models", auth: "oauth", formats: ["openai"] },
  "clinepass": { id: "clinepass", name: "ClinePass", baseUrl: "https://api.cline.bot/api/v1", modelsUrl: "https://api.cline.bot/api/v1/models", auth: "oauth", formats: ["openai"] },
  "opencode": { id: "opencode", name: "OpenCode Zen", baseUrl: "https://opencode.ai/zen/v1", modelsUrl: "https://opencode.ai/zen/v1/models", auth: "api-key", formats: ["openai"], usageUrl: "https://opencode.ai/zen/v1/usage" },
  "agnes-ai": { id: "agnes-ai", name: "Agnes AI", baseUrl: "https://apihub.agnes-ai.com/v1", modelsUrl: "https://apihub.agnes-ai.com/v1/models", auth: "api-key", formats: ["openai"] },
  "agentrouter": { id: "agentrouter", name: "AgentRouter", baseUrl: "https://agentrouter.org/v1", modelsUrl: "https://agentrouter.org/v1/models", auth: "api-key", formats: ["openai"] },
  "aion-labs": { id: "aion-labs", name: "Aion Labs", baseUrl: "https://api.aionlabs.ai/v1", modelsUrl: "https://api.aionlabs.ai/v1/models", auth: "api-key", formats: ["openai"] },
  "100milionseek": { id: "100milionseek", name: "100milionseek", baseUrl: "https://100milionseek.top/v1", modelsUrl: "https://100milionseek.top/v1/models", auth: "api-key", formats: ["openai"] },
  "nous": { id: "nous", name: "Nous Research", baseUrl: "https://inference-api.nousresearch.com/v1", modelsUrl: "https://inference-api.nousresearch.com/v1/models", auth: "api-key", formats: ["openai"] },
  "numes": { id: "numes", name: "Numes", baseUrl: "https://api.numes.ai/api/v1", modelsUrl: "https://api.numes.ai/api/v1/models", auth: "api-key", formats: ["openai"] },
  "beatapi": { id: "beatapi", name: "BeatAPI", baseUrl: "https://api.beatapi.io/v1", modelsUrl: "https://api.beatapi.io/v1/models", auth: "api-key", formats: ["openai"] },
  "kiraai": { id: "kiraai", name: "KiraAI", baseUrl: "https://kiraai.vn/api/v1", modelsUrl: "https://kiraai.vn/api/v1/models", auth: "api-key", formats: ["openai"] },
  "vengetic": { id: "vengetic", name: "Vengetic", baseUrl: "https://api.vengetic.biz.id/v1", modelsUrl: "https://api.vengetic.biz.id/v1/models", auth: "api-key", formats: ["openai"] },
  "anyrouter": { id: "anyrouter", name: "AnyRouter", baseUrl: "https://anyrouter.dev/api/v1", modelsUrl: "https://anyrouter.dev/api/v1/models", auth: "api-key", formats: ["openai"] },
  "zro": { id: "zro", name: "Zro", baseUrl: "https://zro.moonmath.ai/v1", modelsUrl: "https://zro.moonmath.ai/v1/models", auth: "api-key", formats: ["openai"] },
  "unorouter": { id: "unorouter", name: "UnoRouter", baseUrl: "https://api.unorouter.com/v1", modelsUrl: "https://api.unorouter.com/v1/models", auth: "api-key", formats: ["openai"] },
  "ollama": { id: "ollama", name: "Ollama", baseUrl: "http://localhost:11434/v1", modelsUrl: "http://localhost:11434/v1/models", auth: "none", formats: ["openai"] },
  "opencode-go": { id: "opencode-go", name: "OpenCode Go", baseUrl: "https://opencode.ai/zen/go/v1", modelsUrl: "https://opencode.ai/zen/go/v1/models", auth: "api-key", formats: ["openai"], usageUrl: "https://opencode.ai/zen/go/v1/usage" },
  "mistral": { id: "mistral", name: "Mistral", baseUrl: "https://api.mistral.ai/v1", modelsUrl: "https://api.mistral.ai/v1/models", auth: "api-key", formats: ["openai"] },
  "openrouter": { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", modelsUrl: "https://openrouter.ai/api/v1/models", auth: "api-key", formats: ["openai"] },
  "nara-router": { id: "nara-router", name: "NaraRouter", baseUrl: "https://router.bynara.id/v1", modelsUrl: "https://router.bynara.id/v1/models", auth: "api-key", formats: ["openai"] },
  "tokenharbor": { id: "tokenharbor", name: "TokenHarbor", baseUrl: "https://tokenharbor.ai/v1", modelsUrl: "https://tokenharbor.ai/v1/models", auth: "api-key", formats: ["openai"] },
  "apmix": { id: "apmix", name: "apmix", baseUrl: "https://api.apmix.ai/v1", modelsUrl: "https://api.apmix.ai/v1/models", auth: "api-key", formats: ["openai"] },
  "apinex": { id: "apinex", name: "APInex", baseUrl: "https://api.apinex.bond/v1", modelsUrl: "https://api.apinex.bond/v1/models", auth: "api-key", formats: ["openai"] },
  "tiarina": { id: "tiarina", name: "Tiarina", baseUrl: "https://ai.tiarina.cloud/v1", modelsUrl: "https://ai.tiarina.cloud/v1/models", auth: "api-key", formats: ["openai"] },
  "xkiro": { id: "xkiro", name: "xKiro", baseUrl: "https://api.xkiro.com/v1", modelsUrl: "https://api.xkiro.com/v1/models", auth: "api-key", formats: ["openai"] },
  "duckduckgo-web": { id: "duckduckgo-web", name: "Duck.ai", baseUrl: "https://duck.ai", auth: "web", formats: ["web"] },
  "grok-web": { id: "grok-web", name: "Grok Web", baseUrl: "https://grok.com", auth: "web", formats: ["web"] },
  "perplexity-web": { id: "perplexity-web", name: "Perplexity Web", baseUrl: "https://www.perplexity.ai", auth: "web", formats: ["web"] },
  "kimi": { id: "kimi", name: "Kimi", baseUrl: "https://api.moonshot.ai/v1", modelsUrl: "https://api.moonshot.ai/v1/models", auth: "api-key", formats: ["openai"] },
  "kimi-code": { id: "kimi-code", name: "Kimi Code", baseUrl: "https://api.kimi.com", modelsUrl: "https://api.kimi.com/models", auth: "oauth", formats: ["openai"] },
  "claude-code": { id: "claude-code", name: "Claude Code", baseUrl: "https://api.anthropic.com", modelsUrl: "https://api.anthropic.com/models", auth: "oauth", formats: ["claude"] },
  "codex": { id: "codex", name: "Codex", baseUrl: "https://chatgpt.com/backend-api/codex/responses", modelsUrl: "https://chatgpt.com/backend-api/codex/models", auth: "oauth", formats: ["responses"] },
  "qoder": { id: "qoder", name: "Qoder", baseUrl: "https://api3.qoder.sh", modelsUrl: "https://api3.qoder.sh/models", auth: "oauth", formats: ["openai"] },
  "kilocode": { id: "kilocode", name: "Kilo Code", baseUrl: "https://api.kilo.ai", modelsUrl: "https://api.kilo.ai/models", auth: "oauth", formats: ["openai"] },
  "minimax-code": { id: "minimax-code", name: "MiniMax Code", baseUrl: "https://agent.minimax.cn", modelsUrl: "https://agent.minimax.cn/models", auth: "oauth", formats: ["openai"] },
  "minimax-code-global": { id: "minimax-code-global", name: "MiniMax Code (Global)", baseUrl: "https://agent.minimax.io", modelsUrl: "https://agent.minimax.io/models", auth: "oauth", formats: ["openai"] },
  "codebuddy-intl": { id: "codebuddy-intl", name: "CodeBuddy (Global)", baseUrl: "https://www.codebuddy.ai", modelsUrl: "https://www.codebuddy.ai/models", auth: "oauth", formats: ["openai"] },
  "deepseek": { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", modelsUrl: "https://api.deepseek.com/v1/models", auth: "api-key", formats: ["openai"] },
  "qwen": { id: "qwen", name: "Qwen", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", modelsUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models", auth: "api-key", formats: ["openai"] },
  "qwen-token-plan": { id: "qwen-token-plan", name: "Qwen (Token Plan)", baseUrl: "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1", modelsUrl: "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1/models", auth: "api-key", formats: ["openai"] },
  "zcode": { id: "zcode", name: "ZCode (Start Plan)", baseUrl: "https://zcode.z.ai", modelsUrl: "https://zcode.z.ai/models", auth: "oauth", formats: ["openai"] },
  "groq": { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", modelsUrl: "https://api.groq.com/openai/v1/models", auth: "api-key", formats: ["openai"] },
  "grok": { id: "grok", name: "Grok", baseUrl: "https://api.x.ai/v1", modelsUrl: "https://api.x.ai/v1/models", auth: "api-key", formats: ["openai"] },
  "nvidia": { id: "nvidia", name: "NVIDIA", baseUrl: "https://integrate.api.nvidia.com/v1", modelsUrl: "https://integrate.api.nvidia.com/v1/models", auth: "api-key", formats: ["openai"] },
  "together": { id: "together", name: "Together AI", baseUrl: "https://api.together.xyz/v1", modelsUrl: "https://api.together.xyz/v1/models", auth: "api-key", formats: ["openai"] },
  "fireworks": { id: "fireworks", name: "Fireworks AI", baseUrl: "https://api.fireworks.ai/inference/v1", modelsUrl: "https://api.fireworks.ai/inference/v1/models", auth: "api-key", formats: ["openai"] },
  "coarena": { id: "coarena", name: "Coarena", baseUrl: "https://coarena.ai/api/v1", modelsUrl: "https://coarena.ai/api/v1/models", auth: "api-key", formats: ["openai"] },
  "openai": { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", modelsUrl: "https://api.openai.com/v1/models", auth: "api-key", formats: ["openai"] },
  "anthropic": { id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com/v1", modelsUrl: "https://api.anthropic.com/v1/models", auth: "api-key", formats: ["claude"] },
  "gemini": { id: "gemini", name: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", modelsUrl: "https://generativelanguage.googleapis.com/v1beta/models", auth: "api-key", formats: ["gemini"] },
  "custom": { id: "custom", name: "Custom endpoint", baseUrl: "http://localhost:8000/v1", modelsUrl: "http://localhost:8000/v1/models", auth: "api-key", formats: ["openai"] },
  "tokenharbor-web": { id: "tokenharbor-web", name: "Token Harbor Web", baseUrl: "https://tokenharbor.ai", auth: "web", formats: ["web"] },
  "gemini-web": { id: "gemini-web", name: "Gemini Web", baseUrl: "https://gemini.google.com", auth: "web", formats: ["web"] },
  "codebuddy-cn": { id: "codebuddy-cn", name: "CodeBuddy", baseUrl: "https://copilot.tencent.com", auth: "oauth", formats: ["claude"] },
});

export function providerRegistryRow(id: string): ProviderRegistryRow | undefined {
  return PROVIDER_REGISTRY[id];
}
export function providerRegistryIds(): readonly string[] {
  return Object.keys(PROVIDER_REGISTRY);
}
