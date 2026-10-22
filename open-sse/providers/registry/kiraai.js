export default {
  id: "kiraai",
  priority: 121,
  alias: "kiraai",
  aliases: [
    "kira",
  ],
  uiAlias: "kiraai",
  display: {
    name: "KiraAI",
    icon: "bolt",
    color: "#7C3AED",
    textIcon: "KA",
    website: "https://kiraai.vn",
    notice: {
      text: "OpenAI-compatible aggregator. One API key reaches Kira, Claude, GPT, Gemini, DeepSeek and more, billed from a VND wallet (kira-* models can also run on token packages). Model ids are bare and fetched live from the provider.",
      apiKeyUrl: "https://kiraai.vn",
    },
  },
  category: "freeTier",
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    // OpenAI-compatible. `format` stays at the shared "openai" default and
    // `thinkingFormat` is deliberately not declared: KiraAI forwards requests
    // verbatim, so each model resolves its own thinking wire format.
    baseUrl: "https://kiraai.vn/api/v1/chat/completions",
    validateUrl: "https://kiraai.vn/api/v1/models",
    retry: {
      429: 2,
    },
    usage: {
      // No account/billing read endpoint exists, so the shared aggregator
      // adapter falls through to its local-history rows.
      apiBase: "https://kiraai.vn/api/v1",
    },
  },
  serviceKinds: ["llm", "image", "tts"],
  // Same key as chat; KiraAI exposes OpenAI-shaped image and speech endpoints.
  imageConfig: {
    baseUrl: "https://kiraai.vn/api/v1/images/generations",
  },
  ttsConfig: {
    baseUrl: "https://kiraai.vn/api/v1/audio/speech",
    authType: "apikey",
    authHeader: "bearer",
    format: "openai",
    defaultModel: "kira-3.0-flash-tts",
  },
  // Curated seed; the live catalogue is fetched via modelsFetcher. KiraAI has
  // no passthrough: its /models list is authoritative, so an id missing from it
  // is rejected at the gateway instead of being sent upstream.
  models: [
    { id: "kira-3.5-pro", name: "Kira 3.5 Pro" },
    { id: "kira-3.5-flash", name: "Kira 3.5 Flash" },
    { id: "kira-2.5-pro", name: "Kira 2.5 Pro" },
    { id: "kira-3.0-image", name: "Kira 3.0 Image", kind: "image", capabilities: ["text2img"] },
    { id: "kira-3.0-flash-tts", name: "Kira 3.0 Flash TTS", kind: "tts" },
    { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5" },
    { id: "gpt-6-sol", name: "GPT-6 Sol" },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "grok-4.7", name: "Grok 4.7" },
    { id: "kira-mini-1.0", name: "Kira Mini 1.0 (Free)" },
    { id: "deepseek-v4-flash-free", name: "DeepSeek V4 Flash (Free)" },
  ],
  modelsFetcher: { url: "https://kiraai.vn/api/v1/models", type: "openai" },
  features: {
    usage: true,
    usageApikey: true,
  },
};