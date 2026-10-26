// ZCode Start Plan — free-tier GLM access through the locally signed-in ZCode
// desktop client (reverse-engineered wire, verified live against ZCode 3.14.4).
//
// Auth is the machine's own ZCode credential store (~/.zcode/v2/credentials.json,
// AES-256-GCM with a home+username-derived key) — no dashboard key needed.
// A Start Plan JWT pasted as a connection key overrides the local store, so
// several connections can rotate accounts like any other provider.
// Upstream is Anthropic Messages-shaped but REQUIRES the stock ZCode request
// template (system + tool catalog from config/zcodeRequestTemplate.json);
// replacing the system prompt is rejected upstream with code 3012.
export default {
  id: "zcode",
  priority: 40,
  alias: "zcode",
  // "zc" must be a real routing alias, not just a UI badge: the engine's
  // ALIAS_TO_PROVIDER_ID map (open-sse/services/model.js) resolves provider
  // prefixes from id/alias/aliases only — uiAlias never routes. Without this,
  // "zc/glm-5.3" resolved to a nonexistent provider and fell to the
  // DefaultExecutor with no transport.
  aliases: ["zc"],
  uiAlias: "zc",
  display: {
    name: "ZCode Start Plan",
    icon: "terminal",
    color: "#2563EB",
    textIcon: "ZC",
    website: "https://zcode.z.ai",
    notice: {
      text: "Free-tier GLM via ZCode Start Plan. Auth options: (1) paste a Start Plan JWT directly into the connection key, (2) set ZCODE_START_PLAN_TOKEN env var, or (3) install and sign into the ZCode desktop client once (the app does NOT need to be running).",
    },
  },
  category: "freeTier",
  noAuth: true,

  transport: {
    baseUrl: "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages",
    format: "claude",
    noAuth: true,
    // Full client fingerprint headers (x-api-key + Bearer, x-zcode-* ids) are
    // built in the executor — the token comes from the local store, not
    // connection credentials.
    headers: {
      "Content-Type": "application/json",
    },
    usage: {
      url: "https://zcode.z.ai/api/v1/zcode-plan/billing/balance",
    },
  },

  models: [
    { id: "glm-5.3-flash", name: "GLM 5.3 Flash" },
    { id: "glm-5.3", name: "GLM 5.3" },
  ],

  // Fixed two-model catalog: the gateway has no models endpoint (404s on
  // …/anthropic/v1/models), so opt out of fetcher auto-derivation and always
  // show the seed models.
  modelsFetcher: null,

  thinkingConfig: {
    options: ["low", "high", "max"],
    defaultMode: "max",
  },

  features: {
    usage: true,
  },
};
