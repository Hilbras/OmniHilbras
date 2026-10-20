export default {
  id: "beatapi",
  priority: 100,
  alias: "beatapi",
  aliases: ["beat", "beat-ai"],
  uiAlias: "beatapi",
  display: {
    name: "BeatAPI",
    icon: "music_note",
    color: "#E11D48",
    textIcon: "BA",
    website: "https://beatapi.io/",
    notice: {
      text: "One API key for text, image, video and music models. Free credit tier included on signup — a top-up unlocks every model. Key from beatapi.io/dashboard/apikeys. Models are fetched live with real context windows.",
      apiKeyUrl: "https://beatapi.io/dashboard/apikeys",
    },
  },
  category: "freeTier",
  authType: "apikey",
  transport: {
    // OpenAI-compatible chat + the /v1/responses lane. The key works with or
    // without the `sk-` prefix.
    baseUrl: "https://api.beatapi.io/v1/chat/completions",
    format: "openai",
    validateUrl: "https://api.beatapi.io/v1/models",
    retry: { 429: 2 },
    usage: {
      // /v1/usage reports the account's USD credit balance, task count and
      // concurrency limit — see open-sse/services/usage/aggregator.js.
      apiBase: "https://api.beatapi.io/v1",
      flavor: "beatapi-usage",
    },
  },
  // Curated seed; the live catalogue is fetched via modelsFetcher and any other
  // id is accepted via passthroughModels.
  models: [
    { id: "gpt-4o-mini", name: "GPT-4o Mini" },
    { id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { id: "deepseek-chat", name: "DeepSeek Chat" },
  ],
  modelsFetcher: { url: "https://api.beatapi.io/v1/models", type: "openai" },
  passthroughModels: true,
  features: {
    usage: true,
    usageApikey: true,
  },
};
