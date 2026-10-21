/**
 * Duck.ai (duck.ai) — a "Web Cookie Sessions" provider.
 *
 * ## The credential is optional, and that is the whole point
 *
 * The service is anonymous. `/duckchat/v1/models` answers 200 with no credential at all, and a turn works
 * without one — measured twice from this host before any of it was written. So a pasted cookie is hardening
 * against the per-address rate limit rather than a requirement, and the card says so. Two things follow that
 * the code has to get right: an absent credential must be accepted everywhere a cookie is, and a pasted cookie
 * must never be *claimed* to be verified, because this service does not read it.
 *
 * ## The model list is the free lineup, and the ids are the service's own
 *
 * The ids below are what the live catalog serves, read from each model's own `accessTier` (the field that
 * decides what is free — the nested `reasoningEffortAccess[].accessTier` describes which effort levels an
 * account tier may pick and drops half the lineup when it is read instead). The lineup rotates, so the list is
 * re-read at connect time and reported there; what is registered here is the lineup measured on 2026-10-17,
 * with `gpt-5.4-mini` first because it is the one free id that has been free on every reading.
 *
 * ## The endpoints are here rather than in the executor
 *
 * A turn is three requests, not one: the homepage (for the request version), the status endpoint (for the
 * anti-bot challenge) and the chat endpoint. All three are declared below so the executor and the dashboard's
 * credential check speak to the same places.
 */
export default {
  id: "duckduckgo-web",
  priority: 220,
  alias: "duckduckgo-web",
  aliases: [
    "ddg",
  ],
  uiAlias: "ddg",
  display: {
    name: "Duck.ai",
    icon: "search",
    color: "#DE5833",
    textIcon: "DDG",
    website: "https://duck.ai",
  },
  category: "webCookieSession",
  authType: "cookie",
  authHint:
    "No cookie is required — Duck.ai answers signed-out visitors. Paste the whole Cookie: line from duck.ai if you would rather send one along.",
  transport: {
    baseUrl: "https://duck.ai/duckchat/v1/chat",
    homeUrl: "https://duck.ai/",
    statusUrl: "https://duck.ai/duckchat/v1/status",
    modelsUrl: "https://duck.ai/duckchat/v1/models",
    format: "duckduckgo-web",
    authType: "cookie",
  },
  models: [
    { id: "gpt-5.4-mini", name: "GPT-5.4 Mini (free tier)" },
    { id: "gpt-6-luna", name: "GPT-6 Luna (free tier)" },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5 (free tier)" },
    { id: "mistral-small-2603", name: "Mistral Small (free tier)" },
    { id: "tinfoil/gpt-oss-120b", name: "gpt-oss 120B (free tier)" },
    { id: "tinfoil/gemma4-31b", name: "Gemma 4 31B (free tier)" },
  ],
};
