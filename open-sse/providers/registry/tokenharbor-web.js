/**
 * Token Harbor Web — the chat application at tokenharbor.ai, driven by the
 * Supabase session cookie a signed-in browser already holds.
 *
 * ## Read this before building on it
 *
 * Token Harbor's terms **prohibit** what this adapter does. Their product is
 * itself a gateway, and the metered API key is its architectural guardrail;
 * driving the web chat with a harvested session cookie routes around that
 * guardrail. The two clauses that name it:
 *
 * > **Proxy Reselling:** Utilize the Service to construct a direct,
 * > white-labeled proxy alternative to Token Harbor without adding substantive
 * > unique value or without prior written enterprise authorization.
 * >
 * > ...designed to compromise the security, stability, or **architectural
 * > guardrails of the Token Harbor gateway**.
 *
 * There is a legitimate path — `https://tokenharbor.ai/v1` with a Bearer key,
 * OpenAI-compatible, and free on the `:free` models — and it is the card
 * beside this one (`tokenharbor`). This entry exists because the operator
 * asked for the session-cookie route with that trade stated, and the notice on
 * the card says the same thing to the user before they paste a credential.
 *
 * ## What the credential is
 *
 * Auth is Supabase (`auth.tokenharbor.ai`), so the browser cookie is
 * `sb-<ref>-auth-token`, where `<ref>` is the first label of the Supabase host
 * — `auth`, giving `sb-auth-auth-token`. Above Supabase's size limit the value
 * is split into `sb-...-auth-token.0`, `.1`, ... and the chunks are
 * reassembled in order. It is written with `document.cookie`, so unlike
 * ChatGPT Web's `HttpOnly` session it can be read from the Application panel
 * or the Network tab's Cookie header — which is why the guide offers both.
 *
 * ## The wire format is not OpenAI's, and that is the whole adapter
 *
 * A turn is two requests and a decode:
 *
 * 1. `POST /api/direct-chat/sessions` with `{ model, temporary: true }` →
 *    `{ session: { id } }`. `temporary` is sent so a stateless gateway does
 *    not litter the user's sidebar with a conversation per request.
 * 2. `POST /api/direct-chat/stream` with
 *    `{ sessionId, content, model, webSearch, tz }` → an SSE body whose events
 *    are **named**, not OpenAI's `choices[].delta`: `chunk` (the answer text in
 *    `delta`), `thinking` (reasoning in `delta`), `tool_use`, `citation`,
 *    `image`, `file`, `miniapp`, and `done`. `error` carries
 *    `{ code, message }`.
 *
 * Only `chunk`, `thinking`, `done` and `error` are consumed. The others are
 * attachments and citations for a UI, and inventing an OpenAI shape for them
 * would be guessing at a contract this adapter cannot test without the
 * session.
 */

export default {
  id: "tokenharbor-web",
  priority: 220,
  alias: "tokenharbor-web",
  aliases: [
    "thw",
  ],
  uiAlias: "thw",
  display: {
    name: "Token Harbor Web",
    // The vendor's own mark is `public/providers/tokenharbor.svg`; the icon is
    // what a card without an image falls back to.
    icon: "anchor",
    // Taken from their own stylesheet (the same value the API-key card uses).
    color: "#3859ff",
    textIcon: "TH",
    website: "https://tokenharbor.ai/chat",
    notice: {
      text: "Reached with a signed-in browser session, not an API key. Token Harbor's terms prohibit proxying their gateway, and their metered API (tokenharbor.ai/v1) is the supported route — the \":free\" models do not bill. Use at your own risk.",
      apiKeyUrl: "https://tokenharbor.ai/dashboard",
    },
  },
  // The new "Web Cookie Sessions" group: a credential a signed-in browser
  // holds, rather than a key the dashboard issues.
  category: "webCookieSession",
  authType: "cookie",
  authHint: "Paste the Cookie header (or the sb-auth-auth-token value) from tokenharbor.ai",
  transport: {
    /**
     * The three endpoints a turn needs, in one place.
     *
     * `baseUrl` is the turn's own endpoint — the one a request is POSTed to.
     * The other two are named beside it so no other file has to spell a URL:
     * the session is created on one, the credential is checked on the other.
     */
    baseUrl: "https://tokenharbor.ai/api/direct-chat/stream",
    format: "tokenharbor-web",
    authType: "cookie",
    origin: "https://tokenharbor.ai",
    profileUrl: "https://tokenharbor.ai/api/me/profile",
    sessionsUrl: "https://tokenharbor.ai/api/direct-chat/sessions",
    streamUrl: "https://tokenharbor.ai/api/direct-chat/stream",
  },
  /**
   * The catalog, read from `https://tokenharbor.ai/models` on 2026-10-07.
   *
   * A dated snapshot rather than a promise: the page is the live list and this
   * is what it showed. Prices are per 1M tokens, which is the unit the SDK
   * normalises to and the unit the page itself prints. The `:free` ids are the
   * ones that bill nothing.
   *
   * No context window is claimed because the page publishes none.
   */
  models: [
    { id: "th-rudder:free", name: "TH-Rudder (Free)" },
    { id: "claude-fable-5.1", name: "Claude Fable 5.1" },
    { id: "claude-opus-5.5", name: "Claude Opus 5.5" },
    { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5" },
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
    { id: "deepseek-v4.1-flash:free", name: "DeepSeek V4.1 Flash (Free)" },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
    { id: "glm-5.3", name: "GLM-5.3" },
    { id: "glm-5.3-flash", name: "GLM 5.3 Flash" },
    { id: "gpt-6-astra", name: "GPT-6 Astra" },
    { id: "gpt-6-luna", name: "GPT-6 Luna" },
    { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
    { id: "grok-4.7", name: "Grok 4.7" },
    { id: "kimi-k3", name: "Kimi K3" },
    { id: "mimo-v2.6-flash", name: "MiMo V2.6 Flash" },
    { id: "mimo-v2.6-flash:free", name: "MiMo V2.6 Flash (Free)" },
    { id: "mimo-v2.6-pro", name: "MiMo V2.6 Pro" },
    { id: "mistral-large-2512", name: "Mistral Large 2512" },
    { id: "muse-spark-1-3", name: "Muse Spark 1.3" },
    { id: "qwen3.8-27b", name: "Qwen3.8 27B" },
    { id: "qwen3.8-flash", name: "Qwen3.8 Flash" },
    { id: "qwen3.8-max", name: "Qwen3.8 Max" },
  ],
};
