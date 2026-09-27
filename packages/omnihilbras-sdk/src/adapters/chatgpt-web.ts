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

export const CHATGPT_WEB = {
  /** The only origin this will talk to. */
  origin: 'https://chatgpt.com',
  /**
   * A temporary chat is used because a normal conversation is kept server-side against
   * the account, and a gateway's own traffic should not accumulate a visible history
   * under somebody's name. It is also one fewer artifact to clean up afterwards.
   */
  startUrl: 'https://chatgpt.com/?temporary-chat=true',
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
    // A bare cookie header is the other thing people paste, and saying so is more use than
    // a JSON syntax error.
    throw new ProviderError('INVALID_REQUEST', 'That is not JSON. Export storage state from a browser, or paste the cookie header instead.', {
      providerId: chatGptWebProviderId,
      publicMessage: 'That is not JSON. Export storage state from a browser, or paste the cookie header instead.',
    });
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
        name: '__Secure-next-auth.session-token',
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
 * The model catalog.
 *
 * ChatGPT Web publishes no model list, and which models an account is offered depends on
 * the plan it is signed in with — a free account is not served the same set as a paid one.
 * So the catalog is keyed by plan rather than asserted for everybody, using the
 * `planType` the export itself carries.
 *
 * This is still a claim about ChatGPT, not a fact read from ChatGPT. The page is the
 * authority: it renders its own model picker, and a model missing from this table can be
 * typed in as a custom id. That is why the list is a floor and not a gate.
 */
const CHATGPT_WEB_PLANS: Record<string, ReadonlyArray<{ id: string; name: string }>> = {
  free: [
    { id: 'gpt-5.2', name: 'GPT-5.2' },
    { id: 'gpt-5.2-thinking', name: 'GPT-5.2 Thinking' },
    { id: 'gpt-5.1', name: 'GPT-5.1' },
  ],
  paid: [
    { id: 'gpt-5.2', name: 'GPT-5.2' },
    { id: 'gpt-5.2-thinking', name: 'GPT-5.2 Thinking' },
    { id: 'gpt-5.1', name: 'GPT-5.1' },
    { id: 'gpt-5.1-thinking', name: 'GPT-5.1 Thinking' },
    { id: 'gpt-5-mini', name: 'GPT-5 mini' },
    { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex' },
  ],
};

/**
 * Plans that are not the free tier.
 *
 * Anything unrecognised is treated as paid rather than restricted: showing a model a paid
 * account cannot use produces a visible test failure, while hiding one a free account *can*
 * use hides something that works. A false negative costs a line of typing; a false positive
 * costs a failing test.
 */
export function isFreeChatGptPlan(planType: string | undefined): boolean {
  if (!planType) return false;
  const normalized = planType.trim().toLowerCase();
  return normalized === 'free' || normalized === 'free_plan' || normalized === 'freeplus' || normalized.startsWith('free');
}

/** The catalog for a plan, or the full set when the export did not say. */
export function chatGptWebModels(planType?: string): ReadonlyArray<{ id: string; name: string }> {
  if (!planType) return CHATGPT_WEB_PLANS.paid!;
  return isFreeChatGptPlan(planType) ? CHATGPT_WEB_PLANS.free! : CHATGPT_WEB_PLANS.paid!;
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
    model: string;
    messages: readonly { role: string; text: string }[];
    timeoutMs: number;
    signal?: AbortSignal;
  }) => Promise<{ text: string; usage?: TokenUsage }>;
  /** Whether a browser is actually available. */
  available: () => Promise<{ ok: boolean; reason?: string }>;
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
    const plan = context.credential ? chatGptWebSessionFromCredential(context.credential).planType : undefined;
    return chatGptWebModels(plan).map((model) => ({ id: model.id, providerId: this.id, displayName: model.name }));
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
    return { status: 'valid', checkedAt: new Date().toISOString() };
  }

  async chat(request: ChatRequest, context: ProviderRequestContext = {}): Promise<ChatResponse> {
    const session = chatGptWebSessionFromCredential(context.credential);
    if (!chatGptWebModels(session.planType).some((model) => model.id === request.model)) {
      const plan = session.planType ? ` a ${session.planType} plan` : '';
      throw new ProviderError('NOT_SUPPORTED', `${request.model} is not in the model set for${plan || ' this account'}.`, {
        providerId: this.id,
        publicMessage: `${request.model} is not in the model set for${plan || ' this account'}. The page's own model picker is the authority — add it as a custom model id if it is listed there.`,
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

    const result = await this.driver.ask({
      cookies: session.cookies,
      model: request.model,
      messages: [...messages.slice(0, -1), { role: 'user', text: prompt }],
      timeoutMs: CHATGPT_WEB.defaultTurnTimeoutMs,
      ...(context.signal ? { signal: context.signal } : {}),
    });

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
