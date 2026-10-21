export default {
  id: "gemini-web",
  priority: 220,
  alias: "gemini-web",
  aliases: [
    "gweb",
  ],
  uiAlias: "gweb",
  display: {
    name: "Gemini Web",
    icon: "auto_awesome",
    color: "#4285F4",
    textIcon: "GEM",
    website: "https://gemini.google.com",
    notice: {
      // The old card's risk notice, kept because it is the part the user has to
      // weigh: the credential is not scoped to inference, and the page is
      // driven rather than called.
      text: "This is a live session for your whole Google account — not a token limited to inference — and Google's terms do not permit automating gemini.google.com. OmniHilbras loads the page in a real browser and lets it solve its own challenges. If you have a Gemini API key, the Gemini card beside this one is the supported path.",
    },
  },
  category: "webCookieSession",
  authType: "cookie",
  authHint: "Paste your __Secure-1PSID (and __Secure-1PSIDTS) cookie values from gemini.google.com",
  transport: {
    // The page, not an endpoint: Google publishes no endpoint that accepts a
    // browser session, so the "upstream" here is the app itself, driven in a
    // browser. The executor opens this URL and reads the answer out of the
    // response the page makes for itself.
    baseUrl: "https://gemini.google.com/app",
    format: "gemini-web",
    authType: "cookie",
  },
  // The modes the page offers. The ids are **not** Google API model ids, and
  // the selectors that choose a mode live in
  // `open-sse/shared/webSession/gemini-web.js` — that module is server-side (it
  // imports node builtins), so the ids and names are repeated here rather than
  // imported, and the two lists must be kept in step.
  models: [
    { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
    { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash" },
    { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash-Lite" },
  ],
};
