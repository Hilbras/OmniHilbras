import { ProviderError } from '../errors.js';
import type { ChatMessage, ChatRequest, ChatResponse, CredentialValidation, FinishReason, Model, ProviderAdapter, ProviderCredential, ProviderHealth, ProviderId, ProviderRequestContext } from '../types.js';

/**
 * Token Harbor Web — the chat application at tokenharbor.ai, driven by the Supabase session
 * cookie a signed-in browser already holds.
 *
 * ## Read this before building on it
 *
 * Token Harbor's terms **prohibit** what this adapter does. Their product is itself a gateway,
 * and the metered API key is its architectural guardrail; driving the web chat with a harvested
 * session cookie routes around that guardrail. The two clauses that name it:
 *
 * > **Proxy Reselling:** Utilize the Service to construct a direct, white-labeled proxy
 * > alternative to Token Harbor without adding substantive unique value or without prior written
 * > enterprise authorization.
 * >
 * > ...designed to compromise the security, stability, or **architectural guardrails of the
 * > Token Harbor gateway**.
 *
 * There is a legitimate path — `https://tokenharbor.ai/v1` with a Bearer key, OpenAI-compatible,
 * documented, and free on the `:free` models — and it is the card beside this one. This adapter
 * exists because the operator asked for the session-cookie route with that trade stated, and it
 * carries the same warning in the dashboard catalog (`riskSeverity: 'high'`) so a user meets it
 * before pasting a credential. It is the same shape as the Kiro notice: the vendor's terms and
 * the gateway's behaviour are both on the card, and using it is the user's decision to make.
 *
 * ## What the credential is
 *
 * Auth is Supabase (`auth.tokenharbor.ai`), so the browser cookie is `sb-<ref>-auth-token`,
 * where `<ref>` is the first label of the Supabase host — `auth`, giving `sb-auth-auth-token`.
 * Above Supabase's size limit the value is split into `sb-...-auth-token.0`, `.1`, ... and the
 * chunks are reassembled in order. It is written with `document.cookie`, so unlike ChatGPT Web's
 * `HttpOnly` session it can be read from the Application panel or the Network tab's Cookie
 * header — which is why the guide offers both.
 *
 * ## The wire format is not OpenAI's, and that is the whole adapter
 *
 * A turn is two requests and a decode:
 *
 * 1. `POST /api/direct-chat/sessions` with `{ model, temporary: true }` → `{ session: { id } }`.
 *    `temporary` is sent so a stateless gateway does not litter the user's sidebar with a
 *    conversation per request.
 * 2. `POST /api/direct-chat/stream` with `{ sessionId, content, model, webSearch, tz }` → an SSE
 *    body whose events are **named**, not OpenAI's `choices[].delta`:
 *    `chunk` (the answer text in `delta`), `thinking` (reasoning in `delta`), `tool_use`,
 *    `citation`, `image`, `file`, `miniapp`, and `done`. `error` carries `{ code, message }`.
 *
 * Only `chunk`, `thinking`, `done` and `error` are consumed. The others are attachments and
 * citations for a UI, and inventing an OpenAI shape for them here would be guessing at a
 * contract this adapter cannot test without the session.
 *
 * ## What is not claimed
 *
 * `capabilities.streaming` is false and no `streamChat` is implemented: the transport is SSE,
 * but the gateway consumes the whole body and returns one completion. A streaming surface would
 * need the chunk boundary semantics verified against a live session first.
 *
 * `healthCheck` reports `verified: 'credential'`. It reads `/api/me/profile`, which proves the
 * session cookie is accepted and nothing more — the same distinction the type exists to force.
 */

export const tokenHarborWebProviderId: ProviderId = 'tokenharbor-web';

const WEB_ORIGIN = 'https://tokenharbor.ai';
const API_BASE = `${WEB_ORIGIN}/api`;
const PROFILE_URL = `${API_BASE}/me/profile`;
const SESSIONS_URL = `${API_BASE}/direct-chat/sessions`;
const STREAM_URL = `${API_BASE}/direct-chat/stream`;
const DEFAULT_CHAT_MODEL = 'th-rudder:free';

/** The cookie prefix Supabase mints on the `auth` host. Chunks append `.0`, `.1`, ... */
const SESSION_COOKIE_PREFIX = 'sb-auth-auth-token';

/**
 * Headers the web client's own fetch carries without thinking about it.
 *
 * Same-origin `fetch` attaches the cookies and sends an `Origin` for free; from Node both have to
 * be stated. They are not a bot-defeating bluff — Cloudflare sits in front of this host, and a
 * request with no `Origin`, no `Referer` and Node's default `User-Agent` is the shape a challenge
 * is meant to stop. What is sent here is what a browser at this origin sends.
 */
const FINGERPRINT_HEADERS: Readonly<Record<string, string>> = {
  Accept: 'text/event-stream, application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: WEB_ORIGIN,
  Referer: `${WEB_ORIGIN}/chat`,
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
};

export const TOKENHARBOR_WEB = {
  origin: WEB_ORIGIN,
  apiBase: API_BASE,
  profileUrl: PROFILE_URL,
  sessionsUrl: SESSIONS_URL,
  streamUrl: STREAM_URL,
  cookiePrefix: SESSION_COOKIE_PREFIX,
  defaultModel: DEFAULT_CHAT_MODEL,
  /** The page a user signs in on and copies the cookie from. */
  signInUrl: `${WEB_ORIGIN}/login`,
} as const;

/**
 * The catalog, read from `https://tokenharbor.ai/models` on 2026-10-07.
 *
 * A dated snapshot rather than a promise: the page is the live list and this is what it showed.
 * Prices are per 1M tokens, which is the unit the SDK normalises to and the unit the page itself
 * prints. The two `:free` ids are the ones that bill nothing.
 *
 * No context window is claimed because the page publishes none.
 */
export const TOKENHARBOR_WEB_MODELS: ReadonlyArray<{
  id: string;
  label: string;
  family: string;
  inputPer1M: number;
  outputPer1M: number;
}> = [
  { id: 'th-rudder:free', label: 'TH-Rudder', family: 'tokenharbor', inputPer1M: 0, outputPer1M: 0 },
  { id: 'claude-fable-5.1', label: 'Claude Fable 5.1', family: 'anthropic', inputPer1M: 10, outputPer1M: 50 },
  { id: 'claude-opus-5.5', label: 'Claude Opus 5.5', family: 'anthropic', inputPer1M: 4, outputPer1M: 20 },
  { id: 'claude-sonnet-5.5', label: 'Claude Sonnet 5.5', family: 'anthropic', inputPer1M: 2, outputPer1M: 10 },
  { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', family: 'deepseek', inputPer1M: 0.3, outputPer1M: 1.2 },
  { id: 'deepseek-v4.1-flash:free', label: 'DeepSeek V4.1 Flash', family: 'deepseek', inputPer1M: 0, outputPer1M: 0 },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', family: 'google', inputPer1M: 0.75, outputPer1M: 3.75 },
  { id: 'glm-5.3', label: 'GLM-5.3', family: 'z-ai', inputPer1M: 1.4, outputPer1M: 4.4 },
  { id: 'glm-5.3-flash', label: 'GLM 5.3 Flash', family: 'z-ai', inputPer1M: 0.15, outputPer1M: 0.5 },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', family: 'openai', inputPer1M: 10, outputPer1M: 50 },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', family: 'openai', inputPer1M: 0.1, outputPer1M: 0.5 },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', family: 'openai', inputPer1M: 2, outputPer1M: 10 },
  { id: 'grok-4.7', label: 'Grok 4.7', family: 'xai', inputPer1M: 2, outputPer1M: 6 },
  { id: 'kimi-k3', label: 'Kimi K3', family: 'kimi', inputPer1M: 3, outputPer1M: 15 },
  { id: 'mimo-v2.6-flash', label: 'MiMo V2.6 Flash', family: 'xiaomi', inputPer1M: 0.14, outputPer1M: 1.28 },
  { id: 'mimo-v2.6-flash:free', label: 'MiMo V2.6 Flash', family: 'xiaomi', inputPer1M: 0, outputPer1M: 0 },
  { id: 'mimo-v2.6-pro', label: 'MiMo V2.6 Pro', family: 'xiaomi', inputPer1M: 0.435, outputPer1M: 0.87 },
  { id: 'mistral-large-2512', label: 'Mistral Large 2512', family: 'mistral', inputPer1M: 0.68, outputPer1M: 2.09 },
  { id: 'muse-spark-1-3', label: 'Muse Spark 1.3', family: 'meta', inputPer1M: 1.25, outputPer1M: 4.25 },
  { id: 'qwen3.8-27b', label: 'Qwen3.8 27B', family: 'qwen', inputPer1M: 0.35, outputPer1M: 2.1 },
  { id: 'qwen3.8-flash', label: 'Qwen3.8 Flash', family: 'qwen', inputPer1M: 0.15, outputPer1M: 0.47 },
  { id: 'qwen3.8-max', label: 'Qwen3.8 Max', family: 'qwen', inputPer1M: 2, outputPer1M: 6 },
];

export function allTokenHarborWebModels(): string[] {
  return TOKENHARBOR_WEB_MODELS.map((model) => model.id);
}

function lookupModel(id: string) {
  const wanted = id.trim().toLowerCase();
  return TOKENHARBOR_WEB_MODELS.find((model) => model.id.toLowerCase() === wanted);
}

/** One place to build a provider error, so every failure carries the id and a safe public message. */
function fail(code: ProviderError['code'], message: string, options: { retryable?: boolean; publicMessage?: string } = {}): ProviderError {
  return new ProviderError(code, message, {
    providerId: tokenHarborWebProviderId,
    retryable: options.retryable ?? false,
    publicMessage: options.publicMessage ?? message,
  });
}

/**
 * Reads the Supabase session cookie out of whatever the user pasted.
 *
 * Two pastes are accepted, because both are things the guide tells people to copy:
 *
 * - the whole `Cookie:` request header (space for the Cloudflare clearance and the other cookies
 *   the SSR layer reads), and
 * - just the `sb-auth-auth-token` value or the `sb-auth-auth-token=...` pair, from the
 *   Application panel.
 *
 * The chunks are **joined in numeric order**, which is not the order they appear in a header:
 * a large token is stored as `.0`, `.1`, ... and a header that happens to list `.1` before `.0`
 * would otherwise reassemble to a garbage session that fails later as an unexplained refusal.
 */
export function parseTokenHarborCookieHeader(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw fail('INVALID_REQUEST', 'Paste the Cookie header or the sb-auth-auth-token value from tokenharbor.ai.', {
      publicMessage: 'Paste the Cookie header or the sb-auth-auth-token value from tokenharbor.ai.',
    });
  }

  // A bare value (no `;`, no `name=`) is the Application panel's single-field copy. Supabase v2
  // stores the session as `base64-<...>`, which is the shape that identifies it as the session
  // rather than one of the sibling cookies; a bare value that is neither that nor the name=value
  // pair is refused rather than guessed at.
  const looksLikeHeader = trimmed.includes(';') || /(?:^|[\s;])[A-Za-z0-9_.-]+=/.test(trimmed);
  if (!looksLikeHeader) {
    if (trimmed.startsWith(`${SESSION_COOKIE_PREFIX}=`)) return trimmed;
    if (trimmed.startsWith(SESSION_COOKIE_PREFIX)) return `${SESSION_COOKIE_PREFIX}=${trimmed.slice(SESSION_COOKIE_PREFIX.length).replace(/^=/, '')}`;
    if (trimmed.startsWith('base64-')) return `${SESSION_COOKIE_PREFIX}=${trimmed}`;
    throw fail(
      'INVALID_REQUEST',
      `That does not look like a Token Harbor session cookie. It should start with "${SESSION_COOKIE_PREFIX}" or "base64-".`,
    );
  }

  const pairs = new Map<string, string>();
  const order: string[] = [];
  for (const part of trimmed.split(';')) {
    const piece = part.trim();
    if (!piece) continue;
    const eq = piece.indexOf('=');
    if (eq < 0) continue;
    const name = piece.slice(0, eq).trim();
    const value = piece.slice(eq + 1).trim();
    if (!name) continue;
    if (!pairs.has(name)) order.push(name);
    pairs.set(name, value);
  }

  const chunkNames = order
    .filter((name) => name === SESSION_COOKIE_PREFIX || name.startsWith(`${SESSION_COOKIE_PREFIX}.`))
    .sort((a, b) => chunkIndex(a, SESSION_COOKIE_PREFIX) - chunkIndex(b, SESSION_COOKIE_PREFIX));

  if (chunkNames.length === 0) {
    throw fail(
      'INVALID_REQUEST',
      `That Cookie header carries no "${SESSION_COOKIE_PREFIX}" cookie. Sign in at tokenharbor.ai and copy it again.`,
    );
  }

  const session = chunkNames.map((name) => pairs.get(name) ?? '').join('');
  if (!session) {
    throw fail('AUTHENTICATION_FAILED', `The "${SESSION_COOKIE_PREFIX}" cookie is empty, which is what the browser stores when you are signed out. Sign in at tokenharbor.ai and copy it again.`);
  }

  /**
   * **A truncated paste is refused here, by name, rather than forwarded.**
   *
   * Supabase stores `base64-<base64url(JSON session)>`. A session is long, and the two ways people
   * paste one — selecting a single Application-panel row, or copying a wrapped header line —
   * routinely cut it short. A cut-short value is forwarded as a cookie, Token Harbor answers 401,
   * and the user is told to sign in again for a paste that never finished. That is exactly the
   * fault the DeepSeek parser was fixed for (`{"value":null}` treated as a token), one provider
   * over: **the most likely bad paste is answered as the wrong problem.**
   *
   * Decoding is pure Web APIs (`atob`), which the SDK is allowed to reach for, so this adds no
   * Node builtin to a module the dashboard imports.
   */
  const problem = sessionValueProblem(session);
  if (problem) throw fail('INVALID_REQUEST', problem);

  // Keep every non-chunk cookie the paste carried — the SSR layer reads the clearance and the
  // rest — and replace the chunks with the single reassembled value.
  const kept = order
    .filter((name) => name !== SESSION_COOKIE_PREFIX && !name.startsWith(`${SESSION_COOKIE_PREFIX}.`))
    .map((name) => `${name}=${pairs.get(name) ?? ''}`);
  return [...kept, `${SESSION_COOKIE_PREFIX}=${session}`].join('; ');
}

function chunkIndex(name: string, prefix: string): number {
  if (name === prefix) return 0;
  const suffix = Number(name.slice(prefix.length + 1));
  return Number.isFinite(suffix) ? suffix + 1 : Number.MAX_SAFE_INTEGER;
}

/** `base64-` is Supabase's `base64url` cookie encoding, and the prefix their own decoder strips. */
const SESSION_VALUE_PREFIX = 'base64-';

function base64UrlDecodeToString(value: string): string | undefined {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    // `atob` yields latin1; the JSON is UTF-8, so the bytes are re-decoded rather than mangled.
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Decodes the session cookie and reports what is wrong with it, or `undefined` when it is intact.
 *
 * Returns a sentence rather than a boolean because the two failures need different instructions: a
 * value that does not decode is a **truncated paste**, and a value that decodes but carries no
 * access token is a **shape this adapter does not recognise**. "Sign in again" is wrong for the
 * first — the session is fine, the paste was short.
 */
export function sessionValueProblem(session: string): string | undefined {
  if (!session.startsWith(SESSION_VALUE_PREFIX)) {
    // Not base64url. It may still be a session this service accepts, so it is not refused — but a
    // value that is neither `base64-` nor obviously a JWT is worth naming, because the paste
    // instructions describe the `base64-` form.
    return session.split('.').length === 3
      ? undefined
      : `That session value is not in the shape tokenharbor.ai stores it in — it should start with "${SESSION_VALUE_PREFIX}". Copy the whole value of the cookie, or the whole Cookie header.`;
  }
  const decoded = base64UrlDecodeToString(session.slice(SESSION_VALUE_PREFIX.length));
  if (decoded === undefined) {
    return `That session cookie is not valid base64, which almost always means the paste was cut short. Select the entire cookie value — it is long, and a partially copied one is refused here rather than sent and reported as a dead session.`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return `That session cookie was cut short: it decodes to something that is not complete JSON. Copy the whole cookie value (or the whole Cookie header) and paste it again — the session itself is probably fine.`;
  }
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as { access_token?: unknown }).access_token !== 'string') {
    return `That cookie decodes, but it carries no access token, so this adapter does not recognise it as a Token Harbor session. Confirm you copied the cookie named "${SESSION_COOKIE_PREFIX}".`;
  }
  return undefined;
}

/** The `expires_at` epoch seconds inside the session, when it is one this adapter can read.
 *
 * Accepts either the bare value or a whole Cookie header, because the two callers have different
 * shapes in hand: the parser has the value, the refusal path has the assembled header.
 */
export function sessionExpiresAt(sessionOrCookie: string): number | undefined {
  const session = sessionValueFrom(sessionOrCookie);
  if (session === undefined) return undefined;
  const decoded = base64UrlDecodeToString(session.slice(SESSION_VALUE_PREFIX.length));
  if (decoded === undefined) return undefined;
  try {
    const parsed = JSON.parse(decoded) as { expires_at?: unknown };
    return typeof parsed.expires_at === 'number' ? parsed.expires_at : undefined;
  } catch {
    return undefined;
  }
}

/** The `sb-auth-auth-token` value, from a bare value or a whole Cookie header. */
function sessionValueFrom(sessionOrCookie: string): string | undefined {
  const trimmed = sessionOrCookie.trim();
  if (trimmed.startsWith(SESSION_VALUE_PREFIX)) return trimmed;
  const match = trimmed.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_PREFIX}=([^;]+)`));
  return match?.[1]?.trim() ?? undefined;
}

export function tokenHarborWebCredential(raw: string): ProviderCredential {
  return { type: 'api-key', value: parseTokenHarborCookieHeader(raw) };
}

export function tokenHarborWebCookieFromCredential(credential: ProviderCredential | undefined): string {
  if (!credential || credential.type !== 'api-key' || !credential.value.trim()) {
    throw fail('AUTHENTICATION_FAILED', 'This Token Harbor Web connection has no session cookie. Sign in again and paste a fresh one.', {
      publicMessage: 'This Token Harbor Web connection has no session cookie. Sign in again and paste a fresh one.',
    });
  }
  return credential.value.trim();
}

/** Turns a non-ok status into the refusal it actually is, rather than one blanket code. */
function refusalFor(status: number, what: string, session?: string): ProviderError {
  if (status === 401 || status === 403) {
    // Read the expiry out of the pasted session so the sentence distinguishes the two cases a
    // 401 covers. Telling somebody to sign in again when nothing is wrong with the session sends
    // them round a loop; telling them the session is fine when it expired wastes the same trip.
    const expiresAt = session ? sessionExpiresAt(session) : undefined;
    const expired = expiresAt !== undefined && expiresAt * 1000 <= Date.now();
    const who = expired
      ? `The pasted session expired at ${new Date(expiresAt! * 1000).toISOString()}. Sign in at tokenharbor.ai and copy a fresh cookie.`
      : 'Sign in at tokenharbor.ai again and paste a fresh cookie. A 403 can also be Cloudflare refusing the request rather than the session being dead.';
    return fail(
      'AUTHENTICATION_FAILED',
      `Token Harbor refused this session while ${what} (${status}). ${who}`,
    );
  }
  if (status === 429) {
    return fail('RATE_LIMITED', `Token Harbor is rate limiting this session (${status}) while ${what}.`, { retryable: true });
  }
  if (status === 402) {
    return fail('PROVIDER_REQUEST_FAILED', `Token Harbor refused ${what}: the account has no balance for this model (402). The ":free" models do not bill.`);
  }
  return fail('PROVIDER_UNAVAILABLE', `Token Harbor answered ${status} while ${what}.`, { retryable: status >= 500 });
}

export class TokenHarborWebAdapter implements ProviderAdapter {
  readonly id = tokenHarborWebProviderId;
  readonly name = 'Token Harbor Web';
  readonly capabilities = { chat: true, models: true } as const;

  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { now?: () => number; fetch?: typeof fetch } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetch ?? fetch;
  }

  /**
   * The dated catalog above, not a request.
   *
   * Token Harbor publishes no public models JSON — the live list is rendered into the `/models`
   * page — so there is nothing to read without a session, and an authenticated read per call
   * would be a cost for a list that changes weekly. The snapshot is what the page showed on the
   * date beside it, and the free-only policy narrows it the way the dialog's checkbox promises.
   */
  listModels(context: ProviderRequestContext = {}): Promise<Model[]> {
    const freeOnly = context.importPolicy === 'free';
    return Promise.resolve(
      TOKENHARBOR_WEB_MODELS.filter((model) => !freeOnly || model.id.endsWith(':free')).map((model) => ({
        id: model.id,
        providerId: this.id,
        displayName: model.label,
        ownedBy: model.family,
        pricing: { inputPer1M: model.inputPer1M, outputPer1M: model.outputPer1M },
      })),
    );
  }

  /**
   * A real round trip to `/api/me/profile`, which answers `{ ok: false }` with a 401 to a session
   * it does not recognise. That is the cheapest endpoint that proves the cookie is accepted, and
   * it is the whole of what this establishes — see `healthCheck`.
   */
  async validateCredential(credential: ProviderCredential | undefined, context: ProviderRequestContext = {}): Promise<CredentialValidation> {
    const cookie = tokenHarborWebCookieFromCredential(credential);
    const startedAt = this.now();
    const response = await this.request(PROFILE_URL, { method: 'GET', cookie, signal: context.signal });
    if (!response.ok) throw refusalFor(response.status, 'checking the session', cookie);
    return { status: 'valid', checkedAt: new Date(this.now()).toISOString(), latencyMs: this.now() - startedAt };
  }

  /**
   * `verified: 'credential'` — deliberately.
   *
   * Reading the profile proves the cookie is live; it says nothing about whether a model can
   * answer. Claiming `inference` would need a real turn on every 60-second poll, which is a real
   * request against someone else's service on a timer, and the type exists precisely so this
   * distinction is stated rather than implied.
   */
  async healthCheck(context: ProviderRequestContext = {}): Promise<ProviderHealth> {
    try {
      await this.validateCredential(context.credential, context);
      return { status: 'healthy', verified: 'credential', checkedAt: new Date(this.now()).toISOString() };
    } catch (error) {
      return {
        status: 'unavailable',
        verified: 'credential',
        checkedAt: new Date(this.now()).toISOString(),
        message: error instanceof Error ? error.message : 'The Token Harbor Web session could not be checked.',
      };
    }
  }

  async chat(request: ChatRequest, context: ProviderRequestContext = {}): Promise<ChatResponse> {
    const wanted = request.model?.trim() || DEFAULT_CHAT_MODEL;
    const model = lookupModel(wanted);
    if (!model) {
      throw fail('NOT_SUPPORTED', `Token Harbor Web does not offer a model called ${wanted}.`, {
        publicMessage: `Token Harbor Web does not offer a model called ${wanted}. The models it serves are the ones on this page.`,
      });
    }
    const cookie = tokenHarborWebCookieFromCredential(context.credential);

    const sessionId = await this.createSession(model.id, cookie, context.signal);

    // The stream endpoint takes one `content` string, so the conversation is flattened into it.
    // A fresh temporary session per request holds no history server-side, so nothing is doubled.
    const content = flattenMessages(request.messages);
    if (!content) throw fail('INVALID_REQUEST', 'There is no message to send to Token Harbor Web.');

    const response = await this.request(STREAM_URL, {
      method: 'POST',
      cookie,
      signal: context.signal,
      body: {
        sessionId,
        content,
        model: model.id,
        webSearch: 'auto',
        tz: timeZone(),
      },
    });
    if (!response.ok) throw refusalFor(response.status, 'answering the completion', cookie);

    const answer = decodeTokenHarborStream(await readBodyCapped(response));
    if (answer.error) {
      throw fail(
        answer.error.code === 'unauthorized' ? 'AUTHENTICATION_FAILED' : 'PROVIDER_REQUEST_FAILED',
        `Token Harbor refused the turn: ${answer.error.message}`,
      );
    }
    if (!answer.content && !answer.reasoning) {
      throw fail('PROVIDER_REQUEST_FAILED', 'Token Harbor answered, but the stream carried no text. Its response format may have changed.');
    }
    if (!answer.finished) {
      // A body that closes without `done` was cut off mid-generation. Reporting the fragment as a
      // clean `stop` is the worst version: it looks like a model that finished and the ending is
      // silently missing.
      throw fail(
        'PROVIDER_REQUEST_FAILED',
        `Token Harbor's stream ended before it finished — the answer was cut off after ${answer.content.length} characters. This is usually a dropped connection or an expired session. Try again.`,
      );
    }

    const message: ChatMessage = {
      role: 'assistant',
      content: answer.content,
      ...(answer.reasoning ? { reasoningContent: answer.reasoning } : {}),
    };
    return {
      id: `chatcmpl-${Math.floor(this.now() / 1000)}-${Math.random().toString(36).slice(2, 8)}`,
      providerId: this.id,
      model: model.id,
      createdAt: new Date(this.now()).toISOString(),
      message,
      finishReason: 'stop' satisfies FinishReason,
    };
  }

  private async createSession(model: string, cookie: string, signal: AbortSignal | undefined): Promise<string> {
    const response = await this.request(SESSIONS_URL, {
      method: 'POST',
      cookie,
      signal,
      // `temporary` keeps the conversation out of the user's sidebar: a gateway request is not a
      // chat they opened, and one row per API call is a side effect nobody asked for.
      body: { model, temporary: true },
    });
    if (!response.ok) throw refusalFor(response.status, 'starting a chat session', cookie);
    const json = (await response.json().catch(() => ({}))) as { session?: { id?: unknown } };
    const id = json.session?.id;
    if (typeof id !== 'string' || !id) throw fail('PROVIDER_REQUEST_FAILED', 'Token Harbor started no chat session.');
    return id;
  }

  private request(url: string, options: { method: string; cookie: string; signal?: AbortSignal; body?: unknown }): Promise<Response> {
    return this.fetchImpl(url, {
      method: options.method,
      headers: {
        ...FINGERPRINT_HEADERS,
        Cookie: options.cookie,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }
}

function timeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part) return String((part as { text?: unknown }).text ?? '');
      return '';
    })
    .join('');
}

/**
 * Flattens the message list into the single `content` string the endpoint takes.
 *
 * Labelled rather than concatenated: a bare join of `["You are terse.", "2+2?"]` loses which was
 * which, and the model then answers as if the instruction were part of the question.
 */
export function flattenMessages(messages: readonly ChatMessage[]): string {
  const kept = messages
    .map((message) => ({ role: message.role, text: messageText(message.content).trim() }))
    .filter((message) => message.text);
  const system = kept.filter((message) => message.role === 'system');
  const rest = kept.filter((message) => message.role !== 'system');
  const lines: string[] = [];
  if (system.length > 0) lines.push('Follow these instructions:', ...system.map((message) => `- ${message.text}`), '');
  for (const message of rest) {
    lines.push(`${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.text}`);
  }
  return lines.join('\n').trim();
}

/**
 * Reads a completed answer out of Token Harbor's named-event SSE body.
 *
 * The client's own parser is the source of truth for the shapes, and it is not OpenAI's:
 *
 * ```text
 * event: chunk
 * data: {"delta":"working"}
 *
 * event: thinking
 * data: {"delta":"..."}
 *
 * event: done
 * data: {}
 * ```
 *
 * `chunk` is the answer text and `thinking` is the reasoning, split into their own events — so a
 * model that thinks before answering does not have its reasoning read as the reply. `error`
 * carries `{ code, message }` and is returned rather than thrown so the caller can name the code.
 *
 * **`done` is what makes a truncated body detectable.** A stream that closes without it was cut
 * off, and the caller reports that instead of handing back half an answer labelled complete.
 */
export function decodeTokenHarborStream(body: string): { content: string; reasoning: string; finished: boolean; error?: { code: string; message: string } } {
  let content = '';
  let reasoning = '';
  let finished = false;
  let error: { code: string; message: string } | undefined;

  for (const block of body.split('\n\n')) {
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) {
      if (event === 'done') finished = true;
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event === 'error') {
      error = {
        code: typeof parsed.code === 'string' ? parsed.code : 'error',
        message: typeof parsed.message === 'string' ? parsed.message : 'Token Harbor refused the turn.',
      };
      continue;
    }
    const delta = typeof parsed.delta === 'string' ? parsed.delta : '';
    if (!delta) {
      if (event === 'done') finished = true;
      continue;
    }
    if (event === 'thinking') reasoning += delta;
    else if (event === 'chunk') content += delta;
    if (event === 'done') finished = true;
  }

  return { content, reasoning, finished, ...(error ? { error } : {}) };
}

/**
 * Reads the body with a hard cap.
 *
 * An SSE body from a proxy that never closes is an unbounded read, and a cap that silently
 * truncates is worse than one that refuses — so the cap throws and the caller reports it.
 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

async function readBodyCapped(response: Response): Promise<string> {
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_RESPONSE_BYTES) {
    throw fail('PROVIDER_REQUEST_FAILED', `Token Harbor's reply exceeded ${MAX_RESPONSE_BYTES} bytes and was refused rather than truncated.`);
  }
  return new TextDecoder().decode(buffer);
}