import { ProviderError } from '../errors.js';
import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  CredentialValidation,
  MessageContent,
  Model,
  ProviderAdapter,
  ProviderCredential,
  ProviderRequestContext,
  TokenUsage,
} from '../types.js';

/**
 * ChatGPT Web.
 *
 * This is not an API integration and it is not an OAuth flow. There is no OpenAI endpoint
 * that accepts a browser session, so the only way to reach a model this way is to load
 * chatgpt.com in a real browser, let ChatGPT's own page solve its anti-automation
 * challenges, type the prompt into the composer, and read the answer back out of the DOM.
 *
 * The credential is therefore not a token scoped to inference — it is a **live session for
 * the whole OpenAI account**. A Kiro token can answer a chat; a `__Secure-next-auth
 * session-token` can do everything the person who exported it can. That is a property of
 * what the credential is, and it is why the card carries a warning.
 *
 * The browser lives in the gateway, not here. This module owns the parts that can be
 * reasoned about and tested without one: what a storage state is, what a cookie header
 * looks like, and how an answer is read out of a DOM snapshot.
 */

/**
 * The one cookie a session is read from.
 *
 * Named in a single place because the connect dialog tells the user to copy exactly this
 * cookie by name, and a second copy of the string is a second chance for the instruction and
 * the parser to disagree — which shows up as a dialog that says to copy something the parser
 * will not accept.
 */
export const CHATGPT_WEB_SESSION_COOKIE = '__Secure-next-auth.session-token';

export const CHATGPT_WEB = {
  /** The only origin this will talk to. */
  origin: 'https://chatgpt.com',
  /**
   * The signed-in landing page.
   *
   * `?temporary-chat=true` would keep a gateway's traffic out of the account's visible
   * history, which is the right idea, but it is also what triggers the first-use
   * onboarding modal — which holds focus and intercepts the request — and it failed to
   * navigate at all on the address this was tested from. A turn sent through the first-party
   * request path creates its own conversation regardless, so the URL is not what keeps
   * history clean.
   */
  startUrl: 'https://chatgpt.com/',
  /** Playwright needs a writable profile directory; this is where the browser state goes. */
  defaultTurnTimeoutMs: 180_000,
  navigationTimeoutMs: 30_000,
  /**
   * The composer and the answer.
   *
   * These are ChatGPT's own test hooks rather than styling hooks, which is why they are
   * used in preference to class names. They are still a private contract with a product
   * that ships changes daily: when ChatGPT renames one, this breaks. That is a real limit
   * of driving a web app rather than its API, and it is stated instead of hidden behind a
   * retry loop that would only fail more slowly.
   */
  composer: '#prompt-textarea',
  sendButton: 'button[data-testid="send-button"]',
  assistantMessage: '[data-message-author-role="assistant"]',
  /** The stop button replaces send while a turn is running. */
  stopButton: 'button[data-testid="stop-button"]',
  /** A sign-in wall. Its presence means the exported session is no longer valid. */
  signedOutMarker: 'a[href="/auth/login"]',
  /**
   * The first-use "Temporary Chat" modal. It holds focus and intercepts the click on
   * Send, so it is dismissed rather than clicked through — a real browser remembers it
   * being dismissed, and this one persists its profile so it does too.
   */
  onboardingModal: '[data-testid="modal-temporary-chat-onboarding"]',
} as const;

/* ------------------------------------------------------------------ *
 * The exported session
 * ------------------------------------------------------------------ */

export type ChatGptCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
};

/** The shape Playwright writes from `storageState()`. */
export type ChatGptStorageState = {
  cookies?: ChatGptCookie[];
  origins?: unknown[];
};

/**
 * A storage state that has been validated. `cookies` is required here because a parsed
 * state is either usable or was rejected — there is no accepted-but-empty case.
 */
export type ParsedChatGptStorageState = {
  cookies: ChatGptCookie[];
  origins: unknown[];
  /**
   * The plan the export was issued for, when it says so.
   *
   * This is real entitlement rather than a guess, and it decides which models the account
   * is offered. It is recorded rather than inferred from a model list that would be wrong
   * for half the accounts.
   */
  planType?: string;
  /** When the session itself expires, so a dead one is known before a browser opens. */
  expiresAt?: string;
};

/**
 * The Codex / ChatGPT CLI auth export.
 *
 * This is the format people actually have: a JSON object with `sessionToken` holding the
 * `__Secure-next-auth.session-token` cookie value, plus a JWT `accessToken` and an account
 * block. It is **not** a Playwright storage state — there is no `cookies` key in it at all,
 * and a parser written only for the storage-state shape rejects it outright.
 */
export type ChatGptAuthExport = {
  sessionToken?: string;
  accessToken?: string;
  expires?: string;
  authProvider?: string;
  account?: { planType?: string; structure?: string };
  'https://api.openai.com/auth'?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads a Playwright storage state and keeps only what is genuinely part of it.
 *
 * The export is a user-pasted blob, so it is validated rather than trusted: only
 * `cookies` with a non-empty name and value survive, and only from chatgpt.com or
 * openai.com. A pasted blob carrying cookies for other sites is not silently forwarded to
 * ChatGPT, and a malformed one is refused with a reason rather than half-applied.
 */
/**
 * The cookies worth keeping out of a pasted `Cookie` header.
 *
 * A header carries every cookie the site set, and only some of them are the session. An
 * allowlist rather than a denylist, because a header the user pasted from their own browser
 * is still user-supplied input, and the job here is to send ChatGPT its own cookies and
 * nothing else.
 *
 * The Cloudflare pair matters: the edge sets its own clearance cookie on the first response,
 * and a session sent without it can be challenged even though the token is valid.
 */
const COOKIE_HEADER_ALLOWLIST: ReadonlySet<string> = new Set([
  CHATGPT_WEB_SESSION_COOKIE,
  '__Secure-next-auth.csrf-token',
  'oai-did',
  'cf_clearance',
  '__cf_bm',
  '_cfuvid',
]);

/**
 * Reads a pasted `Cookie` request header.
 *
 * Two things it has to get right, both from the same source: the session token is often
 * **split into numbered chunks** by the browser, so `name.0` and `name.1` are one value and
 * not two; and the `Cookie:` prefix is usually included even though the guide says to omit
 * it, because people copy the whole header line.
 */
function fromCookieHeader(raw: string): ParsedChatGptStorageState {
  const body = raw.replace(/^cookie\s*:\s*/i, '');
  const pairs = body
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  if (pairs.length === 0 || !pairs.some((pair) => pair.includes('='))) {
    throw new ProviderError('INVALID_REQUEST', 'Paste the Cookie header value, or a storage-state JSON — not the request line.', {
      providerId: chatGptWebProviderId,
      publicMessage: 'Paste the Cookie header value, or a storage-state JSON — not the request line.',
    });
  }

  const values = new Map<string, string>();
  // Sparse on purpose: a gap is a gap, and `undefined` is how it shows up.
  const chunked = new Map<string, Array<string | undefined>>();
  /**
   * Whether *any* NextAuth cookie was present, including ones the allowlist drops.
   *
   * Tracked from the raw names rather than from `values`, because the cookie that identifies
   * a signed-in browser — `__Secure-next-auth.callback-url` — is deliberately not forwarded, so
   * by the time the check below runs there is no trace of it. Without this, a header copied from
   * the Console of a signed-in browser is indistinguishable from one copied while signed out,
   * and the message tells a signed-in user to sign in.
   */
  let sawNextAuthCookie = false;
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (!value) continue;
    if (name.startsWith('__Secure-next-auth.')) sawNextAuthCookie = true;
    // A chunked session token: `…session-token.0`, `…session-token.1`, and so on.
    const chunk = name.match(/^(.*)\.(\d+)$/);
    const family = chunk?.[1];
    if (family !== undefined && COOKIE_HEADER_ALLOWLIST.has(family)) {
      const parts = chunked.get(family) ?? [];
      parts[Number(chunk?.[2])] = value;
      chunked.set(family, parts);
      continue;
    }
    if (COOKIE_HEADER_ALLOWLIST.has(name)) values.set(name, value);
  }
  /**
   * Reassembled in index order, and only when the set is whole.
   *
   * A partial token is not a shorter session, it is a broken one, and sending it reads as a
   * refusal. A gap is obviously incomplete; a lone `.0` is the harder case, because it looks
   * complete on its own — but a browser only splits a token that is over its size limit, so a
   * single chunk means the header was cut short, and that is worth naming rather than
   * sending.
   */
  for (const [family, parts] of chunked) {
    // `every` skips holes in a sparse array, so a missing middle chunk would pass the check
    // and the reassembled token would silently lose it. `includes` does not skip holes, which
    // is what makes it the right test for "is this set whole".
    const complete = parts.length > 1 && !parts.includes(undefined) && parts.every((part) => Boolean(part));
    if (!complete) {
      const message =
        parts.length <= 1
          ? `That ${CHATGPT_WEB_SESSION_COOKIE} looks cut short — it has one numbered chunk where a whole token has several. Copy the Cookie header again, from a request that is already authenticated.`
          : `That ${CHATGPT_WEB_SESSION_COOKIE} is missing chunk ${parts.findIndex((part) => !part)}. Copy the Cookie header again.`;
      throw new ProviderError('AUTHENTICATION_FAILED', message, {
        providerId: chatGptWebProviderId,
        publicMessage: message,
      });
    }
    values.set(family, parts.join(''));
  }

  if (!values.has(CHATGPT_WEB_SESSION_COOKIE)) {
    /**
     * Two different mistakes produce this same header, and they need opposite fixes.
     *
     * NextAuth sets the session cookie `HttpOnly`, so `document.cookie` **cannot** read it —
     * a console one-liner can never return a credential, however it is written. Meanwhile
     * `__Secure-next-auth.callback-url` is not HttpOnly, so a signed-in browser still leaks
     * *some* of the family through `document.cookie`. That is the discriminator: seeing a
     * sibling cookie means you are signed in and copied from the wrong place, while seeing none
     * of the family means you are not signed in at all.
     *
     * Telling those apart matters because the first is a dead end for the obvious move — you
     * cannot fix it by trying the console again.
     */
    const hasNextAuthSibling = sawNextAuthCookie;
    const message = hasNextAuthSibling
      ? `That header has chatgpt cookies but no ${CHATGPT_WEB_SESSION_COOKIE}, because the session cookie is HttpOnly and a console command cannot read it. Copy the Cookie header from the Network tab instead: F12 → Network → reload → click a request to chatgpt.com → Headers → Request Headers → Cookie, and copy that whole line.`
      : `That header has no ${CHATGPT_WEB_SESSION_COOKIE} in it, and no other signed-in cookie either, so this browser is not signed in to chatgpt.com. Sign in first, then copy the Cookie header from the Network tab: F12 → Network → reload → click a request to chatgpt.com → Headers → Request Headers → Cookie.`;
    throw new ProviderError('AUTHENTICATION_FAILED', message, {
      providerId: chatGptWebProviderId,
      publicMessage: message,
    });
  }

  const cookies: ChatGptCookie[] = [...values].map(([name, value]) => ({
    name,
    value,
    domain: '.chatgpt.com',
    path: '/',
    // A header carries no expiry, and inventing one would expire a live session.
    expires: -1,
  }));
  return { cookies, origins: [] };
}

export function parseChatGptStorageState(raw: string): ParsedChatGptStorageState {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ProviderError('INVALID_REQUEST', 'Paste the storage-state JSON exported from your browser.', {
      providerId: chatGptWebProviderId,
      publicMessage: 'Paste the storage-state JSON exported from your browser.',
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // The cookie header is the other thing people actually paste, and the connect dialog
    // tells them to. This used to refuse one while its own message said to paste one
    // instead, so the instruction and the parser disagreed and the only way to find out
    // which was wrong was to paste a real session and be turned away.
    return fromCookieHeader(trimmed);
  }
  /**
   * A bare array of cookie objects is accepted as well as a full storage state, because
   * that is what a cookie-editor extension exports and it is the format people actually
   * have in hand. Anything else is refused with what to paste instead.
   */
  /**
   * The CLI/Codex auth export is checked before anything else, because it is the shape
   * people paste most often and it shares no keys with a storage state.
   */
  // The key's presence, not its value, identifies the format: an export with an empty
  // sessionToken is a broken export, and saying "no cookies array" about it is nonsense.
  if (isRecord(parsed) && 'sessionToken' in parsed) {
    return fromAuthExport(parsed);
  }

  const isBareCookieArray = Array.isArray(parsed);
  if (!isBareCookieArray && !isRecord(parsed)) {
    throw new ProviderError('INVALID_REQUEST', 'A storage state is a JSON object, or an array of cookie objects.', {
      providerId: chatGptWebProviderId,
      publicMessage: 'A storage state is a JSON object, or an array of cookie objects.',
    });
  }
  const rawCookies = isBareCookieArray ? parsed : isRecord(parsed) ? parsed.cookies : undefined;
  if (!Array.isArray(rawCookies)) {
    throw new ProviderError('INVALID_REQUEST', 'That JSON has no `cookies` array, so it is not a storage state.', {
      providerId: chatGptWebProviderId,
      publicMessage: 'That JSON has no `cookies` array, so it is not a storage state.',
    });
  }
  const cookies: ChatGptCookie[] = [];
  for (const entry of rawCookies) {
    if (!isRecord(entry)) continue;
    const name = typeof entry.name === 'string' ? entry.name : '';
    const value = typeof entry.value === 'string' ? entry.value : '';
    if (!name || !value) continue;
    const domain = typeof entry.domain === 'string' ? entry.domain : undefined;
    // Only OpenAI's own cookies are carried across. Anything else in the export is not
    // this connection's to send.
    if (domain && !isOpenAiDomain(domain)) continue;
    cookies.push({
      name,
      value,
      ...(domain ? { domain } : {}),
      ...(typeof entry.path === 'string' ? { path: entry.path } : {}),
      ...(typeof entry.expires === 'number' ? { expires: entry.expires } : {}),
    });
  }
  if (cookies.length === 0) {
    throw new ProviderError('INVALID_REQUEST', 'That storage state has no usable chatgpt.com cookies in it.', {
      providerId: chatGptWebProviderId,
      publicMessage: 'That storage state has no usable chatgpt.com cookies in it. Export it while signed in to chatgpt.com.',
    });
  }
  const origins = !isBareCookieArray && isRecord(parsed) && Array.isArray(parsed.origins) ? parsed.origins : [];
  return { cookies, origins };
}

/**
 * Turns the CLI auth export into cookies.
 *
 * `sessionToken` *is* the session cookie's value, so it becomes
 * `__Secure-next-auth.session-token` on `.chatgpt.com` — which is the one cookie the page
 * checks. The account block and the `expires` field are carried through, because both are
 * worth more than the cookie alone: one says what the account may use, the other says when
 * this stops working.
 */
function fromAuthExport(source: Record<string, unknown>): ParsedChatGptStorageState {
  const sessionToken = typeof source.sessionToken === 'string' ? source.sessionToken : '';
  if (!sessionToken) {
    throw new ProviderError('INVALID_REQUEST', 'That export has no sessionToken in it.', {
      providerId: chatGptWebProviderId,
      publicMessage: 'That export has no sessionToken in it.',
    });
  }
  const account = isRecord(source.account) ? source.account : undefined;
  const planType = typeof account?.planType === 'string' ? account.planType : undefined;
  const expires = typeof source.expires === 'string' && !Number.isNaN(Date.parse(source.expires)) ? source.expires : undefined;
  return {
    cookies: [
      {
        name: CHATGPT_WEB_SESSION_COOKIE,
        value: sessionToken,
        domain: '.chatgpt.com',
        path: '/',
        // `-1` is a session cookie, so it is never treated as expired by the header builder.
        expires: -1,
      },
    ],
    origins: [],
    ...(planType ? { planType } : {}),
    ...(expires ? { expiresAt: expires } : {}),
  };
}

function isOpenAiDomain(domain: string): boolean {
  const host = domain.replace(/^\./, '').toLowerCase();
  return host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'openai.com' || host.endsWith('.openai.com');
}

/**
 * The `Cookie` header for the session cookies.
 *
 * Expired cookies are dropped: sending one makes the browser's own session look stale,
 * and a stale `__Secure-next-auth.session-token` fails in a way that looks like a bad
 * password rather than an old export.
 */
export function chatGptCookieHeader(cookies: readonly ChatGptCookie[], now = Date.now()): string {
  const live = cookies.filter((cookie) => !cookie.expires || cookie.expires === -1 || cookie.expires * 1000 > now);
  return live.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

/** Accepts a plain `name=value; name=value` header as well as a storage state. */
export function parseChatGptCookieHeader(raw: string): ChatGptCookie[] {
  const trimmed = raw.trim().replace(/^cookie:\s*/i, '');
  if (!trimmed) return [];
  const cookies: ChatGptCookie[] = [];
  for (const pair of trimmed.split(';')) {
    const entry = pair.trim();
    const index = entry.indexOf('=');
    if (index <= 0) continue;
    const name = entry.slice(0, index).trim();
    const value = entry.slice(index + 1).trim();
    if (name && value) cookies.push({ name, value, domain: '.chatgpt.com' });
  }
  return cookies;
}

/** The credential: the session cookies, held as one opaque blob. */
export function chatGptWebCredential(state: ParsedChatGptStorageState): ProviderCredential {
  return {
    type: 'api-key',
    // The whole state, not just the cookies: the expiry and the plan are what make a dead
    // session and a plan-gated model distinguishable from a broken connection.
    value: JSON.stringify({
      cookies: state.cookies,
      ...(state.planType ? { planType: state.planType } : {}),
      ...(state.expiresAt ? { expiresAt: state.expiresAt } : {}),
    }),
  };
}

export function chatGptWebSessionFromCredential(credential: ProviderCredential | undefined): ParsedChatGptStorageState {
  if (credential?.type !== 'api-key' || !credential.value) {
    throw new ProviderError('AUTHENTICATION_FAILED', 'No ChatGPT Web session is stored. Export one and connect.', {
      providerId: chatGptWebProviderId,
      publicMessage: 'No ChatGPT Web session is stored. Export one and connect.',
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(credential.value);
  } catch {
    throw new ProviderError('AUTHENTICATION_FAILED', 'The stored ChatGPT Web session is unreadable. Export one and connect again.', {
      providerId: chatGptWebProviderId,
      publicMessage: 'The stored ChatGPT Web session is unreadable. Export one and connect again.',
    });
  }
  if (Array.isArray(parsed)) return { cookies: parsed as ChatGptCookie[], origins: [] };
  if (!isRecord(parsed) || !Array.isArray(parsed.cookies)) return { cookies: [], origins: [] };
  const cookies = parsed.cookies as ChatGptCookie[];
  return {
    cookies,
    origins: [],
    ...(typeof parsed.planType === 'string' ? { planType: parsed.planType } : {}),
    ...(typeof parsed.expiresAt === 'string' ? { expiresAt: parsed.expiresAt } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Reading an answer out of a page
 * ------------------------------------------------------------------ */

/**
 * The last assistant turn's text from a set of rendered messages.
 *
 * The *last* one is taken deliberately: ChatGPT streams into the final node and keeps
 * earlier turns on the page, so the first assistant element is the answer to whatever was
 * asked several messages ago.
 */
export function lastAssistantText(messages: readonly string[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const text = (messages[index] ?? '').trim();
    if (text) return text;
  }
  return '';
}

/** Reads assistant turns out of a DOM snapshot, newest last. */
export function assistantTextsFromSnapshot(snapshot: { texts: readonly string[] }): string[] {
  return snapshot.texts.filter((text) => text.trim().length > 0);
}

/**
 * True when the page is showing a sign-in wall rather than a conversation.
 *
 * This is the failure that matters most, and it is silent otherwise: a signed-out browser
 * renders a perfectly good page, and reading the composer would report an empty composer as
 * a model that answered nothing.
 */
export function looksSignedOut(input: { loginLinkCount: number; composerCount: number }): boolean {
  return input.loginLinkCount > 0 && input.composerCount === 0;
}

/**
 * True when the response was a block page rather than the application.
 *
 * A blocked request still renders a page, so "no composer" alone is ambiguous between a
 * signed-out session and a refused connection — and those send a user in opposite
 * directions. The block page has its own wording, and it is read.
 */
export function looksBlocked(bodyText: string | null | undefined, documentTitle?: string | null): boolean {
  // Cloudflare's interstitial is titled "Just a moment..." with an empty body, so the
  // title has to be read too — the body alone is blank and matches nothing.
  if (/just a moment/i.test(documentTitle ?? '')) return true;
  return /unable to load site|attention required|access denied|checking your browser|verify you are human|enable javascript and cookies/i.test(
    bodyText ?? '',
  );
}

/* ------------------------------------------------------------------ *
 * The catalog
 * ------------------------------------------------------------------ */

/**
 * The model catalog, and the single source of truth for it.
 *
 * ChatGPT Web publishes no model list, and which models an account is offered depends on the
 * plan it is signed in with — a free account is not served the same set as a paid one. So the
 * catalog is keyed by plan, using the `planType` the export itself carries.
 *
 * This is still a claim about ChatGPT, not a fact read from ChatGPT. The page is the
 * authority: it renders its own model picker, and a model missing from this table can be
 * typed in as a custom id. That is why the list is a floor and not a gate.
 *
 * **The cards and the resolver are one table on purpose.** A card the resolver refuses is a
 * visible bug — the provider page offers it, a client sends it, and the request comes back
 * `unsupported model`. Deriving both from `CHATGPT_WEB_MODELS` makes that unreachable.
 */

/** The model label the page's own picker shows, which is what a paid turn is driven with. */
export type ChatGptWebFamily = 'GPT-5.6 Sol' | 'GPT-5.5';

/**
 * A position on the page's effort ladder.
 *
 * The wire request collapses this ladder to a single boolean: `0` and `4` differ in the
 * model string, and `1`–`3` are one request with thinking on. ChatGPT picks the effort
 * itself once `reason` is set, so the intermediate rungs are distinct *cards* — a client can
 * choose to think — but not distinct requests.
 */
export type ChatGptWebEffort = 0 | 1 | 2 | 3 | 4;

type ChatGptWebCard = {
  /** The id a client sends. Dots, because that is the spelling on the page. */
  id: string;
  name: string;
  /** `null` for the free tier, which has no picker at all. */
  family: ChatGptWebFamily | null;
  effort: ChatGptWebEffort;
  /** The model string the page is given. Never the card id. */
  wireModel: string;
  /** Whether thinking is asked for, as a system hint rather than a different model. */
  think: boolean;
};

const SOL = 'GPT-5.6 Sol';
const FIVE_FIVE = 'GPT-5.5';

/** The wire model for a family: a plain request, and the Pro request. */
const base = (family: Exclude<ChatGptWebFamily, null>): string => (family === SOL ? 'gpt-5-6' : 'gpt-5-5');

const effortCard = (
  id: string,
  name: string,
  family: Exclude<ChatGptWebFamily, null>,
  effort: Exclude<ChatGptWebEffort, 4>,
): ChatGptWebCard => ({
  id,
  name,
  family,
  effort,
  // Every rung below Pro is the same request: the base model, with thinking asked for.
  wireModel: base(family),
  think: effort > 0,
});

const proCard = (
  id: string,
  name: string,
  family: Exclude<ChatGptWebFamily, null>,
): ChatGptWebCard => ({ id, name, family, effort: 4, wireModel: `${base(family)}-pro`, think: false });

/**
 * Free first is deliberate: it is the tier every account can reach, and an account that
 * cannot be identified as paid is served this set.
 */
const CHATGPT_WEB_MODELS: readonly ChatGptWebCard[] = [
  /**
   * The free tier has **no model picker at all**. `resolveSelection` returns
   * `{ kind: 'free' }` and the page is sent the literal model `auto`, with the page choosing
   * — so the only axis a free account exposes is whether to think.
   */
  { id: 'gpt-5.6-luna-free', name: 'GPT-5.6 Luna (Free)', family: null, effort: 0, wireModel: 'auto', think: false },
  { id: 'gpt-5.6-luna-free-thinking', name: 'GPT-5.6 Luna (Free, Think)', family: null, effort: 0, wireModel: 'auto', think: true },

  effortCard('gpt-5.6-sol-instant', 'GPT-5.6 Sol (Instant)', SOL, 0),
  effortCard('gpt-5.6-sol-medium', 'GPT-5.6 Sol (Medium)', SOL, 1),
  effortCard('gpt-5.6-sol-high', 'GPT-5.6 Sol (High)', SOL, 2),
  effortCard('gpt-5.6-sol-xhigh', 'GPT-5.6 Sol (XHigh)', SOL, 3),
  proCard('gpt-5.6-sol-pro', 'GPT-5.6 Sol (Pro)', SOL),

  effortCard('gpt-5.5-instant', 'GPT-5.5 (Instant)', FIVE_FIVE, 0),
  effortCard('gpt-5.5-medium', 'GPT-5.5 (Medium)', FIVE_FIVE, 1),
  effortCard('gpt-5.5-high', 'GPT-5.5 (High)', FIVE_FIVE, 2),
  effortCard('gpt-5.5-xhigh', 'GPT-5.5 (XHigh)', FIVE_FIVE, 3),
  proCard('gpt-5.5-pro', 'GPT-5.5 (Pro)', FIVE_FIVE),
  /**
   * Offered by the reference's own provider page and kept here so a client that sends it is
   * answered rather than refused.
   *
   * It is an **alias of Pro, not a distinct request**: ChatGPT exposes no separate wire model
   * for it, and inventing one would produce a model id the page rejects. It resolves to the
   * same request as `gpt-5.5-pro` and is labelled so here rather than pretending otherwise.
   */
  proCard('gpt-5.5-pro-extended', 'GPT-5.5 (Pro Extended)', FIVE_FIVE),
];

/**
 * The spelling normalisation the reference applies before it looks a model up.
 *
 * Every dot becomes a hyphen, which is why `gpt-5.6-luna-free` and `gpt-5-6-luna-free` are
 * the same model and why accepting only one of them refuses the other for no reason. The
 * catalog is dotted, so a client that learned the hyphenated form from a log still resolves.
 */
export function normalizeChatGptWebModel(value: string): string {
  return value.trim().toLowerCase().replace(/^(chatgpt-web|cgpt-web)\//, '').replace(/\./g, '-');
}

/** The model the page is actually driven with, which is never the id the client sent. */
export type ChatGptWebSelection =
  | { kind: 'free'; thinkEnabled: boolean; model: 'auto' }
  | { kind: 'picker'; modelLabel: ChatGptWebFamily; effortIndex: ChatGptWebEffort; model: string };

/**
 * Resolves a client model id onto the selection the page understands.
 *
 * Returns nothing for an id outside the set, rather than guessing: a wrong guess here silently
 * selects a model the user did not ask for, and a plausible-looking model string the page
 * rejects reads as a broken provider.
 *
 * Ids that predate the effort ladder are still resolved, so a client that learned one from a
 * log is not broken by the catalog gaining rungs. They are deliberately *not* in the catalog:
 * `gpt-5-6` and `gpt-5.6-sol-instant` are the same request, and listing both would show a
 * duplicate in the picker.
 */
const LEGACY_SELECTIONS: ReadonlyArray<{ id: string; selection: ChatGptWebSelection }> = [
  { id: 'gpt-5-6', selection: { kind: 'picker', modelLabel: SOL, effortIndex: 0, model: 'gpt-5-6' } },
  // The reference's own registry ids, which carry no `sol`. They are a different string from
  // `gpt-5.6-sol-pro` after normalisation, so they need their own entries or a client using
  // the published names stops working the moment the catalog gains a family segment.
  { id: 'gpt-5-6-pro', selection: { kind: 'picker', modelLabel: SOL, effortIndex: 4, model: 'gpt-5-6-pro' } },
  { id: 'gpt-5-6-instant', selection: { kind: 'picker', modelLabel: SOL, effortIndex: 0, model: 'gpt-5-6' } },
  { id: 'gpt-5-6-thinking', selection: { kind: 'picker', modelLabel: SOL, effortIndex: 1, model: 'gpt-5-6' } },
  { id: 'gpt-5-6-sol', selection: { kind: 'picker', modelLabel: SOL, effortIndex: 1, model: 'gpt-5-6' } },
  { id: 'gpt-5-5', selection: { kind: 'picker', modelLabel: FIVE_FIVE, effortIndex: 0, model: 'gpt-5-5' } },
  { id: 'gpt-5-5-pro', selection: { kind: 'picker', modelLabel: FIVE_FIVE, effortIndex: 4, model: 'gpt-5-5-pro' } },
  { id: 'gpt-5-5-instant', selection: { kind: 'picker', modelLabel: FIVE_FIVE, effortIndex: 0, model: 'gpt-5-5' } },
  { id: 'gpt-5-5-thinking', selection: { kind: 'picker', modelLabel: FIVE_FIVE, effortIndex: 1, model: 'gpt-5-5' } },
];

/**
 * The rung a `reasoning_effort` in a request body maps onto.
 *
 * The effort in the body only applies to an id that leaves the effort open — `-thinking` and
 * the bare family names. A card that names its rung, like `gpt-5.6-sol-high`, is that rung.
 */
function effortFromRequest(value: string | undefined): ChatGptWebEffort {
  if (value === undefined || value === 'medium') return 1;
  if (['none', 'off', 'minimal', 'low'].includes(value)) return 0;
  if (value === 'high') return 2;
  if (['xhigh', 'max'].includes(value)) return 3;
  throw new Error(`ChatGPT Web does not support reasoning effort ${value}.`);
}

export function resolveChatGptWebSelection(model: string, effort?: string): ChatGptWebSelection | undefined {
  const normalized = normalizeChatGptWebModel(model);

  const card = CHATGPT_WEB_MODELS.find((entry) => normalizeChatGptWebModel(entry.id) === normalized);
  if (card) {
    return card.family === null
      ? { kind: 'free', thinkEnabled: card.think, model: 'auto' }
      : { kind: 'picker', modelLabel: card.family, effortIndex: card.effort, model: card.wireModel };
  }

  const legacy = LEGACY_SELECTIONS.find((entry) => entry.id === normalized);
  if (legacy) {
    // A legacy id that leaves the effort open takes it from the body, as it always did.
    if (effort !== undefined && legacy.selection.kind === 'picker') {
      return { ...legacy.selection, effortIndex: effortFromRequest(effort) };
    }
    return legacy.selection;
  }

  return undefined;
}

/**
 * The model string and thinking flag the page is actually given.
 *
 * This is the reference's `directModel`, and it lives here rather than at the call site
 * because the rule is not obvious: **Pro must not ask for thinking.** `reason` is a system
 * hint, and a hint of `reason` on a Pro request is one the page does not honour — so
 * deriving it as `effortIndex > 0` sends a flag the reference deliberately withholds. It
 * read as a harmless extra flag; it is a wrong request.
 */
export function chatGptWebDirectModel(selection: ChatGptWebSelection): { model: string; reason: boolean } {
  if (selection.kind === 'free') return { model: 'auto', reason: selection.thinkEnabled };
  if (selection.effortIndex === 4) return { model: selection.model, reason: false };
  return { model: selection.model, reason: selection.effortIndex > 0 };
}

/** Every id this provider serves, across plans. */
export function allChatGptWebModels(): string[] {
  return [...new Set([...CHATGPT_WEB_MODELS, ...LEGACY_SELECTIONS.map((entry) => ({ id: entry.id }))].map((model) => model.id))];
}

/**
 * Every model this provider serves, for every plan.
 *
 * **The plan does not narrow this list**, and that is a deliberate change from the previous
 * behaviour, which showed a free account only the two Luna cards. Two reasons, and they point
 * the same way:
 *
 *  - `resolveChatGptWebSelection` never consults the plan. It maps an id onto a selection and
 *    lets the page refuse, because a `planType` read out of an export is weaker evidence than
 *    what the page actually serves. Gating the catalog on it was a second, different rule.
 *  - A wrong gate is not symmetric. Showing a model the account cannot use costs one visible
 *    test failure, which names itself. Hiding a model the account *can* use hides something
 *    that works, and there is no way to tell that apart from "not supported".
 *
 * The `planType` argument is kept and still reported — the connect dialog shows it, and the
 * free-only import uses it — but it does not decide what is offered.
 */
export function chatGptWebModels(_planType?: string): ReadonlyArray<{ id: string; name: string }> {
  return CHATGPT_WEB_MODELS.map((card) => ({ id: card.id, name: card.name }));
}


/**
 * Plans that are not the free tier.
 *
 * Anything unrecognised is treated as paid rather than restricted: showing a model a paid
 * account cannot use produces a visible test failure, while hiding one a free account *can*
 * use hides something that works.
 */
export function isFreeChatGptPlan(planType: string | undefined): boolean {
  if (!planType) return false;
  const normalized = planType.trim().toLowerCase();
  return normalized === 'free' || normalized === 'free_plan' || normalized === 'freeplus' || normalized.startsWith('free');
}


/* ------------------------------------------------------------------ *
 * The adapter
 * ------------------------------------------------------------------ */

export const chatGptWebProviderId = 'chatgpt-web';

/**
 * The browser half, supplied by the gateway.
 *
 * Kept as an interface so this package stays dependency-free and so the flow can be
 * exercised without a browser at all. A missing driver is reported plainly rather than
 * being faked with a canned answer.
 */
export type ChatGptWebDriver = {
  /** Opens the page, sends one prompt, and resolves with the answer text. */
  ask: (input: {
    cookies: readonly ChatGptCookie[];
    /**
     * What to select in the page — a model label and an effort index, or the free tier's
     * "the page decides" case. This is what the page is driven with; the id the client sent
     * is only the means of choosing it.
     */
    selection: ChatGptWebSelection;
    messages: readonly { role: string; text: string }[];
    timeoutMs: number;
    signal?: AbortSignal;
  }) => Promise<{ text: string; usage?: TokenUsage }>;
  /** Whether a browser is actually available. */
  available: () => Promise<{ ok: boolean; reason?: string }>;
  /**
   * Opens the page and reports whether the session is signed in.
   *
   * Optional because a driver with no browser cannot do it, and its absence is not a failure
   * of the session — a check that cannot run says so rather than passing.
   */
  verify?: (input: { cookies: readonly ChatGptCookie[]; timeoutMs?: number; signal?: AbortSignal }) => Promise<{ ok: boolean; plan?: string | null }>;
};

function messageText(content: MessageContent): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') return part.text;
      return '';
    })
    .join('');
}

export type ChatGptWebAdapterOptions = {
  driver: ChatGptWebDriver;
  now?: () => number;
};

export class ChatGptWebAdapter implements ProviderAdapter {
  readonly id = chatGptWebProviderId;
  readonly name = 'ChatGPT Web';
  /**
   * Streaming is not implemented. The answer arrives when the page has finished rendering
   * it, and presenting that as a stream would imply tokens arriving over time when none
   * do. Streaming a whole answer in one chunk is honest about what happened.
   */
  readonly capabilities = { chat: true, streaming: false, models: true } as const;

  private readonly driver: ChatGptWebDriver;
  private readonly now: () => number;

  constructor(options: ChatGptWebAdapterOptions) {
    this.driver = options.driver;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Discovery runs when a connection is being created, which is before any credential
   * exists, so a missing one is not an error here — it just means the plan is unknown and
   * the full set is offered. Throwing instead leaves a saved connection with no models.
   */
  async listModels(context: ProviderRequestContext = {}): Promise<Model[]> {
    // Every plan gets the whole set; only the connection's own import policy narrows it.
    const models = chatGptWebModels();
    // The free-only import is honoured here rather than at the dialog, so it is true whether
    // the connection was made from the dashboard or from the API. A toggle that only lives in
    // the dialog is a toggle that silently does nothing for anyone else.
    const visible = context.importPolicy === 'free' ? models.filter((model) => model.id.includes('free')) : models;
    return visible.map((model) => ({ id: model.id, providerId: this.id, displayName: model.name }));
  }

  async validateCredential(credential: ProviderCredential | undefined): Promise<CredentialValidation> {
    const session = chatGptWebSessionFromCredential(credential);
    // The export says when it expires, so a dead session is reported as one without
    // spending a browser launch to discover it.
    if (session.expiresAt && Date.parse(session.expiresAt) <= this.now()) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'This ChatGPT session has expired. Export a new one.', {
        providerId: this.id,
        publicMessage: 'This ChatGPT session has expired. Export a new one.',
      });
    }
    const header = chatGptCookieHeader(session.cookies, this.now());
    if (!header) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'Every cookie in that export has expired. Export a new one.', {
        providerId: this.id,
        publicMessage: 'Every cookie in that export has expired. Export a new one.',
      });
    }
    const browser = await this.driver.available();
    if (!browser.ok) {
      throw new ProviderError('PROVIDER_UNAVAILABLE', browser.reason ?? 'No browser is available to ChatGPT Web.', {
        providerId: this.id,
        publicMessage: browser.reason ?? 'No browser is available to ChatGPT Web.',
      });
    }
    /**
     * The page is asked, not just the browser.
     *
     * Everything above is local: expiry, cookie presence, whether a browser exists. None of
     * it can tell a working session from one revoked elsewhere, and reporting "valid" for
     * both is how "connected but every request fails" begins. A driver that cannot open the
     * page says so rather than passing on the strength of the local checks.
     */
    if (!this.driver.verify) {
      throw new ProviderError('PROVIDER_UNAVAILABLE', 'This ChatGPT Web driver cannot check a session, so it cannot be verified.', {
        providerId: this.id,
        publicMessage: 'This ChatGPT Web driver cannot check a session, so it cannot be verified.',
      });
    }
    const verified = await this.driver.verify({ cookies: session.cookies });
    if (!verified.ok) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'chatgpt.com did not accept that session.', {
        providerId: this.id,
        publicMessage: 'chatgpt.com did not accept that session.',
      });
    }
    return { status: 'valid', checkedAt: new Date().toISOString() };
  }

  async chat(request: ChatRequest, context: ProviderRequestContext = {}): Promise<ChatResponse> {
    const session = chatGptWebSessionFromCredential(context.credential);
    const selection = resolveChatGptWebSelection(request.model);
    if (!selection) {
      throw new ProviderError('NOT_SUPPORTED', `ChatGPT Web does not offer a model called ${request.model}.`, {
        providerId: this.id,
        publicMessage: `ChatGPT Web does not offer a model called ${request.model}. The page's own picker is the authority — add it as a custom model id if it is listed there.`,
      });
    }
    // A browser turn carries one prompt, so the system turn and history are flattened into
    // it rather than sent as separate messages the page has nowhere to put.
    const messages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({ role: message.role, text: messageText(message.content) }))
      .filter((message) => message.text);
    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => messageText(message.content))
      .filter(Boolean)
      .join('\n\n');
    const last = messages[messages.length - 1];
    const prompt = [system, last?.text ?? ''].filter(Boolean).join('\n\n');

    /**
     * The driver's failures are plain errors describing the page, and a plain error
     * crossing the routing layer arrives as "every provider route failed" with the reason
     * discarded. So it is re-raised as a provider error: a refused request and a broken
     * model are different problems, and only one of them is worth retrying elsewhere.
     */
    let result: { text: string; usage?: TokenUsage };
    try {
      result = await this.driver.ask({
        cookies: session.cookies,
        selection,
        messages: [...messages.slice(0, -1), { role: 'user', text: prompt }],
        timeoutMs: CHATGPT_WEB.defaultTurnTimeoutMs,
        ...(context.signal ? { signal: context.signal } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The ChatGPT page could not be driven.';
      const blocked = /challenge|unable to load|bot-protection|anti-bot/i.test(message);
      throw new ProviderError(blocked ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_REQUEST_FAILED', message, {
        providerId: this.id,
        publicMessage: message,
        cause: error,
      });
    }

    const text = (result.text ?? '').trim();
    if (!text) {
      throw new ProviderError('INVALID_RESPONSE', 'The ChatGPT page rendered no answer.', {
        providerId: this.id,
        publicMessage: 'The ChatGPT page rendered no answer. If you were signed out, the export is stale — export a new one.',
      });
    }
    return {
      id: `chatgpt-web-${Date.now().toString(36)}`,
      providerId: this.id,
      model: request.model,
      createdAt: new Date().toISOString(),
      message: { role: 'assistant', content: text },
      // The page signals completion, not a finish reason, so `stop` is the honest reading.
      finishReason: 'stop',
      ...(result.usage ? { usage: result.usage } : {}),
    };
  }

  async *streamChat(request: ChatRequest, context: ProviderRequestContext = {}): AsyncIterable<ChatChunk> {
    const response = await this.chat(request, context);
    yield {
      id: response.id,
      providerId: response.providerId,
      model: response.model,
      delta: { role: 'assistant', content: messageText(response.message.content) },
      finishReason: response.finishReason,
      ...(response.usage ? { usage: response.usage } : {}),
    };
  }

  async healthCheck(context: ProviderRequestContext = {}): Promise<{ status: 'healthy' | 'degraded' | 'unavailable'; checkedAt: string; message?: string }> {
    try {
      await this.validateCredential(context.credential);
      return { status: 'healthy', checkedAt: new Date().toISOString() };
    } catch (error) {
      return {
        status: 'unavailable',
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : 'The ChatGPT Web session could not be checked.',
      };
    }
  }
}
