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
        label: 'Fast path',
        body: `Install the Cookie Editor extension (chromewebstore.google.com → Cookie Editor), open it on the signed-in chatgpt.com tab, find ${CHATGPT_WEB_SESSION_COOKIE} — select every numbered chunk if it is split — and choose Export → Copy with the export format set to "Cookie header".`,
      },
      {
        label: 'Manual path',
        body: 'Open the browser developer tools (F12 → Network), reload, click any authenticated request, and copy the Cookie header value from Request Headers. Omit the `Cookie:` prefix.',
      },
    ],
    signIn: {
      note: 'Opens chatgpt.com in a window on the machine running OmniHilbras. Sign in with your own password and second factor, and the session is read straight out of that browser — including the Cloudflare clearance that a copied cookie tends to lose.',
      start: '/v1/oauth/chatgpt/start',
      status: (sessionId, freeOnly) =>
        `/v1/oauth/chatgpt/status?sessionId=${encodeURIComponent(sessionId)}&freeOnly=${freeOnly ? 'true' : 'false'}`,
    },
    paste: {
      path: '/v1/web-cookie/chatgpt/connect',
      field: 'storageState',
      placeholder: `${CHATGPT_WEB_SESSION_COOKIE}=…; oai-did=…`,
      supportsFreeOnly: true,
    },
    check: { path: '/v1/web-cookie/chatgpt/check', field: 'storageState' },
    planNote: 'Only chatgpt.com and openai.com cookies are kept. Anything else in the export is dropped before it is stored.',
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
        label: 'Fast path',
        body: 'Sign in, then open the browser developer tools (F12 → Application → Local Storage → https://chat.deepseek.com) and copy the value of `userToken`. It is sometimes stored as {"value":"…"} — either form is accepted.',
      },
      {
        label: 'Or let OmniHilbras read it',
        body: 'Use the sign-in button above. A window opens, you sign in, and the token is read out of that browser — including any wrapper, so there is nothing to unwrap by hand.',
      },
    ],
    signIn: {
      note: 'Opens chat.deepseek.com in a window on the machine running OmniHilbras. Sign in with your own account, and the userToken is read out of that browser’s local storage — so there is no cookie header to copy and no value to unwrap by hand.',
      start: '/v1/oauth/deepseek/start',
      status: (sessionId) => `/v1/oauth/deepseek/status?sessionId=${encodeURIComponent(sessionId)}`,
    },
    paste: {
      path: '/v1/web-cookie/deepseek/connect',
      field: 'userToken',
      placeholder: 'userToken value, or {"value":"…"}',
    },
    planNote: 'DeepSeek Web serves the same 14 models to every account, so there is no plan to read and nothing is narrowed.',
  },
};

export function webSessionDescriptor(providerId: string): WebSessionDescriptor | undefined {
  return WEB_SESSION_PROVIDERS[providerId];
}

/** The provider ids that connect by signing in rather than by pasting an API key. */
export function webSessionProviderIds(): string[] {
  return Object.keys(WEB_SESSION_PROVIDERS);
}
