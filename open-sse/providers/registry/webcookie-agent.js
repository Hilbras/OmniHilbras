// Web-Cookie Agent — a virtual provider that turns the "Web Cookie Sessions"
// and "Web Cookie Providers" groups into one autonomous agent: the model's
// chat turns run on the free web-cookie providers, and its tool calls are
// executed locally by OmniHilbras's own capabilities (web search / fetch /
// image / tts / stt / embeddings / video) so the agent can actually *do*
// things, not just talk.
//
// The executor (executors/webcookie-agent.js) is the router + tool loop.
// There is no credential of its own — it rides on the operator's stored
// web-cookie sessions — hence noAuth, like the other free-tier providers.
export default {
  id: "webcookie-agent",
  priority: 900,
  alias: "webcookie-agent",
  aliases: ["wca", "agent-web"],
  uiAlias: "WCA",
  display: {
    name: "Web-Cookie Agent",
    icon: "smart_toy",
    color: "#7C3AED",
    textIcon: "WA",
    website: "https://omnihilbras.com",
    notice: {
      text: "An agent built from your Web-Cookie providers. Each chat turn runs on a free browser-session model; when the model asks for a tool (search, fetch, image, audio…), OmniHilbras runs it locally and feeds the result back. Add at least one web-cookie connection (chatgpt-web, deepseek-web, duckduckgo-web, gemini-web, qwen-web, tokenharbor-web, grok-web, perplexity-web) to get started.",
    },
  },
  category: "freeTier",
  noAuth: true,

  transport: {
    // The router has no upstream; the request log shows this label.
    baseUrl: "webcookie-agent",
    format: "openai",
    noAuth: true,
    headers: {
      "Content-Type": "application/json",
    },
  },

  // One seed model that is always available; the executor round-robins the
  // underlying web-cookie providers regardless of which id is requested.
  // Pinned targets ("webcookie-agent/<provider>/<model>") override the route.
  models: [
    { id: "any", name: "Auto (round-robin web-cookie providers)" },
  ],

  // No live catalogue of its own — the underlying providers have their own.
  modelsFetcher: null,

  features: {
    usage: false,
  },
};
