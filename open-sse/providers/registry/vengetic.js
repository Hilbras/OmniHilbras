// Vengetic — OpenAI-compatible gateway (reverse-engineered wire, verified live 2026-10).
// https://api.vengetic.biz.id/v1/chat/completions, standard OpenAI SSE + /v1/models.
export default {
  id: "vengetic",
  priority: 50,
  alias: "vengetic",
  display: {
    name: "Vengetic",
    icon: "router",
    color: "#10B981",
    textIcon: "VG",
    website: "https://vengetic.biz.id",
    notice: {
      apiKeyUrl: "https://vengetic.biz.id",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://api.vengetic.biz.id/v1/chat/completions",
    format: "openai",
    headers: {
      "HTTP-Referer": "https://endpoint-proxy.local",
      "X-Title": "Endpoint Proxy",
    },
  },
  models: [],
  modelsFetcher: { url: "https://api.vengetic.biz.id/v1/models", type: "openai" },
  features: {
    usage: false,
  },
};
