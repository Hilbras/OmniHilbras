export default {
  id: "tiarina",
  priority: 99,
  alias: "tiarina",
  uiAlias: "tiarina",
  display: {
    name: "Tiarina",
    icon: "cloud",
    color: "#0f766e",
    textIcon: "TI",
    website: "https://tiarina.cloud/",
    notice: {
      text: "OpenAI-compatible gateway with a free tier on selected models. Key from the Tiarina dashboard; models fetched live with real context windows.",
      apiKeyUrl: "https://tiarina.cloud/",
    },
  },
  category: "freeTier",
  authType: "apikey",
  transport: {
    baseUrl: "https://ai.tiarina.cloud/v1/chat/completions",
    format: "openai",
    validateUrl: "https://ai.tiarina.cloud/v1/models",
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
    retry: { 429: 2 },
  },
  models: [
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { id: "deepseek-chat", name: "DeepSeek Chat" },
  ],
  modelsFetcher: { url: "https://ai.tiarina.cloud/v1/models", type: "openai" },
  passthroughModels: true,
};
