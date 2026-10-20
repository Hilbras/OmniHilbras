export default {
  id: "xkiro",
  priority: 100,
  alias: "xkiro",
  aliases: ["x-kiro"],
  uiAlias: "xkiro",
  display: {
    name: "XKiro",
    icon: "hub",
    color: "#16a34a",
    textIcon: "XK",
    website: "https://xkiro.com/",
    notice: {
      text: "One API key for 90+ models from 16 providers via OpenAI- or Anthropic-compatible requests. Key from xkiro.com; 40+ models listed as free. Models fetched live with real context windows.",
      apiKeyUrl: "https://xkiro.com/",
    },
  },
  category: "freeTier",
  authType: "apikey",
  transport: {
    baseUrl: "https://api.xkiro.com/v1/chat/completions",
    format: "openai",
    validateUrl: "https://api.xkiro.com/v1/models",
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
    retry: { 429: 2 },
    usage: {
      apiBase: "https://api.xkiro.com/v1",
      flavor: "xkiro-usage",
      // /v1/usage reports the free daily token allowance (used_today/limit_per_day) and the wallet.
    },
  },
  models: [
    { id: "gpt-4o-mini", name: "GPT-4o Mini" },
    { id: "claude-3-5-haiku", name: "Claude 3.5 Haiku" },
    { id: "deepseek-chat", name: "DeepSeek Chat" },
  ],
  modelsFetcher: { url: "https://api.xkiro.com/v1/models", type: "openai" },
  passthroughModels: true,
  features: {
    usage: true,
    usageApikey: true,
  },
};
