export default {
  id: "apmix",
  priority: 97,
  alias: "apmix",
  uiAlias: "apmix",
  display: {
    name: "APMIX.AI",
    icon: "bolt",
    color: "#2563eb",
    textIcon: "AM",
    website: "https://apmix.ai/",
    notice: {
      text: "One API key for GPT, Claude, Gemini, Grok, DeepSeek and Qwen on a monthly allowance rather than per-token billing. Key from apmix.ai; models fetched live with real context windows.",
      apiKeyUrl: "https://apmix.ai/",
    },
  },
  category: "freeTier",
  authType: "apikey",
  transport: {
    baseUrl: "https://api.apmix.ai/v1/chat/completions",
    format: "openai",
    validateUrl: "https://api.apmix.ai/v1/models",
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
    retry: { 429: 2 },
  },
  models: [
    { id: "gpt-4o-mini", name: "GPT-4o Mini" },
    { id: "claude-3-5-haiku", name: "Claude 3.5 Haiku" },
    { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" },
  ],
  modelsFetcher: { url: "https://api.apmix.ai/v1/models", type: "openai" },
  passthroughModels: true,
};
