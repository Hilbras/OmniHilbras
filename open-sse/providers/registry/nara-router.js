export default {
  id: "nara-router",
  priority: 96,
  alias: "nara-router",
  aliases: ["nara", "bynara"],
  uiAlias: "nara",
  display: {
    name: "NaraRouter",
    icon: "hub",
    color: "#2d3948",
    textIcon: "NR",
    website: "https://router.bynara.id/",
    notice: {
      text: "OpenAI-compatible router with a Free plan (daily token cap and RPM limit). Key from router.bynara.id; models are fetched live with their real context windows.",
      apiKeyUrl: "https://router.bynara.id/",
    },
  },
  category: "freeTier",
  authType: "apikey",
  transport: {
    baseUrl: "https://router.bynara.id/v1/chat/completions",
    format: "openai",
    validateUrl: "https://router.bynara.id/v1/models",
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
    retry: { 429: 2 },
    usage: {
      apiBase: "https://router.bynara.id/v1",
    },
  },
  // Curated seed; live catalogue via modelsFetcher. Anything else accepted via passthroughModels.
  models: [
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { id: "deepseek-chat", name: "DeepSeek Chat" },
    { id: "qwen-plus", name: "Qwen Plus" },
  ],
  modelsFetcher: { url: "https://router.bynara.id/v1/models", type: "openai" },
  passthroughModels: true,
  features: {
    usage: true,
    usageApikey: true,
  },
};
