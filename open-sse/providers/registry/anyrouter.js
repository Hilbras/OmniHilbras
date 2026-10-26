// AnyRouter — OpenAI-compatible gateway (reverse-engineered wire, verified live 2026-10).
// https://anyrouter.dev/v1/chat/completions, standard OpenAI SSE + /v1/models.
export default {
  id: "anyrouter",
  priority: 50,
  alias: "anyrouter",
  display: {
    name: "AnyRouter",
    icon: "router",
    color: "#6366F1",
    textIcon: "AR",
    website: "https://anyrouter.dev",
    notice: {
      apiKeyUrl: "https://anyrouter.dev",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://anyrouter.dev/v1/chat/completions",
    format: "openai",
    headers: {
      "HTTP-Referer": "https://endpoint-proxy.local",
      "X-Title": "Endpoint Proxy",
    },
  },
  models: [],
  modelsFetcher: { url: "https://anyrouter.dev/v1/models", type: "openai" },
  features: {
    usage: false,
  },
};
