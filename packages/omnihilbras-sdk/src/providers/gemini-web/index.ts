import { ProviderError } from '../../core/errors.js';
import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  CredentialValidation,
  MessageContent,
  Model,
  ProviderAdapter,
  ProviderCredential,
  ProviderHealth,
  ProviderRequestContext,
} from '../../core/types.js';

/**
 * Gemini Web.
 *
 * Not an API integration and not an OAuth flow: Google publishes no endpoint that accepts a browser
 * session, so the only way to reach a model this way is to load `gemini.google.com` in a real browser,
 * let the page solve its own challenges, type into the composer and read the answer out of the
 * response stream. The same shape as `chatgpt-web`, and it carries the same warning — the credential is
 * a **live session for a whole Google account**, not a token scoped to inference.
 *
 * The browser lives in the gateway, not here. This module owns the parts that can be reasoned about
 * and tested without one: what a Gemini cookie is, what the `StreamGenerate` payload looks like, which
 * models the UI can be driven to, and what refusals are honest to make before a browser is even opened.
 */

/** The primary cookie, and the one a bare value is assumed to be. */
export const GEMINI_WEB_PRIMARY_COOKIE = '__Secure-1PSID';

/**
 * The cookies Google rotates on its own schedule. They are read back out of the live browser jar after a
 * run and merged into the stored credential, because a session whose `1PSIDTS` is not refreshed stops
 * working while still parsing perfectly.
 */
export const GEMINI_WEB_ROTATABLE_COOKIES = ['__Secure-1PSID', '__Secure-1PSIDTS', '__Secure-1PSIDCC'] as const;

export const GEMINI_WEB = {
  /** The only origin this will talk to. */
  origin: 'https://gemini.google.com',
  startUrl: 'https://gemini.google.com/app',
  /**
   * Where the answer arrives. It is **observed**, never called: the page makes this request itself and the
   * driver reads the response. The URL is matched by this substring, because the full path carries a service
   * name that changes.
   */
  streamMarker: 'StreamGenerate',
  /** The composer. A contenteditable, so its class is a styling hook and may change. */
  composer: '.ql-editor, [contenteditable="true"]',
  /**
   * A link to Google's sign-in page, which is what a signed-out Gemini shows.
   *
   * Checked before the composer, because the signed-out page carries **hidden** contenteditable nodes: a check
   * that only looked for the composer counted one of those and reported a dead session as connected.
   */
  signedOutLink: 'a[href*="accounts.google.com"]',
  /**
   * The whole interaction is bounded: a navigation, a settling pause, and a hard cap on waiting for the
   * answer. A page that never answers must fail, not hang.
   */
  navigationTimeoutMs: 20_000,
  settleMs: 3_000,
  answerTimeoutMs: 30_000,
} as const;

/** The models the UI can be driven to, and how each is selected. */
export type GeminiWebModel = {
  id: string;
  name: string;
  /**
   * The model the page already opens to, so nothing is clicked. Claiming to have selected it when the UI
   * reports it anyway would be a claim about a click that never happened.
   */
  isDefault?: boolean;
  /**
   * The menu button, the element that reports the active mode, and the pattern that read-back must match.
   *
   * **Unvalidated.** These are Gemini's UI hooks as best they can be known without a live account; when one
   * is wrong the selection fails closed and says so rather than answering with the wrong model.
   */
  toggleSelector?: string;
  indicatorSelector?: string;
  indicatorPattern?: RegExp;
};

/**
 * Gemini's web models.
 *
 * The ids are what this gateway serves; they are **not** Google API model ids, and asking for
 * `gemini-2.5-pro` here is refused rather than silently answered by a different model. The list is short
 * for the same reason the reference's is: the UI offers a handful of modes, and a mode that is not in this
 * table cannot be chosen.
 */
export const GEMINI_WEB_MODELS: readonly GeminiWebModel[] = [
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', isDefault: true },
  {
    id: 'gemini-3.7-flash',
    name: 'Gemini 3.7 Flash',
    toggleSelector: '[data-test-id="bard-mode-menu-button"], button[aria-haspopup="menu"][aria-label*="model" i]',
    indicatorSelector: '[data-test-id="bard-mode-menu-button"] .mode-title, [data-test-id="bard-mode-menu-button"]',
    // `(?!.*lite)` so the plain Flash mode never matches the Flash-Lite label.
    indicatorPattern: /\bflash\b(?!.*\blite\b)/i,
  },
  {
    id: 'gemini-3.1-flash-lite',
    name: 'Gemini 3.1 Flash-Lite',
    toggleSelector: '[data-test-id="bard-mode-menu-button"], button[aria-haspopup="menu"][aria-label*="model" i]',
    indicatorSelector: '[data-test-id="bard-mode-menu-button"] .mode-title, [data-test-id="bard-mode-menu-button"]',
    indicatorPattern: /flash.*\blite\b/i,
  },
] as const;

export const geminiWebProviderId = 'gemini-web';

/** The model resolved for a request, or `undefined` for an id the UI cannot be driven to. */
export function resolveGeminiWebModel(model: string | undefined): GeminiWebModel | undefined {
  if (!model) return undefined;
  return GEMINI_WEB_MODELS.find((entry) => entry.id === model);
}

/** One cookie, as a name and a value. */
export type GeminiWebCookie = { name: string; value: string };

/**
 * Reads the pasted credential.
 *
 * Three shapes are accepted, because three are what people actually paste: the bare value of
 * `__Secure-1PSID`, a whole `Cookie:` header, and a JSON export from an extension. A bare value has no name
 * in it, so the name is supplied — which is the whole reason this function exists rather than a split on
 * `=`: `abc=def` is a header and `abcdef` is a value, and only one of those parses as a cookie.
 */
export function normalizeGeminiWebCookie(raw: string, cookieName = GEMINI_WEB_PRIMARY_COOKIE): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const pairs = cookiePairsFromJson(trimmed);
  if (pairs.length > 0) return pairs.map((pair) => `${pair.name}=${pair.value}`).join('; ');
  return trimmed.includes('=') ? trimmed : `${cookieName}=${trimmed}`;
}

/** A JSON object export (`{...}` or `{cookies: {...}}`), or an empty list for anything else. */
function cookiePairsFromJson(raw: string): GeminiWebCookie[] {
  if (!raw.startsWith('{')) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
  const record = parsed as Record<string, unknown>;
  const source = typeof record.cookies === 'object' && record.cookies !== null && !Array.isArray(record.cookies)
    ? (record.cookies as Record<string, unknown>)
    : record;
  return Object.entries(source)
    .filter(([, value]) => typeof value === 'string' && (value as string).trim() !== '')
    .map(([name, value]) => ({ name, value: (value as string).trim() }));
}

/**
 * Splits a `Cookie:` header into pairs, dropping the attributes that are not cookies.
 *
 * `path`, `domain`, `expires` and the rest appear in a copied header and are not sendable names — treating
 * them as cookies sends `path=/` to Google, which is at best ignored and at worst a malformed request.
 */
export function parseGeminiWebCookieHeader(header: string): GeminiWebCookie[] {
  const attributes = new Set(['path', 'domain', 'expires', 'max-age', 'secure', 'httponly', 'samesite', 'priority', 'partitioned']);
  const pairs: GeminiWebCookie[] = [];
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name || !value) continue;
    if (attributes.has(name.toLowerCase())) continue;
    pairs.push({ name, value });
  }
  return pairs;
}

/** Whether the credential holds at least one usable cookie. Format only — a browser answers the real question. */
export function geminiWebCookiePresent(raw: string): boolean {
  return parseGeminiWebCookieHeader(normalizeGeminiWebCookie(raw)).length > 0;
}

/**
 * Merges the cookies the live browser jar reports back into the stored header.
 *
 * Google replaces these three on its own schedule. A jar value that differs is the new one; a rotatable name
 * present in the jar but absent from the original is appended, because a cookie the page minted is part of the
 * session even though the user never pasted it. Everything else in the original is left alone — the driver
 * only sends what Google set, and rewriting the rest would drop something the page needs.
 */
export function mergeRotatedGeminiWebCookies(original: string, jar: readonly GeminiWebCookie[]): string {
  const rotatable = new Set<string>(GEMINI_WEB_ROTATABLE_COOKIES);
  const merged = new Map<string, string>();
  for (const pair of parseGeminiWebCookieHeader(original)) merged.set(pair.name, pair.value);
  for (const pair of jar) {
    if (!rotatable.has(pair.name) || !pair.value) continue;
    merged.set(pair.name, pair.value);
  }
  return [...merged.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

/**
 * Reads the answer out of a `StreamGenerate` body.
 *
 * The body is a `)]}'`-prefixed framing of length-prefixed lines, each holding a `wrb.fr` envelope whose third
 * element is a JSON string. The answer is `inner[4][0][1]`, joined.
 *
 * **The frames are cumulative snapshots of the same answer, not increments** — each one contains everything so
 * far — so concatenating them duplicates the whole reply. Only the last frame that produced text is kept.
 * Grading this wrong is invisible on a one-word answer and unmissable on a paragraph, which is exactly the kind
 * of bug a test has to pin.
 */
export function parseGeminiWebStreamResponse(raw: string): string {
  let text = '';
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === ")]}'" || /^\d+$/.test(trimmed)) continue;
    if (!trimmed.includes('wrb.fr')) continue;
    let envelope: unknown;
    try {
      envelope = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!Array.isArray(envelope) || !Array.isArray(envelope[0]) || envelope[0][0] !== 'wrb.fr') continue;
    const payload = envelope[0][2];
    if (typeof payload !== 'string') continue;
    let inner: unknown;
    try {
      inner = JSON.parse(payload);
    } catch {
      continue;
    }
    const parts = candidateText(inner);
    if (parts) text = parts;
  }
  return text;
}

/** `inner[4][0][1]` as text, or `undefined` when the shape is not the one that carries an answer. */
function candidateText(inner: unknown): string | undefined {
  if (!Array.isArray(inner)) return undefined;
  const group = inner[4];
  if (!Array.isArray(group) || !Array.isArray(group[0])) return undefined;
  const list = group[0][1];
  if (!Array.isArray(list)) return undefined;
  const text = list.filter((entry): entry is string => typeof entry === 'string').join('');
  return text.length > 0 ? text : undefined;
}

/**
 * The browser, as the adapter sees it.
 *
 * Defined here and implemented in the gateway, so the SDK never depends on Playwright — the same boundary
 * `chatgpt-web` uses. `available()` exists because a browser is an external requirement: a host without one
 * must be told apart from a session that is refused, or the user is sent to fix the wrong thing.
 */
export type GeminiWebDriver = {
  /** Whether a browser is actually available, and what to do when it is not. */
  available: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * Drives one turn and returns the answer.
   *
   * `onRotatedCookies` is how rotation reaches storage. Google replaces the three `__Secure-1PSID*` cookies on
   * its own schedule, and only the live browser jar knows the new values — so the driver hands them back here
   * rather than through the response, which has no field for them. Persisting is the gateway's job, and a
   * failure to persist must never fail the answer: the turn already succeeded.
   */
  ask: (input: {
    cookies: readonly GeminiWebCookie[];
    model: GeminiWebModel | undefined;
    messages: readonly { role: string; text: string }[];
    timeoutMs: number;
    signal?: AbortSignal;
    onRotatedCookies?: (merged: string) => void | Promise<void>;
  }) => Promise<{ text: string }>;
  /** Confirms the session is signed in, by opening the page. Optional: a driver with no browser cannot. */
  verify?: (input: { cookie: string; timeoutMs?: number; signal?: AbortSignal }) => Promise<{ ok: boolean; note?: string }>;
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

/**
 * The prompt the page is driven with.
 *
 * Gemini's composer takes one turn, so the conversation is flattened into it: a system message becomes a
 * `System:` block, and earlier turns become a transcript. The **last user message is byte-for-byte** what the
 * person typed, because that is the part the model is answering.
 */
export function buildGeminiWebPrompt(messages: readonly { role: string; text: string }[]): string {
  const system = messages.filter((message) => message.role === 'system').map((message) => message.text).filter(Boolean);
  const turns = messages.filter((message) => message.role !== 'system');
  const current = turns[turns.length - 1];
  const history = turns.slice(0, -1);
  const userText = current?.text ?? '';
  if (system.length === 0 && history.length === 0) return userText;
  const blocks: string[] = [];
  if (system.length > 0) blocks.push(`System:\n${system.join('\n\n')}`);
  if (history.length > 0) {
    blocks.push(`Previous conversation:\n${history.map((message) => `${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.text}`).join('\n\n')}`);
  }
  blocks.push(`Current user message:\n${userText}`);
  return blocks.join('\n\n');
}

export type GeminiWebAdapterOptions = {
  driver: GeminiWebDriver;
  /** The id used on records and errors. Defaults to `gemini-web`. */
  id?: string;
  /**
   * Where a rotated cookie goes.
   *
   * Google replaces the `__Secure-1PSID*` cookies on its own schedule, and the refreshed values have to be
   * written back or the connection stops working while its stored credential still parses. The same option
   * name the other renewing adapters use (`claude-code`, `cline`). A failure here is swallowed by the caller,
   * never by this adapter: the turn already succeeded and must not be reported as failed.
   */
  onTokensRefreshed?: (merged: string) => void | Promise<void>;
  now?: () => number;
};

export class GeminiWebAdapter implements ProviderAdapter {
  readonly id: string;
  readonly name = 'Gemini Web';
  /**
   * Streaming is not implemented, and saying otherwise would be false. The answer arrives when the page has
   * finished rendering it; presenting that as a stream would claim tokens arriving over time when none do.
   */
  readonly capabilities = { chat: true, streaming: false, models: true } as const;

  private readonly driver: GeminiWebDriver;
  private readonly onTokensRefreshed?: (merged: string) => void | Promise<void>;

  constructor(options: GeminiWebAdapterOptions) {
    this.driver = options.driver;
    this.id = options.id ?? geminiWebProviderId;
    this.onTokensRefreshed = options.onTokensRefreshed;
  }

  async listModels(): Promise<Model[]> {
    return GEMINI_WEB_MODELS.map((model) => ({ id: model.id, displayName: model.name, providerId: this.id }));
  }

  async validateCredential(credential: ProviderCredential | undefined): Promise<CredentialValidation> {
    if (credential?.type !== 'api-key' || !geminiWebCookiePresent(credential.value)) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'Paste a Gemini session cookie to use this provider.', {
        providerId: this.id,
        publicMessage: 'Paste a Gemini session cookie (`__Secure-1PSID` and `__Secure-1PSIDTS`) to use this provider.',
      });
    }
    return { status: 'valid', checkedAt: new Date().toISOString() };
  }

  /**
   * The refusals that are honest to make before a browser is launched.
   *
   * A forced tool choice cannot be honoured — tools here are emulated in the prompt, and a caller that demanded
   * a tool call would get prose — so it is refused rather than silently downgraded. An unknown model cannot be
   * selected in the UI, so it is refused rather than answered by whichever mode the page happens to be in.
   */
  private refuseUnsupported(request: ChatRequest): void {
    const choice = request.toolChoice;
    if (choice === 'required') {
      throw new ProviderError('NOT_SUPPORTED', 'Gemini Web cannot be told to force a tool call.', {
        providerId: this.id,
        publicMessage: 'Gemini Web drives the web UI, which has no way to force a tool call. Send `tool_choice: "auto"` or omit it.',
      });
    }
    if (request.model && !resolveGeminiWebModel(request.model)) {
      const known = GEMINI_WEB_MODELS.map((model) => model.id).join(', ');
      throw new ProviderError('NOT_SUPPORTED', `Gemini Web cannot select ${request.model}.`, {
        providerId: this.id,
        publicMessage: `Gemini Web drives the web UI, which offers ${known}. ${request.model} is not one of them.`,
      });
    }
  }

  async chat(request: ChatRequest, context: ProviderRequestContext = {}): Promise<ChatResponse> {
    const credential = context.credential;
    if (credential?.type !== 'api-key' || !geminiWebCookiePresent(credential.value)) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'Paste a Gemini session cookie to use this provider.', {
        providerId: this.id,
        publicMessage: 'Paste a Gemini session cookie (`__Secure-1PSID` and `__Secure-1PSIDTS`) to use this provider.',
      });
    }
    this.refuseUnsupported(request);

    const messages = request.messages.map((message) => ({ role: message.role, text: messageText(message.content) }));
    const prompt = buildGeminiWebPrompt(messages);
    if (!prompt.trim()) {
      throw new ProviderError('INVALID_REQUEST', 'Gemini Web needs a user message to type into the page.', {
        providerId: this.id,
        publicMessage: 'Send at least one user message; Gemini Web types it into the page.',
      });
    }

    const cookie = normalizeGeminiWebCookie(credential.value);
    const available = await this.driver.available();
    if (!available.ok) {
      // Its own code, and not retryable: a missing browser will still be missing on the next attempt, and
      // retrying it would burn the failover chain on an installation problem.
      throw new ProviderError('PROVIDER_UNAVAILABLE', 'Gemini Web needs a browser that is not installed.', {
        providerId: this.id,
        retryable: false,
        publicMessage: available.reason,
      });
    }

    let answer: { text: string };
    try {
      answer = await this.driver.ask({
        cookies: parseGeminiWebCookieHeader(cookie),
        model: resolveGeminiWebModel(request.model),
        messages,
        timeoutMs: GEMINI_WEB.answerTimeoutMs + GEMINI_WEB.navigationTimeoutMs + GEMINI_WEB.settleMs,
        ...(context.signal ? { signal: context.signal } : {}),
        // The merged header goes to storage, not to the response: a turn that succeeded must not be reported as
        // failed because writing the refreshed cookie back did not work.
        onRotatedCookies: (merged) => this.onTokensRefreshed?.(merged),
      });
    } catch (error) {
      throw normalizeDriverError(error, this.id);
    }

    const text = answer.text ?? '';
    if (!text.trim()) {
      throw new ProviderError('INVALID_RESPONSE', 'Gemini Web returned an empty answer.', {
        providerId: this.id,
        publicMessage: 'The page produced no answer. The session may have expired — check the cookie, then try again.',
      });
    }

    return {
      id: `gemini-web-${Date.now().toString(36)}`,
      providerId: this.id,
      model: request.model ?? GEMINI_WEB_MODELS[0]!.id,
      createdAt: new Date().toISOString(),
      message: { role: 'assistant', content: text },
      finishReason: 'stop',
    };
  }

  /**
   * Gemini Web has no stream. The whole answer is yielded once, honestly, rather than pretending.
   */
  async *streamChat(request: ChatRequest, context: ProviderRequestContext = {}): AsyncIterable<ChatChunk> {
    const response = await this.chat(request, context);
    yield {
      id: response.id,
      providerId: response.providerId,
      model: response.model,
      delta: { role: 'assistant', content: messageText(response.message.content) },
      finishReason: response.finishReason,
    };
  }

  async healthCheck(context: ProviderRequestContext = {}): Promise<ProviderHealth> {
    try {
      await this.validateCredential(context.credential);
      return { status: 'healthy', verified: 'credential', checkedAt: new Date().toISOString() };
    } catch (error) {
      return {
        status: 'unavailable',
        verified: 'credential',
        checkedAt: new Date().toISOString(),
        ...(error instanceof ProviderError ? { errorCode: error.code } : {}),
      };
    }
  }
}

/**
 * A driver failure as a provider error.
 *
 * Three cases, in the order they should win — the same classification `chatgpt-web` arrived at for the same
 * reasons, because a page that refuses is not one thing:
 *
 * - **signed out.** The cookie expired or Google revoked it. Not retryable, and no other provider fixes it:
 *   the user's next action is to copy fresher cookies. `AUTHENTICATION_FAILED` so the router stops rather than
 *   failing over, and the dashboard says "sign in again" rather than "Gemini is unavailable".
 * - **blocked.** A bot-protection challenge. Also not retryable, and not the credential's fault, so
 *   `PROVIDER_UNAVAILABLE` — the operator waits, they do not re-copy a working cookie.
 * - **anything else.** `PROVIDER_REQUEST_FAILED`, which the router may retry.
 */
function driverFailureCode(message: string): 'AUTHENTICATION_FAILED' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_REQUEST_FAILED' {
  if (/sign(ed)?[ -]?in|logged[ -]?out|session (has )?expired|no longer|unauthori[sz]ed|401|log in again/i.test(message)) return 'AUTHENTICATION_FAILED';
  if (/challenge|unable to load|bot-protection|anti-bot/i.test(message)) return 'PROVIDER_UNAVAILABLE';
  return 'PROVIDER_REQUEST_FAILED';
}

function normalizeDriverError(error: unknown, providerId: string): ProviderError {
  if (error instanceof ProviderError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = driverFailureCode(message);
  const publicMessage = code === 'AUTHENTICATION_FAILED'
    ? 'The Gemini session is no longer accepted. Copy fresh cookies from gemini.google.com while signed in, then connect again.'
    : 'The Gemini page could not be driven to an answer. This usually means the session expired or the page changed.';
  return new ProviderError(code, `Gemini Web could not complete the turn: ${message}`, {
    providerId,
    // A signed-out session is not a transient failure, so it must not be retried — and `retryable` is what the
    // router reads.
    retryable: code === 'PROVIDER_REQUEST_FAILED',
    publicMessage,
  });
}