import { CHATGPT_WEB_SESSION_COOKIE } from '@hilbras/omnihilbras';
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
    credentialName: 'Cookie header from auth.qwen.ai',
    /**
     * Qwen's auth is on a **different origin** from its chat app — `auth.qwen.ai`. That is
     * measured, not guessed: a guest gets `401 Unauthorized` from `auth.qwen.ai/api/v2/auths/`
     * and holds no auth cookie on any host, while `chat.qwen.ai/api/v2/models/` answers fine.
     * So the credential has to come from the auth origin.
     *
     * Deliberately **no console one-liner**, and that is the lesson from ChatGPT Web: the session
     * cookie is almost certainly HttpOnly, and `document.cookie` cannot read one. A snippet that
     * cannot work is worse than a slightly longer set of clicks, because it fails in a way that
     * looks like being signed out.
     */
    extractionSteps: [
      {
        label: 'Copy the auth cookie',
        body: 'Sign in at chat.qwen.ai. Then: F12 → Application → Storage → Cookies → **https://auth.qwen.ai**, and copy the cookies for that host. If you would rather use the Network tab, reload, click a request to auth.qwen.ai, and copy its **Request Headers → Cookie** value.',
      },
      {
        label: 'What happens next',
        body: 'OmniHilbras asks three questions and shows you the answers: whether the credential means anything to auth.qwen.ai, what models Qwen serves, and whether a turn is actually served. Qwen refuses bot-protected requests with **HTTP 200 and a refusal in the body**, so the probe reads the body rather than the status code — nothing is saved either way until a turn really works.',
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
        snippet: "copy(document.cookie.split('; ').filter((c) => c.startsWith('sb-auth-auth-token') || c.startsWith('cf_clearance')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join('; '))",
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
};

export function webSessionDescriptor(providerId: string): WebSessionDescriptor | undefined {
  return WEB_SESSION_PROVIDERS[providerId];
}

/** The provider ids that connect by signing in rather than by pasting an API key. */
export function webSessionProviderIds(): string[] {
  return Object.keys(WEB_SESSION_PROVIDERS);
}
