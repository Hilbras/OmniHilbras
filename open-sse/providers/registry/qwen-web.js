export default {
  id: "qwen-web",
  priority: 220,
  alias: "qwen-web",
  aliases: [
    "qw",
  ],
  uiAlias: "qw",
  display: {
    name: "Qwen Web",
    icon: "psychology",
    color: "#615ced",
    textIcon: "QW",
    website: "https://chat.qwen.ai",
    /**
     * The two things a user cannot see from the card.
     *
     * One: this is a whole-account session, not a key scoped to inference — anyone
     * holding the cookie can act as the account at chat.qwen.ai until it expires.
     *
     * Two: Qwen refuses a bot-protected request with **HTTP 200** and a refusal in
     * the body, so "the request succeeded" and "the answer was no" are the same
     * wire event. The executor reads the body rather than the status.
     */
    notice: {
      text: "This is your Qwen account session, not an API key — anyone holding it can act as you at chat.qwen.ai until it expires or you revoke it. Qwen also refuses bot-protected requests with HTTP 200 and a refusal in the body, so the first turn can be refused even with a good cookie; the provider's own words are shown rather than a verdict.",
    },
  },
  category: "webCookieSession",
  authType: "cookie",
  authHint: "Paste the Cookie header from auth.qwen.ai — Qwen's auth is on a different origin from its chat app",
  transport: {
    /**
     * A plain, unminified `POST /api/v2/chat/completions` on the chat origin.
     *
     * The auth origin is a different host (`auth.qwen.ai`) and is only touched by the
     * probe in shared/webSession/qwen-web.js; a turn goes to the chat origin.
     */
    baseUrl: "https://chat.qwen.ai/api/v2/chat/completions",
    format: "qwen-web",
    authType: "cookie",
  },
  /**
   * A dated snapshot of the guest catalog, not a promise.
   *
   * Read from `GET /api/v2/models/`, which answers guests, so the ids are what the
   * service actually serves. The list **moves**: repeated requests from one place
   * returned three while the same endpoint returned seven to someone minutes later,
   * with the same cookies and none. The connect dialog always shows the live list,
   * so this is only the offline fallback. No context window is claimed because Qwen
   * publishes none on that endpoint.
   */
  models: [
    { id: "qwen3.7-plus", name: "Qwen3.7 Plus" },
    { id: "qwen3.8-max", name: "Qwen3.8 Max" },
    { id: "qwen3.8-omni-flash", name: "Qwen3.8 Omni Flash" },
  ],
};
