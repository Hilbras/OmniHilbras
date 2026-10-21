// Web-session providers — the "Web Cookie Sessions" group.
//
// What each provider needs in order to be connected.
//
// Held here rather than inside the modal so the modal is a modal and not a
// ChatGPT modal with the names swapped. A provider added later is one entry,
// not a branch.
//
// Everything a user reads — the cookie name, the extraction routes, the
// warning about the credential — comes from the provider itself, so an
// instruction can never drift from what the gateway will accept. That is not
// hypothetical: the ChatGPT guide once told people to paste a Cookie header
// that the parser refused.
//
// Ported from the previous project's webSessionProviders.ts.

export const WEB_SESSION_PROVIDERS = {
  "chatgpt-web": {
    id: "chatgpt-web",
    name: "ChatGPT Web",
    website: "https://chatgpt.com",
    credentialName: "__Secure-next-auth.session-token",
    /**
     * Both routes end at the Cookie request header, because that is the one
     * string guaranteed to be complete. Asking for the session cookie alone
     * is what a first reading suggests, and it is not enough — the export is
     * only useful with the cookies chatgpt.com mints alongside it.
     */
    extractionSteps: [
      {
        label: "Copy the header",
        /**
         * The Network tab, not the Console — and that is not a preference.
         *
         * NextAuth sets the session cookie `HttpOnly`, so `document.cookie`
         * **cannot** read it. It fails in a way that looks like the user is
         * signed out, which sends them off to sign in again when they are
         * already signed in. Only the raw request header and the Application
         * panel can see an HttpOnly cookie.
         */
        body: "With chatgpt.com open and signed in: F12 → Network → reload → click any request to chatgpt.com → Headers → Request Headers → Cookie. Copy that entire line and paste it here. Do not use the Console — the session cookie is HttpOnly, so no console command can read it.",
      },
      {
        label: "Or the Application panel",
        body: "F12 → Application → Storage → Cookies → https://chatgpt.com. Copy the whole value of `__Secure-next-auth.session-token`. If it is split into numbered rows, join them in order with no separator.",
      },
    ],
    paste: {
      field: "storageState",
      placeholder: "__Secure-next-auth.session-token=…; oai-did=…",
      supportsFreeOnly: true,
      sectionLabel: "Or paste a session cookie instead",
      fieldLabel: "Session cookie",
    },
    planNote: "Only chatgpt.com and openai.com cookies are kept. Anything else in the export is dropped before it is stored.",
  },

  "qwen-web": {
    id: "qwen-web",
    name: "Qwen Web",
    website: "https://chat.qwen.ai",
    credentialName: "Cookie header from auth.qwen.ai",
    /**
     * Qwen's auth is on a **different origin** from its chat app —
     * `auth.qwen.ai`. A guest gets 401 from `auth.qwen.ai/api/v2/auths/`
     * and holds no auth cookie on any host, while
     * `chat.qwen.ai/api/v2/models/` answers fine. So the credential has to
     * come from the auth origin.
     */
    extractionSteps: [
      {
        label: "Copy the auth cookie",
        body: "Sign in at chat.qwen.ai. Then: F12 → Application → Storage → Cookies → **https://auth.qwen.ai**, and copy the cookies for that host. If you would rather use the Network tab, reload, click a request to auth.qwen.ai, and copy its **Request Headers → Cookie** value.",
      },
      {
        label: "What happens next",
        body: "OmniHilbras asks three questions and shows you the answers: whether the credential means anything to auth.qwen.ai, what models Qwen serves, and whether a turn is actually served. Qwen refuses bot-protected requests with **HTTP 200 and a refusal in the body**, so the probe reads the body rather than the status code — nothing is saved either way until a turn really works.",
      },
    ],
    paste: {
      field: "cookieHeader",
      placeholder: "name=value; name2=value2",
      sectionLabel: "Or paste a cookie header instead",
      fieldLabel: "Cookie header",
    },
    planNote: "Qwen serves its models to guests, so the catalog is real even when a turn is not. The card says which of the two you are looking at.",
  },

  "deepseek-web": {
    id: "deepseek-web",
    name: "DeepSeek Web",
    website: "https://chat.deepseek.com",
    credentialName: "userToken",
    /**
     * No cookie and no chunks: DeepSeek keeps the session in localStorage,
     * so the route is "copy this one value" rather than "copy a header".
     */
    extractionSteps: [
      {
        label: "Fastest",
        body: "With chat.deepseek.com signed in, open the developer tools (F12) → Console, paste this line and press Enter. It copies the userToken.",
        snippet: "copy(JSON.parse(localStorage.userToken).value)",
      },
      {
        label: "If the copied value is empty",
        body: "`{\"value\":null}` means the page has no session, so you are signed out. Sign in at chat.deepseek.com first, then copy it again.",
      },
    ],
    paste: {
      field: "userToken",
      placeholder: "userToken value, or {\"value\":\"…\"}",
      sectionLabel: "Or paste a userToken instead",
      fieldLabel: "userToken",
    },
    planNote: "DeepSeek Web serves the same models to every account, so there is no plan to read and nothing is narrowed.",
  },

  "tokenharbor-web": {
    id: "tokenharbor-web",
    name: "Token Harbor Web",
    website: "https://tokenharbor.ai/chat",
    credentialName: "sb-auth-auth-token",
    /**
     * The cookie is a Supabase session, so unlike ChatGPT Web's `HttpOnly`
     * token it can be read from the Application panel as well as the
     * Network tab.
     */
    extractionSteps: [
      {
        label: "Copy the Cookie header",
        body: "With tokenharbor.ai open and signed in: F12 → Network → reload → click any request to tokenharbor.ai → Headers → Request Headers → Cookie. Copy that entire line and paste it here. It carries the Cloudflare clearance alongside the session, and both are wanted.",
      },
      {
        label: "Or the Application panel",
        body: "F12 → Application → Storage → Cookies → https://tokenharbor.ai, and copy the value of `sb-auth-auth-token`. If it is split into numbered rows (`.0`, `.1`), copy them all — they are rejoined in order for you.",
      },
      {
        label: "Or the console",
        body: "With tokenharbor.ai open and signed in, open F12 → Console, paste this line and press Enter. It copies the session cookies (the chunks in order, plus cf_clearance) to your clipboard. This only works when the cookie is not HttpOnly; if nothing is copied, use one of the steps above.",
        snippet: "copy(document.cookie.split('; ').filter((c) => c.startsWith('sb-auth-auth-token') || c.startsWith('cf_clearance')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join('; '))",
      },
      {
        label: "What happens next",
        body: "Check asks tokenharbor.ai whether the session is accepted, by reading your profile. Nothing is stored unless you press Save, and the check is a credential check — whether a model can answer is only known by sending a turn.",
      },
    ],
    paste: {
      field: "cookieHeader",
      placeholder: "sb-auth-auth-token=base64-...; cf_clearance=...",
      supportsFreeOnly: true,
      sectionLabel: "Or paste a session cookie instead",
      fieldLabel: "Cookie header or session cookie",
    },
    planNote: "Token Harbor serves its catalog to every account; the \":free\" models are the ones that never bill.",
  },

  "gemini-web": {
    id: "gemini-web",
    name: "Gemini Web",
    website: "https://gemini.google.com",
    credentialName: "__Secure-1PSID",
    /**
     * No console one-liner, and this is the ChatGPT Web lesson applied
     * rather than repeated: `__Secure-1PSID` is `HttpOnly`, so
     * `document.cookie` **cannot** read it.
     */
    extractionSteps: [
      {
        label: "The two cookies",
        body: "With gemini.google.com open and signed in: F12 → Application → Storage → Cookies → **https://gemini.google.com**. Copy the values of `__Secure-1PSID` and `__Secure-1PSIDTS` and paste them here as `__Secure-1PSID=...; __Secure-1PSIDTS=...`. Do not use the Console — `__Secure-1PSID` is HttpOnly, so no console command can read it.",
      },
      {
        label: "Or the request header",
        body: "F12 → Network → reload → click any request to gemini.google.com → Headers → Request Headers → Cookie. Copy that entire line.",
      },
      {
        label: "What happens next",
        body: "Check opens gemini.google.com in a browser on this machine and reports whether the session is signed in — cookie presence and expiry are local checks and neither can tell a working session from one Google has revoked. Nothing is stored unless you press Save. A turn is sent by driving the page: it is slower than an API and there is a browser in the path by design.",
      },
    ],
    paste: {
      field: "cookieHeader",
      placeholder: "__Secure-1PSID=...; __Secure-1PSIDTS=...",
      sectionLabel: "Or paste the cookies instead",
      fieldLabel: "Cookie header, or the __Secure-1PSID value",
    },
    planNote: "Gemini Web drives the page, so the model list is the modes the page offers (3.1 Pro, 3.7 Flash, 3.1 Flash-Lite), not Google's API model ids.",
  },

  "duckduckgo-web": {
    id: "duckduckgo-web",
    name: "Duck.ai",
    website: "https://duck.ai",
    /**
     * There is no credential to name, which is the whole point of this entry.
     *
     * Duck.ai serves a signed-out visitor a free model lineup behind an
     * anti-bot challenge rather than a session. A cookie is accepted if one is
     * pasted — it travels with the request — but nothing about a turn depends
     * on it.
     */
    credentialName: "Nothing — no cookie is required",
    extractionSteps: [
      {
        label: "Nothing to export",
        body: "Duck.ai answers signed-out visitors, so there is no cookie to copy. You can press Check and then Save with the field below empty, and the connection will work.",
      },
      {
        label: "If you would rather send your browser session",
        body: "With duck.ai open: F12 → Network → reload → click any request to duck.ai → Headers → Request Headers → Cookie. Copy that entire line and paste it here. OmniHilbras does not read it — the service does not either — so it cannot tell you whether the cookie is valid, and Check will say so rather than claiming otherwise.",
      },
      {
        label: "What happens next",
        body: "Check asks duck.ai for its anti-bot challenge and solves it here, then reports the free models it offers. What it proves is that the endpoint answered and served a solvable challenge — not that a turn will always succeed. A refusal carrying HTTP 418 is a rate limit rather than a broken key: the same request was measured failing 43 seconds after a success and working 4.9 minutes later, so back off rather than retrying.",
      },
    ],
    optionalCredential: true,
    paste: {
      field: "cookieHeader",
      placeholder: "Leave empty — or paste the whole Cookie: line from duck.ai",
      sectionLabel: "Or paste a cookie you would rather send along",
      fieldLabel: "Cookie header",
    },
    planNote: "Only the free lineup is served without a subscription. The list is read from each model's own `accessTier` and changes with duck.ai, so it is reported at connect time rather than written on the card.",
  },
};

/** The provider ids that connect by signing in rather than by pasting an API key. */
export function webSessionProviderIds() {
  return Object.keys(WEB_SESSION_PROVIDERS);
}

export function webSessionDescriptor(providerId) {
  return WEB_SESSION_PROVIDERS[providerId];
}
