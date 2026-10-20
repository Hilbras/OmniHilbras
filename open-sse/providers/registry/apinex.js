export default {
  id: "apinex",
  priority: 98,
  alias: "apinex",
  uiAlias: "apinex",
  display: {
    name: "APInex",
    icon: "api",
    color: "#7c3aed",
    textIcon: "AX",
    website: "https://apinex.bond/",
    notice: {
      text: "One API key for OpenAI-compatible models, web research and voice on a single token balance. Key from apinex.bond; models fetched live with real context windows.",
      apiKeyUrl: "https://apinex.bond/",
    },
  },
  category: "freeTier",
  authType: "apikey",
  transport: {
    baseUrl: "https://api.apinex.bond/v1/chat/completions",
    format: "openai",
    validateUrl: "https://api.apinex.bond/v1/models",
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
    retry: { 429: 2 },
    usage: {
      apiBase: "https://api.apinex.bond/v1",
      flavor: "apinex-balance",
      // /v1/balance reports the account wallet (balance_usd) and the key's rpm limit.
    },
  },
  models: [
    { id: "gpt-4o-mini", name: "GPT-4o Mini" },
    { id: "claude-3-5-haiku", name: "Claude 3.5 Haiku" },
  ],
  modelsFetcher: { url: "https://api.apinex.bond/v1/models", type: "openai" },
  passthroughModels: true,
  features: {
    usage: true,
    usageApikey: true,
  },
};
