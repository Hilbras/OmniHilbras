import { CHATGPT_WEB_SESSION_COOKIE } from '@omnihilbras/kernel-api/public';
import type { WebSessionDescriptor } from '../components/WebCookieConnectDialog';

/**
 * What each web-session provider needs in order to be connected.
 *
 * Held here rather than inside the dialog so the dialog is a dialog and not a ChatGPT dialog
 * with the names swapped. A provider added later is one entry, not a branch.
 *
 * Everything a user reads — the cookie name, the extraction routes, the warning about the
 * credential — comes from the provider itself, so an instruction can never drift from what
 * the gateway will accept. That is not hypothetical: the ChatGPT guide once told people to
 * paste a Cookie header that the parser refused.
 */
export const WEB_SESSION_PROVIDERS: Record<string, WebSessionDescriptor> = {
  'chatgpt-web': {
    id: 'chatgpt-web',
    name: 'ChatGPT Web',
    website: 'https://chatgpt.com',
    credentialName: CHATGPT_WEB_SESSION_COOKIE,
    /**
     * Both routes end at the Cookie request header, because that is the one string guaranteed
     * to be complete. Asking for the session cookie alone is what a first reading of the
     * requirement suggests, and it is not enough — the export is only useful with the cookies
     * chatgpt.com mints alongside it.
     */
    extractionSteps: [
      {
        label: 'Copy the header',
        /**
         * The Network tab, not the Console — and that is not a preference.
         *
         * NextAuth sets the session cookie `HttpOnly`, so `document.cookie` **cannot** read it.
         * I once put `copy(document.cookie)` here as the "fastest" path; it cannot work, for
         * anyone, ever. It fails in a way that looks like the user is signed out, which sends
         * them off to sign in again when they are already signed in. Only the raw request header
         * and the Application panel can see an HttpOnly cookie.
         *
         * The whole `Cookie:` line is wanted, not just the session cookie: a token over the size
         * limit is split into numbered chunks, and a header copied without its siblings is a
         * broken session that fails later as an unexplained refusal.
         */
        body: 'With chatgpt.com open and signed in: F12 → Network → reload → click any request to chatgpt.com → Headers → Request Headers → Cookie. Copy that entire line and paste it here. Do not use the Console — the session cookie is HttpOnly, so no console command can read it.',
      },
      {
        label: 'Or the Application panel',
        body: `F12 → Application → Storage → Cookies → https://chatgpt.com. Copy the whole value of \`${CHATGPT_WEB_SESSION_COOKIE}\`. If it is split into numbered rows, join them in order with no separator.`,
      },
    ],
    paste: {
      path: '/v1/web-cookie/chatgpt/connect',
      field: 'storageState',
      placeholder: `${CHATGPT_WEB_SESSION_COOKIE}=…; oai-did=…`,
      supportsFreeOnly: true,
      sectionLabel: 'Or paste a session cookie instead',
      fieldLabel: 'Session cookie',
    },
    check: { path: '/v1/web-cookie/chatgpt/check', field: 'storageState' },
    planNote: 'Only chatgpt.com and openai.com cookies are kept. Anything else in the export is dropped before it is stored.',
  },

  'qwen-web': {
    id: 'qwen-web',
    name: 'Qwen Web',
    website: 'https://chat.qwen.ai',
    credentialName: 'Session token from chat.qwen.ai',
    /**
     * Measured from a signed-in session, and it corrects this file.
     *
     * The instructions used to say "copy the cookies for **auth.qwen.ai**". A real signed-in profile
     * holds exactly **two** cookies on that host — `aliyungf_tc` and `acw_tc` — and both are Alibaba
     * anti-bot cookies that every visitor gets. There is no session cookie on the auth origin at all.
     * The session is a **bearer token in `chat.qwen.ai`'s local storage** (`token`, with
     * `at_expire_time` and `qwen_access_token_state` beside it), and the cookies on the chat origin
     * (`alicfw`, `x-ap`, `qwen-locale`, `qwen-theme`) carry no account either.
     *
     * And the token does not fix it: replayed with the session's own live cookies, both a cookie-only
     * request and one carrying `Authorization: Bearer <token>` are refused with
     * `FAIL_SYS_USER_VALIDATE, RGV587_ERROR` — because every request needs a fresh `bx-ua`, a signature
     * Alibaba's baxia SDK mints per request for that URL and body. A captured one is refused too; that
     * was tested with a value seconds old from the same session. See `docs/reports/qwen-web-capture.md`.
     *
     * So the extraction steps below say what a person can actually do, and the probe is what decides.
     * There is no connect route for this provider on purpose: a credential that cannot serve a turn is
     * not worth storing.
     */
    extractionSteps: [
      {
        label: 'What the session actually is',
        body: 'Qwen signs you in with a token in **chat.qwen.ai** local storage — DevTools → Application → Local Storage → chat.qwen.ai, the `token` entry — not with a cookie. Deliberately shown as a path rather than as a console one-liner: a snippet in this file that names a credential key is what `tests/browser-storage.test.js` exists to stop, and it would be right to stop it. Nothing here reads that value; this text only says where Qwen keeps it.',
      },
      {
        label: 'Why there is no button that connects it',
        body: 'Every Qwen request needs a **fresh per-request signature** (`bx-ua`, from Alibaba baxia). A real one, taken seconds earlier from this very session, is refused when replayed — HTTP 200 with `FAIL_SYS_USER_VALIDATE, RGV587_ERROR` in the body. Nothing OmniHilbras can store would serve a turn, so nothing is stored.',
      },
      {
        label: 'What the check below does',
        body: 'It reports the three answers rather than a verdict: whether the credential means anything to Qwen, which models Qwen serves, and whether a turn is actually served.',
      },
    ],
    check: { path: '/v1/web-cookie/qwen/check', field: 'cookieHeader' },
    planNote: 'Qwen serves its models to guests, so the catalog is real even when a turn is not. The card says which of the two you are looking at.',
  },
  'deepseek-web': {
    id: 'deepseek-web',
    name: 'DeepSeek Web',
    website: 'https://chat.deepseek.com',
    credentialName: 'userToken',
    /**
     * No cookie and no chunks: DeepSeek keeps the session in localStorage, so the route is
     * "copy this one value" rather than "copy a header". Saying so is the whole guide.
     */
    extractionSteps: [
      {
        label: 'Fastest',
        body: 'With chat.deepseek.com signed in, open the developer tools (F12) → Console, paste this line and press Enter. It copies the userToken.',
        snippet: 'copy(JSON.parse(localStorage.userToken).value)',
      },
      {
        label: 'If the copied value is empty',
        // Not a stale reference to the sign-in window, which was removed in v1.10.0 — this used
        // to tell people to use a button that no longer exists.
        body: '`{"value":null}` means the page has no session, so you are signed out. Sign in at chat.deepseek.com first, then copy it again.',
      },
    ],
    paste: {
      path: '/v1/web-cookie/deepseek/connect',
      field: 'userToken',
      placeholder: 'userToken value, or {"value":"…"}',
      sectionLabel: 'Or paste a userToken instead',
      fieldLabel: 'userToken',
    },
    planNote: 'DeepSeek Web serves the same 14 models to every account, so there is no plan to read and nothing is narrowed.',
  },
  'deepseek-web-v2': {
    id: 'deepseek-web-v2',
    name: 'DeepSeek Web V2',
    website: 'https://chat.deepseek.com',
    credentialName: 'userToken',
    /**
     * The primary path is the desktop app's sign-in window: OmniHilbras opens `chat.deepseek.com`, the
     * operator signs in there normally — password, hCaptcha, emailed code, all theirs — and the session
     * that window holds goes straight to the gateway from the main process. Reading another origin's
     * storage is impossible in a browser dashboard, so the paste path stays as the honest fallback
     * rather than a button that cannot work.
     */
    signIn: {
      provider: 'deepseek-web-v2',
      label: 'Sign in with DeepSeek',
      browserUnavailable: 'A browser dashboard cannot read another site\u2019s storage. Open the desktop app to sign in, or paste the token below.',
    },
    extractionSteps: [
      {
        label: 'Fastest',
        body: 'With chat.deepseek.com signed in, open the developer tools (F12) \u2192 Console, paste this line and press Enter. It copies the userToken.',
        snippet: 'copy(JSON.parse(localStorage.userToken).value)',
      },
      {
        label: 'If the copied value is empty',
        body: '`{"value":null}` means the page has no session, so you are signed out. Sign in at chat.deepseek.com first, then copy it again.',
      },
    ],
    paste: {
      path: '/v1/web-cookie/deepseek-web-v2/connect',
      field: 'userToken',
      placeholder: 'userToken value, or {"value":"..."}',
      sectionLabel: 'Or paste a userToken instead',
      fieldLabel: 'userToken',
    },
    planNote: 'DeepSeek serves the same models to every account, so there is no plan to read and nothing is narrowed.',
  },
  'tokenharbor-web': {
    id: 'tokenharbor-web',
    name: 'Token Harbor Web',
    website: 'https://tokenharbor.ai/chat',
    credentialName: 'sb-auth-auth-token',
    /**
     * The cookie is a Supabase session, so unlike ChatGPT Web's `HttpOnly` token it can be read
     * from the Application panel as well as the Network tab — a distinction that decides whether a
     * console one-liner is possible (it is not needed here, and is not offered).
     */
    extractionSteps: [
      {
        label: 'Copy the Cookie header',
        body: 'With tokenharbor.ai open and signed in: F12 → Network → reload → click any request to tokenharbor.ai → Headers → Request Headers → Cookie. Copy that entire line and paste it here. It carries the Cloudflare clearance alongside the session, and both are wanted.',
      },
      {
        label: 'Or the Application panel',
        body: `F12 → Application → Storage → Cookies → https://tokenharbor.ai, and copy the value of \`${'sb-auth-auth-token'}\`. If it is split into numbered rows (\`.0\`, \`.1\`), copy them all — they are rejoined in order for you.`,
      },
      {
        label: 'Or the console',
        body: 'With tokenharbor.ai open and signed in, open F12 → Console, paste this line and press Enter. It copies the session cookies (the chunks in order, plus cf_clearance) to your clipboard. This only works when the cookie is not HttpOnly; if nothing is copied, use one of the steps above.',
        snippet: "(function(){const v=document.cookie.split('; ').filter((c) => c.startsWith('sb-auth-auth-token') || c.startsWith('cf_clearance')).sort((a,b)=>{const an=a.split('=')[0],bn=b.split('=')[0];const ai=an==='sb-auth-auth-token'?0:an.startsWith('sb-auth-auth-token.')?Number(an.slice('sb-auth-auth-token'.length+1))+1:NaN;const bi=bn==='sb-auth-auth-token'?0:bn.startsWith('sb-auth-auth-token.')?Number(bn.slice('sb-auth-auth-token'.length+1))+1:NaN;if(!Number.isFinite(ai)||!Number.isFinite(bi))return an.localeCompare(bn);return ai-bi;}).join('; ');try{copy(v)}catch(e){}console.log(v);prompt('Copy this session cookie:',v);return v;})()",
      },
      {
        label: 'What happens next',
        body: 'Check asks tokenharbor.ai whether the session is accepted, by reading your profile. Nothing is stored unless you press Save, and the check is a credential check — whether a model can answer is only known by sending a turn.',
      },
    ],
    paste: {
      path: '/v1/web-cookie/tokenharbor/connect',
      field: 'cookieHeader',
      placeholder: 'sb-auth-auth-token=base64-...; cf_clearance=...',
      supportsFreeOnly: true,
      sectionLabel: 'Or paste a session cookie instead',
      fieldLabel: 'Cookie header or session cookie',
    },
    check: { path: '/v1/web-cookie/tokenharbor/check', field: 'cookieHeader' },
    planNote: 'Token Harbor serves its catalog to every account; the ":free" models are the ones that never bill.',
  },

  'gemini-web': {
    id: 'gemini-web',
    name: 'Gemini Web',
    website: 'https://gemini.google.com',
    credentialName: '__Secure-1PSID',
    /**
     * No console one-liner, and this is the ChatGPT Web lesson applied rather than repeated.
     *
     * `__Secure-1PSID` is set `HttpOnly`, so `document.cookie` **cannot** read it — a snippet would fail for
     * everyone, in a way that looks like being signed out. Only the request header and the Application panel can
     * see it, so the steps send people there.
     */
    extractionSteps: [
      {
        label: 'The two cookies',
        body: 'With gemini.google.com open and signed in: F12 → Application → Storage → Cookies → **https://gemini.google.com**. Copy the values of `__Secure-1PSID` and `__Secure-1PSIDTS` and paste them here as `__Secure-1PSID=...; __Secure-1PSIDTS=...`. Do not use the Console — `__Secure-1PSID` is HttpOnly, so no console command can read it.',
      },
      {
        label: 'Or the request header',
        body: 'F12 → Network → reload → click any request to gemini.google.com → Headers → Request Headers → Cookie. Copy that entire line.',
      },
      {
        label: 'What happens next',
        body: 'Check opens gemini.google.com in a browser on this machine and reports whether the session is signed in — cookie presence and expiry are local checks and neither can tell a working session from one Google has revoked. Nothing is stored unless you press Save. A turn is sent by driving the page: it is slower than an API and there is a browser in the path by design.',
      },
    ],
    paste: {
      path: '/v1/web-cookie/gemini/connect',
      field: 'cookieHeader',
      placeholder: '__Secure-1PSID=...; __Secure-1PSIDTS=...',
      sectionLabel: 'Or paste the cookies instead',
      fieldLabel: 'Cookie header, or the __Secure-1PSID value',
    },
    check: { path: '/v1/web-cookie/gemini/check', field: 'cookieHeader' },
    planNote: 'Gemini Web drives the page, so the model list is the modes the page offers (3.1 Pro, 3.7 Flash, 3.1 Flash-Lite), not Google’s API model ids.',
  },

  'duckduckgo-web': {
    id: 'duckduckgo-web',
    name: 'Duck.ai',
    website: 'https://duck.ai',
    /**
     * There is no credential to name, which is the whole point of this entry.
     *
     * Duck.ai serves a signed-out visitor a free model lineup behind an anti-bot challenge rather than a
     * session. A cookie is accepted if one is pasted — it travels with the request — but nothing about a
     * turn depends on it, and the gateway stores the honest `{ type: 'none' }` when the field is left empty.
     * The steps below say so rather than sending someone to DevTools for a secret this provider never needed.
     */
    credentialName: 'Nothing — no cookie is required',
    extractionSteps: [
      {
        label: 'Nothing to export',
        body: 'Duck.ai answers signed-out visitors, so there is no cookie to copy. You can press Check and then Save with the field below empty, and the connection will work.',
      },
      {
        label: 'If you would rather send your browser session',
        body: 'With duck.ai open: F12 → Network → reload → click any request to duck.ai → Headers → Request Headers → Cookie. Copy that entire line and paste it here. OmniHilbras does not read it — the service does not either — so it cannot tell you whether the cookie is valid, and Check will say so rather than claiming otherwise.',
      },
      {
        label: 'What happens next',
        body: 'Check asks duck.ai for its anti-bot challenge and solves it here, then reports the free models it offers. What it proves is that the endpoint answered and served a solvable challenge — not that a turn will always succeed. A refusal carrying HTTP 418 is a rate limit rather than a broken key: the same request was measured failing 43 seconds after a success and working 4.9 minutes later, so back off rather than retrying.',
      },
    ],
    optionalCredential: true,
    paste: {
      path: '/v1/web-cookie/duckduckgo/connect',
      field: 'cookieHeader',
      placeholder: 'Leave empty — or paste the whole Cookie: line from duck.ai',
      sectionLabel: 'Or paste a cookie you would rather send along',
      fieldLabel: 'Cookie header',
    },
    check: { path: '/v1/web-cookie/duckduckgo/check', field: 'cookieHeader' },
    planNote: 'Only the free lineup is served without a subscription. The list is read from each model\'s own `accessTier` and changes with duck.ai, so it is reported at connect time rather than written on the card.',
  },

  'grok-web': {
    id: 'grok-web',
    name: 'Grok Web',
    website: 'https://grok.com',
    credentialName: 'sso',
    /**
     * `sso` is a session cookie, and the request that proves it is the same
     * conversation endpoint a turn uses. The guide therefore points at the
     * Application panel and the request header, not a console one-liner: a
     * console command cannot read an HttpOnly cookie and would look like being
     * signed out.
     */
    extractionSteps: [
      {
        label: 'The sso cookie',
        body: 'With grok.com open and signed in: F12 → Application → Storage → Cookies → https://grok.com. Copy the value of `sso`. If it is not readable there, use the Network tab: F12 → Network → reload → click a request to grok.com → Headers → Request Headers → Cookie, and copy that whole line.',
      },
      {
        label: 'What happens next',
        body: 'Check sends a small turn to the same web conversation endpoint with the browser-fingerprint headers the page sends. A 401 or 403 means the subscription session is dead; a 400 or 429 means the cookie was accepted and the tiny probe body or the rate limit refused the turn. Nothing is stored until you press Save.',
      },
    ],
    paste: {
      path: '/v1/web-cookie/grok/connect',
      field: 'cookieHeader',
      placeholder: 'sso=… or the whole Cookie header',
      sectionLabel: 'Or paste the sso cookie instead',
      fieldLabel: 'sso cookie',
    },
    check: { path: '/v1/web-cookie/grok/check', field: 'cookieHeader' },
    planNote: 'The subscription decides which modes are available. The card lists the twelve web modes; the page’s picker is the authority when a mode is withdrawn.',
  },

  'perplexity-web': {
    id: 'perplexity-web',
    name: 'Perplexity Web',
    website: 'https://www.perplexity.ai',
    credentialName: '__Secure-next-auth.session-token',
    extractionSteps: [
      {
        label: 'The session cookie',
        body: 'With perplexity.ai open and signed in: F12 → Application → Storage → Cookies → https://www.perplexity.ai. Copy the value of `__Secure-next-auth.session-token`. Or use F12 → Network → reload → a request to perplexity.ai → Headers → Request Headers → Cookie and copy the whole line.',
      },
      {
        label: 'What happens next',
        body: 'Check sends a minimal ask request and stores nothing. A 401 or 403 is a dead session; a 400 or 429 means the cookie was accepted and the probe body or the rate limit was refused. Save stores the session only after the check accepts it. The seven pplx modes are the old registry’s catalog; the page’s own picker remains the authority.',
      },
    ],
    paste: {
      path: '/v1/web-cookie/perplexity/connect',
      field: 'cookieHeader',
      placeholder: '__Secure-next-auth.session-token=…; other=…',
      sectionLabel: 'Or paste the session cookie instead',
      fieldLabel: 'Perplexity session cookie',
    },
    check: { path: '/v1/web-cookie/perplexity/check', field: 'cookieHeader' },
    planNote: 'The free `pplx-auto` mode is the default. Pro/Max modes depend on the subscription; the seven ids are the old registry’s catalog, not a promise that every account can select all of them.',
  },
};

export function webSessionDescriptor(providerId: string): WebSessionDescriptor | undefined {
  return WEB_SESSION_PROVIDERS[providerId];
}

/** The provider ids that connect by signing in rather than by pasting an API key. */
export function webSessionProviderIds(): string[] {
  return Object.keys(WEB_SESSION_PROVIDERS);
}
