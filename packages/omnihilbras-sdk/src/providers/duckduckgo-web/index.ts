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
 * DuckDuckGo AI Chat (`duck.ai`), as a web-cookie provider whose cookie is **optional**.
 *
 * ## Why the cookie is optional, and why the card still offers one
 *
 * The service is anonymous: `/duckchat/v1/models` answers 200 with no credential at all, and a turn works
 * without one — measured from this host, twice, before any of this was written. So a pasted cookie is
 * hardening against rate limits rather than a requirement, and the card says so. Two things follow that the
 * code has to get right: a credential of `{ type: 'none' }` must be accepted everywhere a cookie is, and a
 * pasted cookie must never be *claimed* to be verified, because this service does not read it.
 *
 * ## The three traps, all measured rather than read
 *
 * 1. **The delta arrives in `message`, not `content`.** A reader that checks only `content` returns HTTP 200
 *    with an **empty answer** — the spike's own first attempt did exactly that, which is why
 *    `duckDuckGoWebContent` checks both and why the test pins the empty case.
 * 2. **Free models are `accessTier` on the model itself.** The live catalog marks 6 models free there, and
 *    only 3 by `reasoningEffortAccess[].accessTier` — a parser keyed on the wrong field silently drops half
 *    the free lineup. See `freeDuckDuckGoWebModels`.
 * 3. **The stream opens with `data: [CHAT_TITLE:...]`**, a non-JSON pseudo-event. `parseDuckDuckGoWebDataLine`
 *    returns `undefined` for it rather than throwing.
 *
 * ## What lives where
 *
 * Everything here is testable without a network: the cookie parsing, the catalog filter, the stream parsing,
 * the payload builder, and every refusal. The handshake, the challenge and the request itself are the
 * driver's, declared here and implemented in the gateway — the same boundary `gemini-web` uses, and required
 * here too because the challenge solver needs `node:vm`.
 */

export const DUCKDUCKGO_WEB = {
  origin: 'https://duck.ai',
  modelsPath: '/duckchat/v1/models',
  statusPath: '/duckchat/v1/status',
  chatPath: '/duckchat/v1/chat',
  homePath: '/',
  /**
   * The model a request gets when it names none.
   *
   * `gpt-5.4-mini` because it is free **today** — verified against the live catalog — and because it is the
   * one free id that has been free on every reading. It is not a promise: a catalog read that no longer lists
   * it free is refused by name rather than routed to something else. See `freeDuckDuckGoWebModels`.
   */
  defaultModel: 'gpt-5.4-mini',
  /** The service's own default effort, and the value the successful requests used. */
  defaultReasoningEffort: 'none',
  statusTimeoutMs: 15_000,
  catalogTimeoutMs: 15_000,
  homeTimeoutMs: 15_000,
  chatTimeoutMs: 60_000,
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
} as const;

export const duckduckgoWebProviderId = 'duckduckgo-web';

/* ------------------------------------------------------------------ *
 * The cookie, which may legitimately be absent
 * ------------------------------------------------------------------ */

/**
 * A pasted cookie in any of the three shapes a browser hands over.
 *
 * Bare value, a full `Cookie:` header line, or a JSON export. Returns `undefined` when the paste carries
 * nothing, so the caller can tell "the user pasted junk" from "there is no cookie", which are different
 * answers: the first is a mistake to report, the second is this provider's normal case.
 */
export function normalizeDuckDuckGoWebCookie(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;

  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      const entries = Array.isArray(parsed)
        ? parsed
        : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { cookies?: unknown }).cookies)
          ? ((parsed as { cookies: unknown[] }).cookies)
          : [];
      const pairs = entries
        .map((entry) => {
          const cookie = entry as { name?: unknown; value?: unknown };
          return typeof cookie?.name === 'string' && typeof cookie?.value === 'string' ? `${cookie.name}=${cookie.value}` : undefined;
        })
        .filter((pair): pair is string => pair !== undefined);
      return pairs.length > 0 ? pairs.join('; ') : undefined;
    } catch {
      return undefined;
    }
  }

  const withoutPrefix = text.replace(/^cookie:\s*/i, '');
  // A header line is `a=1; b=2`; a bare value is whatever was copied out of the devtools cell. Both are
  // accepted, because both are what people paste, and neither can be validated beyond "looks like a token".
  return withoutPrefix.includes('=') ? withoutPrefix : undefined;
}

/**
 * The `Cookie` header for a credential, or `undefined` when there is none to send.
 *
 * `{ type: 'none' }` is the **normal** case for this provider, not a missing value: it is what the connect
 * route stores when the user pastes nothing, and the request goes out without a `Cookie` header. Every other
 * web-cookie adapter in this repository refuses that credential, so this is the one place the difference is
 * visible.
 */
export function duckDuckGoWebCookieHeader(credential: ProviderCredential | undefined): string | undefined {
  if (!credential || credential.type === 'none') return undefined;
  if (credential.type !== 'api-key') return undefined;
  return normalizeDuckDuckGoWebCookie(credential.value);
}

/* ------------------------------------------------------------------ *
 * The catalog, and the field that decides what is free
 * ------------------------------------------------------------------ */

export type DuckDuckGoWebModel = { id: string; displayName: string };

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord => typeof value === 'object' && value !== null;

/**
 * The models the live catalog offers on a **free** tier.
 *
 * **The field is `accessTier` on the model itself**, and that is a measurement rather than a reading. Against
 * the live catalog on 2026-10-17:
 *
 * ```
 * free by model.accessTier                      : 6  (gpt-6-luna, gpt-5.4-mini, claude-haiku-4-5,
 *                                                    mistral-small-2603, tinfoil/gpt-oss-120b, tinfoil/gemma4-31b)
 * free by reasoningEffortAccess[].accessTier    : 3  (gpt-5.4-mini, claude-haiku-4-5, tinfoil/gpt-oss-120b)
 * ```
 *
 * Reading the nested field looks more precise and is simply wrong: it describes which *effort levels* an
 * account tier may select, not whether the model is served. A parser keyed on it silently drops half the
 * free lineup, which is why the first test in `duckduckgo-web.test.js` asserts both numbers.
 *
 * The list is read per request rather than pinned, because the lineup rotates — `gpt-6-luna` had appeared and
 * three of the source's hardcoded "free" ids no longer were, inside a week.
 */
export function freeDuckDuckGoWebModels(catalog: unknown): DuckDuckGoWebModel[] {
  if (!isRecord(catalog) || !Array.isArray(catalog.models)) return [];
  return catalog.models
    .filter((entry): entry is UnknownRecord => isRecord(entry))
    .filter((entry) => {
      const tiers = Array.isArray(entry.accessTier) ? entry.accessTier : [];
      return tiers.some((tier) => typeof tier === 'string' && tier.toLowerCase() === 'free');
    })
    .map((entry) => ({
      id: String(entry.id ?? ''),
      displayName: String(entry.modelName ?? entry.name ?? entry.id ?? ''),
    }))
    .filter((model) => model.id.length > 0);
}

export function duckDuckGoWebModelIds(catalog: unknown): string[] {
  return freeDuckDuckGoWebModels(catalog).map((model) => model.id);
}

/* ------------------------------------------------------------------ *
 * Reading the answer out of the stream
 * ------------------------------------------------------------------ */

/**
 * One `data:` line, or `undefined` for everything that is not answer text.
 *
 * Non-JSON lines are dropped rather than thrown on: the stream opens with `data: [CHAT_TITLE:...]` before any
 * JSON arrives, and `[DONE]` terminates it. Both are normal, and a parser that threw on them would fail every
 * turn at the first byte.
 */
export function parseDuckDuckGoWebDataLine(line: string): UnknownRecord | undefined {
  if (!line.startsWith('data: ')) return undefined;
  const data = line.slice('data: '.length).trim();
  if (!data || data === '[DONE]') return undefined;
  try {
    const parsed = JSON.parse(data) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The text of one event, from `content` **or** `message`.
 *
 * This is trap 1, and it is the difference between an answer and a 200 with nothing in it. The live service
 * sends `{"action":"success","message":"..."}` and then a run of `{"message":"..."}` frames; `content` never
 * appears. A reader that looked only for `content` — which is what every other provider here sends — would
 * return an empty string and report success.
 */
export function duckDuckGoWebContent(event: UnknownRecord | undefined): string {
  if (!event) return '';
  if (typeof event.content === 'string') return event.content;
  if (typeof event.message === 'string') return event.message;
  return '';
}

/* ------------------------------------------------------------------ *
 * The request body
 * ------------------------------------------------------------------ */

/** An RSA public key, as the service expects it inside `durableStream`. */
export type DuckDuckGoWebPublicKey = {
  kty: string;
  n?: string;
  e?: string;
  alg: string;
  ext: boolean;
  key_ops: string[];
  use: string;
};

/**
 * The request body.
 *
 * `publicKey` is a **parameter**, not generated here, and that is a hard boundary rather than a preference:
 * generating an RSA key pair needs `node:crypto`, and this module is reachable from the SDK barrel, which the
 * dashboard imports. `tests/sdk-browser-safety.test.js` fails if anything reachable from that barrel imports a
 * Node builtin — the 1.42.0 blank page — so the gateway generates the key and passes it in.
 *
 * `reasoningEffort` is always sent. The working implementation records it as **required**, with a 400
 * `ERR_BAD_REQUEST` when omitted, verified live on its side. Not re-measured here, because proving it costs a
 * chat POST against a rate-limited endpoint, and the requests that succeeded all sent it.
 */
export function buildDuckDuckGoWebPayload(input: {
  model: string;
  messages: readonly { role: string; content: string }[];
  publicKey: DuckDuckGoWebPublicKey;
  conversationId: string;
  messageId: string;
  reasoningEffort?: string;
}): UnknownRecord {
  return {
    model: input.model,
    metadata: {
      // Every tool off: this gateway is a chat surface, and a search tool that fired on its own would be a
      // request the caller did not ask for.
      toolChoice: { NewsSearch: false, VideosSearch: false, LocalSearch: false, WeatherForecast: false },
    },
    messages: input.messages.map((message) => ({ role: message.role, content: message.content })),
    canUseTools: true,
    reasoningEffort: input.reasoningEffort ?? DUCKDUCKGO_WEB.defaultReasoningEffort,
    canUseApproxLocation: null,
    canDelegateImageGeneration: null,
    durableStream: { messageId: input.messageId, conversationId: input.conversationId, publicKey: input.publicKey },
  };
}

/* ------------------------------------------------------------------ *
 * The driver, as the adapter sees it
 * ------------------------------------------------------------------ */

/**
 * A refusal with a **kind**, so the adapter decides retryability and the driver only reports what happened.
 *
 * The alternative — throwing `ProviderError` from the driver — would put routing policy in the gateway, and
 * the alternative this file avoids most deliberately is classifying by *message*: `ERR_CHALLENGE` and
 * `ERR_BN_LIMIT` arrive in the same JSON shape and, per the working implementation's own measurement, the
 * service maps both to the same user-facing message token. A regex over prose cannot tell them apart; a field
 * can.
 */
export class DuckDuckGoWebError extends Error {
  constructor(
    readonly kind: 'challenge' | 'quota' | 'rate-limit' | 'unavailable' | 'bad-request',
    message: string,
    readonly overrideCode?: string,
  ) {
    super(message);
    this.name = 'DuckDuckGoWebError';
  }
}

export type DuckDuckGoWebDriver = {
  /** Whether this host can solve the challenge at all. A `vm` is always present on Node, so this is honest. */
  available: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** The live catalog, unfiltered — the adapter decides what is free. */
  catalog: (input: { timeoutMs?: number; signal?: AbortSignal }) => Promise<unknown>;
  /** The handshake, reported as facts: whether a challenge was served and how long solving took. */
  status: (input: { timeoutMs?: number; signal?: AbortSignal }) => Promise<{ challengeServed: boolean; solvedMs: number }>;
  /** One turn. `cookieHeader` is `undefined` when the connection holds `{ type: 'none' }`. */
  ask: (input: {
    cookieHeader?: string;
    model: string;
    messages: readonly { role: string; content: string }[];
    timeoutMs: number;
    signal?: AbortSignal;
  }) => Promise<{ text: string; model: string }>;
};

/* ------------------------------------------------------------------ *
 * The adapter
 * ------------------------------------------------------------------ */

export type DuckDuckGoWebAdapterOptions = {
  driver: DuckDuckGoWebDriver;
  id?: string;
  now?: () => number;
};

export class DuckDuckGoWebAdapter implements ProviderAdapter {
  readonly id: string;
  readonly name = 'Duck.ai';
  /**
   * Streaming is not implemented and saying otherwise would be false: this adapter reads the service's SSE
   * and hands back the assembled answer, so no token arrives "over time" as far as a caller is concerned.
   */
  readonly capabilities = { chat: true, streaming: false, models: true } as const;

  private readonly driver: DuckDuckGoWebDriver;

  constructor(options: DuckDuckGoWebAdapterOptions) {
    this.driver = options.driver;
    this.id = options.id ?? duckduckgoWebProviderId;
  }

  async listModels(): Promise<Model[]> {
    const catalog = await this.driver.catalog({ timeoutMs: DUCKDUCKGO_WEB.catalogTimeoutMs });
    return freeDuckDuckGoWebModels(catalog).map((model) => ({
      id: model.id,
      displayName: `${model.displayName} (free tier)`,
      providerId: this.id,
    }));
  }

  /**
   * A credential is valid when it is absent, or when it looks like a cookie header.
   *
   * `{ type: 'none' }` returning `valid` is the whole point of this provider — and it is why the *check* the
   * dashboard runs is the handshake rather than this method. Nothing here contacts the service, so it cannot
   * claim a cookie works; it can only refuse one that is malformed.
   */
  async validateCredential(credential: ProviderCredential | undefined): Promise<CredentialValidation> {
    if (!credential || credential.type === 'none') return { status: 'valid', checkedAt: new Date().toISOString() };
    if (credential.type !== 'api-key') {
      throw new ProviderError('AUTHENTICATION_FAILED', 'Duck.ai takes no credential of that kind.', {
        providerId: this.id,
        publicMessage: 'Paste a duck.ai cookie, or leave it empty: this provider needs no credential.',
      });
    }
    const parsed = normalizeDuckDuckGoWebCookie(credential.value);
    if (!parsed) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'The pasted Duck.ai cookie could not be read.', {
        providerId: this.id,
        publicMessage: 'That does not look like a cookie. Paste the whole `Cookie:` line from duck.ai, or leave the field empty — no cookie is required.',
      });
    }
    return { status: 'valid', checkedAt: new Date().toISOString() };
  }

  /**
   * The refusal worth making before a request is spent.
   *
   * An unknown or no-longer-free model is refused by name rather than sent: the service answers those with a
   * 400 or a 429, and each attempt costs the address's anonymous-chat quota. This checks the *live* catalog,
   * so a model that stopped being free fails here with the reason rather than at the service.
   */
  private async refuseUnsupported(request: ChatRequest, signal?: AbortSignal): Promise<string> {
    const requested = request.model || DUCKDUCKGO_WEB.defaultModel;
    if (request.toolChoice === 'required') {
      throw new ProviderError('NOT_SUPPORTED', 'Duck.ai cannot be told to force a tool call.', {
        providerId: this.id,
        publicMessage: 'Duck.ai answers in prose and has no way to force a tool call. Send `tool_choice: "auto"` or omit it.',
      });
    }

    let free: DuckDuckGoWebModel[] = [];
    try {
      free = freeDuckDuckGoWebModels(await this.driver.catalog({ timeoutMs: DUCKDUCKGO_WEB.catalogTimeoutMs, ...(signal ? { signal } : {}) }));
    } catch {
      // A catalog that cannot be read is not a reason to refuse a turn: the service decides, and a named
      // refusal here would be about this gateway rather than about the request.
      return requested;
    }

    if (free.length === 0) return requested;
    if (free.some((model) => model.id === requested)) return requested;

    const known = free.map((model) => model.id).join(', ');
    throw new ProviderError('NOT_SUPPORTED', `Duck.ai does not offer ${requested} on its free tier.`, {
      providerId: this.id,
      publicMessage: `Duck.ai serves ${known} free. ${requested} is not free on this account, and a request for it would be refused by the service.`,
    });
  }

  async chat(request: ChatRequest, context: ProviderRequestContext = {}): Promise<ChatResponse> {
    const model = await this.refuseUnsupported(request, context.signal);
    const cookieHeader = duckDuckGoWebCookieHeader(context.credential);
    const createdAt = new Date().toISOString();

    try {
      const { text, model: answered } = await this.driver.ask({
        ...(cookieHeader ? { cookieHeader } : {}),
        model,
        messages: request.messages.map((message) => ({ role: message.role, content: messageText(message.content) })),
        timeoutMs: DUCKDUCKGO_WEB.chatTimeoutMs,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      return {
        id: `duckduckgo-web-${Date.parse(createdAt)}`,
        providerId: this.id,
        model: answered || model,
        createdAt,
        message: { role: 'assistant', content: text },
        finishReason: 'stop',
      };
    } catch (error) {
      throw normalizeDuckDuckGoWebError(error, this.id);
    }
  }

  /** There is no stream. The whole answer is yielded once, honestly, rather than pretending. */
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

  /**
   * A credential check, and it says so.
   *
   * `verified: 'credential'` rather than `'inference'`: this reads whether the *endpoint answers and serves a
   * solvable challenge*, which is not the same claim as "a model can answer". Same distinction the whole
   * repository settled on in 1.40.0, and the reason the card's label is "Credential check".
   */
  async healthCheck(context: ProviderRequestContext = {}): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    try {
      await this.validateCredential(context.credential);
      const driver = await this.driver.available();
      if (!driver.ok) return { status: 'unavailable', verified: 'credential', checkedAt };
      const status = await this.driver.status({ timeoutMs: DUCKDUCKGO_WEB.statusTimeoutMs, ...(context.signal ? { signal: context.signal } : {}) });
      if (!status.challengeServed) {
        // `message` rather than an `errorCode`: `ProviderHealth` declares no code field, and inventing one
        // would be a value no consumer can read. The sentence is the part a person needs.
        return { status: 'degraded', verified: 'credential', checkedAt, message: 'Duck.ai answered without serving an anti-bot challenge.' };
      }
      return { status: 'healthy', verified: 'credential', checkedAt, latencyMs: status.solvedMs };
    } catch (error) {
      return {
        status: 'unavailable',
        verified: 'credential',
        checkedAt,
        message: error instanceof Error ? error.message : 'Duck.ai could not be reached.',
      };
    }
  }
}

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
 * A driver failure as a provider error.
 *
 * The classification is a **field**, not a pattern, because the service's own errors cannot be told apart by
 * their text: `ERR_CHALLENGE` and `ERR_BN_LIMIT` share a message token, and reading that token as prose would
 * classify a per-address quota as an expired challenge.
 *
 * - **`challenge`** — the challenge expired or was refused. Measured: a `418 ERR_CHALLENGE` appeared 43 s
 *   after a successful turn, and the byte-identical request succeeded 4.9 min later. So this is *not* retryable
 *   in a loop; it is "wait". The working implementation retried once with a fresh challenge, which spends a
 *   second call against the quota that just refused it.
 * - **`quota`** — `ERR_BN_LIMIT`. Not retryable, not the credential's fault, and it is about this address.
 * - **`rate-limit`** — `ERR_RATE_LIMIT`, the one the service marks retryable itself.
 * - **`bad-request`** — the request was malformed (a model that is not free, a missing field). Not retryable.
 * - **`unavailable`** — anything else, including a transport failure.
 */
export function normalizeDuckDuckGoWebError(error: unknown, providerId: string): ProviderError {
  if (error instanceof ProviderError) return error;

  const kind = error instanceof DuckDuckGoWebError ? error.kind : 'unavailable';
  const detail = error instanceof Error ? error.message : String(error);
  const override = error instanceof DuckDuckGoWebError && error.overrideCode ? ` (overrideCode ${error.overrideCode})` : '';

  const publicByKind: Record<DuckDuckGoWebError['kind'], string> = {
    challenge:
      'Duck.ai refused the request at its anti-bot check. That usually means too many requests from this address in a short window — waiting a few minutes is the fix, not retrying, and not re-pasting a cookie.',
    quota:
      'Duck.ai is refusing this address rather than this request. A pasted cookie can help and is optional; a request from a different address may work immediately.',
    'rate-limit': 'Duck.ai is rate limiting this address. Retrying later is the fix.',
    'bad-request': 'Duck.ai refused the request as malformed. See the message for which field.',
    unavailable:
      'Duck.ai could not be reached. If this is a network problem on the gateway host it will work again on its own; if it keeps happening, the service may have changed.',
  };

  const code = kind === 'rate-limit' || kind === 'unavailable' ? 'PROVIDER_REQUEST_FAILED' : kind === 'bad-request' ? 'INVALID_REQUEST' : 'PROVIDER_UNAVAILABLE';

  return new ProviderError(code, `Duck.ai could not complete the turn: ${detail}${override}`, {
    providerId,
    // Only the kind the service itself marks retryable is retried. Everything else would spend quota to be
    // refused again, which is what turns a short wait into a longer one.
    retryable: kind === 'rate-limit' || kind === 'unavailable',
    publicMessage: publicByKind[kind],
  });
}