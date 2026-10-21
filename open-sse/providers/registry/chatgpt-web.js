export default {
  id: "chatgpt-web",
  priority: 220,
  alias: "chatgpt-web",
  aliases: [
    "cgw",
  ],
  uiAlias: "cgw",
  display: {
    name: "ChatGPT Web",
    icon: "forum",
    color: "#10a37f",
    textIcon: "CGW",
    website: "https://chatgpt.com",
    /**
     * Not a preference, and not the ordinary sort of credential warning.
     *
     * There is no ChatGPT API that accepts a browser session, so reaching a
     * model this way means loading chatgpt.com in a real browser and letting
     * its own page solve the anti-automation challenges. The credential is a
     * live session for a whole OpenAI account rather than a token scoped to
     * inference, and OpenAI's terms do not permit this. Both facts are on the
     * card because both are the user's to weigh.
     */
    notice: {
      text: "OpenAI's terms do not permit automating chatgpt.com, and the credential here is a live session for your whole account — not a token limited to inference. OmniHilbras opens chatgpt.com in a browser and lets its page solve the anti-bot challenges. Only continue if that is a trade you have decided to make.",
    },
  },
  category: "webCookieSession",
  authType: "cookie",
  authHint: "Paste the Cookie request header from chatgpt.com (F12 → Network → a request to chatgpt.com → Headers → Request Headers → Cookie)",
  transport: {
    // The page is the endpoint: the turn is sent from inside chatgpt.com, so
    // the origin is all there is to name.
    baseUrl: "https://chatgpt.com",
    format: "chatgpt-web",
    authType: "cookie",
  },
  models: [
    { id: "gpt-5.6-luna-free", name: "GPT-5.6 Luna (Free)" },
    { id: "gpt-5.6-luna-free-thinking", name: "GPT-5.6 Luna (Free, Think)" },
    { id: "gpt-5.6-sol-instant", name: "GPT-5.6 Sol (Instant)" },
    { id: "gpt-5.6-sol-medium", name: "GPT-5.6 Sol (Medium)" },
    { id: "gpt-5.6-sol-high", name: "GPT-5.6 Sol (High)" },
    { id: "gpt-5.6-sol-xhigh", name: "GPT-5.6 Sol (XHigh)" },
    { id: "gpt-5.6-sol-pro", name: "GPT-5.6 Sol (Pro)" },
    { id: "gpt-5.5-instant", name: "GPT-5.5 (Instant)" },
    { id: "gpt-5.5-medium", name: "GPT-5.5 (Medium)" },
    { id: "gpt-5.5-high", name: "GPT-5.5 (High)" },
    { id: "gpt-5.5-xhigh", name: "GPT-5.5 (XHigh)" },
    { id: "gpt-5.5-pro", name: "GPT-5.5 (Pro)" },
    { id: "gpt-5.5-pro-extended", name: "GPT-5.5 (Pro Extended)" },
  ],
};
