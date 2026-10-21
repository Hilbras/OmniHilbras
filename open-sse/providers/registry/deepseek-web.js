/**
 * DeepSeek Web — the chat.deepseek.com session, reached with a `userToken`.
 *
 * **No cookie and no browser in the request path.** DeepSeek keeps its session
 * in localStorage, so the credential is one value rather than a header, and the
 * turn itself is a plain HTTP call with a bearer token. A browser is only
 * involved in *getting* the token, and the user does that by copying one line
 * out of the console.
 *
 * The endpoint is the web client's own completion API, which is not
 * OpenAI-shaped: it takes one flat `prompt` instead of a message array, and
 * every call to it is gated by a proof of work. Both live in the executor.
 */
export default {
  id: "deepseek-web",
  priority: 220,
  alias: "deepseek-web",
  aliases: [
    "dsw",
  ],
  uiAlias: "dsw",
  display: {
    name: "DeepSeek Web",
    icon: "bolt",
    color: "#4D6BFE",
    textIcon: "DSW",
    website: "https://chat.deepseek.com",
  },
  category: "webCookieSession",
  authType: "cookie",
  authHint: "Paste the userToken from chat.deepseek.com (console: copy(JSON.parse(localStorage.userToken).value))",
  transport: {
    baseUrl: "https://chat.deepseek.com/api/v0/chat/completion",
    format: "deepseek-web",
    authType: "cookie",
  },
  /**
   * The models chat.deepseek.com serves.
   *
   * Two axes, and both are in the id rather than in a separate parameter:
   * `think` and `search` are model variants the page offers, not request
   * options. A Pro model is `model_type: "expert"`; everything else is
   * `"default"`. The executor holds the same list with those three flags
   * spelled out, because the endpoint needs them and the id is not a place to
   * parse them out of.
   */
  models: [
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "deepseek-v4-pro-think", name: "DeepSeek V4 Pro Think" },
    { id: "deepseek-v4-pro-search", name: "DeepSeek V4 Pro Search" },
    { id: "deepseek-v4-pro-think-search", name: "DeepSeek V4 Pro Think+Search" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "deepseek-v4-flash-think", name: "DeepSeek V4 Flash Think" },
    { id: "deepseek-v4-flash-search", name: "DeepSeek V4 Flash Search" },
    { id: "deepseek-v4-flash-think-search", name: "DeepSeek V4 Flash Think+Search" },
    { id: "deepseek-chat", name: "DeepSeek Chat" },
    { id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
    { id: "DeepSeek-R1", name: "DeepSeek R1" },
    { id: "DeepSeek-R1-Search", name: "DeepSeek R1 Search" },
    { id: "DeepSeek-V3.2", name: "DeepSeek V3.2" },
    { id: "DeepSeek-Search", name: "DeepSeek Search" },
  ],
};
