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
        label: 'Or let OmniHilbras read it',
        body: 'Use the sign-in button above. A window opens, you sign in, and the token is read out of that browser — including any wrapper, so there is nothing to unwrap by hand.',
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
};

export function webSessionDescriptor(providerId: string): WebSessionDescriptor | undefined {
  return WEB_SESSION_PROVIDERS[providerId];
}

/** The provider ids that connect by signing in rather than by pasting an API key. */
export function webSessionProviderIds(): string[] {
  return Object.keys(WEB_SESSION_PROVIDERS);
}
