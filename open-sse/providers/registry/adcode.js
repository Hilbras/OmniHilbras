// ADCode "Included AI" (tagflow) — the ADCode desktop client's own model
// relay (reverse-engineered wire, verified live 2026-10):
// https://adcode.bluethenics.com/v1/ai/tagflow, OpenAI-compatible
// (chat/completions + public /config + auth /usage, Bearer id_token).
//
// Auth is the machine's ADCode account, exactly like ZCode Start Plan: the
// desktop client signs in to a Firebase identity backend and keeps
// { uid, refreshToken } in a per-user store file; the executor mints the
// live id_token from that refresh token (no dashboard key needed). An
// id_token pasted as a connection key overrides the local store, so several
// accounts can rotate like any other provider. Upstream is native OpenAI —
// standard SSE and native tool_calls, no bridge.
//
// /config is public and is the desktop app's live model catalogue, so the
// dashboard fetches it without a key; the seed below is what /config lists
// today and is what the engine routes by default.
export default {
  id: "adcode",
  priority: 122,
  alias: "adcode",
  aliases: ["ad"],
  uiAlias: "dc",
  display: {
    name: "ADCode Included AI",
    icon: "code",
    color: "#0EA5E9",
    textIcon: "AC",
    website: "https://adcode.bluethenics.com",
    notice: {
      text: "The ADCode desktop client's Included AI (Tagflow Code 27B, Qwen3.8, GLM 5.3 Flash Uncensored, Xiaomi MiMo V2.6 Flash) — no key needed, signs in through the ADCode desktop client on this machine (install and sign in once). Or paste an ADCode id_token as the key to add more accounts.",
    },
  },
  category: "freeTier",
  noAuth: true,

  transport: {
    baseUrl: "https://adcode.bluethenics.com/v1/ai/tagflow/chat/completions",
    format: "openai",
    noAuth: true,
    // Full client surface (Bearer id_token + x-adcode-* headers) is built in
    // the executor — the token comes from the desktop identity store, not
    // connection credentials.
    headers: {
      "Content-Type": "application/json",
    },
    validateUrl: "https://adcode.bluethenics.com/v1/ai/tagflow/config",
    usage: {
      url: "https://adcode.bluethenics.com/v1/ai/tagflow/usage",
    },
  },

  models: [
    { id: "tagflow-code-27b", name: "Tagflow Code 27B" },
    { id: "heabsy-qwen38", name: "Qwen3.8 27B" },
    { id: "heabsy-glm53-flash-unc", name: "GLM 5.3 Flash Uncensored" },
    { id: "heabsy-mimo-v26-flash", name: "Xiaomi MiMo V2.6 Flash" },
  ],

  // Live catalogue (public, no key needed): the desktop app's own /config
  // endpoint, filtered by the adcode-config filter.
  modelsFetcher: { url: "https://adcode.bluethenics.com/v1/ai/tagflow/config", type: "adcode-config" },

  features: {
    usage: true,
  },
};
