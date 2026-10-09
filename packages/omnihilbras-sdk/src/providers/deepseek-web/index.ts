import { ProviderError } from '../../core/errors.js';
import type { ChatMessage, ChatRequest, ChatResponse, CredentialValidation, FinishReason, Model, ProviderAdapter, ProviderCredential, ProviderHealth, ProviderId, ProviderRequestContext } from '../../core/types.js';
import { MAX_DEEPSEEK_POW_DIFFICULTY, findDeepSeekPowNonce } from './deepseek-pow.js';

/**
 * DeepSeek Web, driven by a `userToken` from a signed-in chat.deepseek.com.
 *
 * **No browser is needed for a turn.** The web client is an HTTP API behind a session token,
 * so unlike ChatGPT Web this is a normal fetch with a bearer credential. A browser is only
 * involved in *getting* the token, which the gateway does in a visible sign-in window.
 *
 * That difference is why this provider exists as it does: the fragile parts of a web-session
 * provider are all in obtaining the credential, and the request path is plain.
 *
 * Two things make the request path non-obvious, and both are load-bearing:
 *
 *  - **The token is exchanged, not used.** `userToken` only authorises `users/current`,
 *    which hands back a short-lived `accessToken` for everything else. Sending the userToken
 *    at the completion endpoint gets a 401 that looks like an expired session.
 *  - **Every completion is gated by a proof of work** — see `deepseek-pow.ts`. It is a
 *    bounded search, not a wall, and the answer goes in `X-Ds-Pow-Response`.
 */

export const deepseekWebProviderId: ProviderId = 'deepseek-web';

const WEB_ORIGIN = 'https://chat.deepseek.com';
const API_BASE = `${WEB_ORIGIN}/api`;
const COMPLETION_URL = `${API_BASE}/v0/chat/completion`;

/**
 * The fingerprint the web client sends on every `/api/v0/*` call.
 *
 * The header set is a bot-detection signal in itself, not decoration: the 2.0.0 web build
 * dropped `X-App-Version` and added `X-Client-Bundle-Id`, so sending the *stale* stamp is
 * itself suspicious. These are the ones the current build sends.
 *
 * `x-hif-leim`, a signed client-attestation token from obfuscated JS, is deliberately
 * omitted — reproducing it means porting that JS, and the completion endpoint does not
 * currently require it. If it ever does, requests will fail with a 401 that says nothing
 * about attestation, which is when to come back to it.
 */
const FINGERPRINT_HEADERS: Readonly<Record<string, string>> = {
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: WEB_ORIGIN,
  Referer: `${WEB_ORIGIN}/`,
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  'X-Client-Bundle-Id': 'com.deepseek.chat',
  'X-Client-Locale': 'en-US',
  'X-Client-Platform': 'web',
  'X-Client-Version': '2.0.0',
};

export const DEEPSEEK_WEB = {
  origin: WEB_ORIGIN,
  apiBase: API_BASE,
  /** The localStorage key the web client keeps its session token under. */
  tokenStorageKey: 'userToken',
  navigationTimeoutMs: 60_000,
} as const;

/**
 * The models chat.deepseek.com serves.
 *
 * Two axes, and both are in the id rather than a separate parameter: `think` and `search`
 * are model variants the page offers, not request options. A Pro model is `model_type:
 * "expert"`; everything else is `"default"`.
 */
const DEEPSEEK_WEB_MODELS: ReadonlyArray<{ id: string; name: string; expert: boolean; thinking: boolean; search: boolean }> = [
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', expert: true, thinking: false, search: false },
  { id: 'deepseek-v4-pro-think', name: 'DeepSeek V4 Pro Think', expert: true, thinking: true, search: false },
  { id: 'deepseek-v4-pro-search', name: 'DeepSeek V4 Pro Search', expert: true, thinking: false, search: true },
  { id: 'deepseek-v4-pro-think-search', name: 'DeepSeek V4 Pro Think+Search', expert: true, thinking: true, search: true },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', expert: false, thinking: false, search: false },
  { id: 'deepseek-v4-flash-think', name: 'DeepSeek V4 Flash Think', expert: false, thinking: true, search: false },
  { id: 'deepseek-v4-flash-search', name: 'DeepSeek V4 Flash Search', expert: false, thinking: false, search: true },
  { id: 'deepseek-v4-flash-think-search', name: 'DeepSeek V4 Flash Think+Search', expert: false, thinking: true, search: true },
  { id: 'deepseek-chat', name: 'DeepSeek Chat', expert: false, thinking: false, search: false },
  { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', expert: false, thinking: true, search: false },
  { id: 'DeepSeek-R1', name: 'DeepSeek R1', expert: false, thinking: true, search: false },
  { id: 'DeepSeek-R1-Search', name: 'DeepSeek R1 Search', expert: false, thinking: true, search: true },
  { id: 'DeepSeek-V3.2', name: 'DeepSeek V3.2', expert: false, thinking: false, search: false },
  { id: 'DeepSeek-Search', name: 'DeepSeek Search', expert: false, thinking: false, search: true },
];

/** Every id, plus the spelling variants that normalise to the same model. */
export function allDeepSeekWebModels(): string[] {
  return DEEPSEEK_WEB_MODELS.map((model) => model.id);
}

function lookupModel(id: string) {
  const wanted = id.trim().toLowerCase();
  return DEEPSEEK_WEB_MODELS.find((model) => model.id.toLowerCase() === wanted);
}

/**
 * Reads the token out of whatever the user pasted.
 *
 * DeepSeek stores it as `{"value":"…"}`, so a copy out of localStorage is sometimes the
 * wrapper and sometimes the bare string. Accepting both is the difference between "paste it"
 * working and "paste it" working only if you know to unwrap it first.
 */
export function parseDeepSeekUserToken(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ProviderError('INVALID_REQUEST', 'Paste the userToken from chat.deepseek.com.', {
      providerId: deepseekWebProviderId,
      publicMessage: 'Paste the userToken from chat.deepseek.com.',
    });
  }
  if (trimmed.startsWith('{')) {
    /**
     * The wrapper is `{"value":"…","__version":N}` — and **signed out it is
     * `{"value":null}`**, which is exactly what a page that is not signed in stores.
     *
     * Falling through to "treat the raw string as the token" turned that null wrapper into a
     * credential: it looked like a token, it was accepted, and the failure surfaced much later
     * as DeepSeek refusing a session nobody could explain. An empty value is the single most
     * likely thing to be handed here, so it is named rather than passed along.
     */
    let parsed: { value?: unknown };
    try {
      parsed = JSON.parse(trimmed) as { value?: unknown };
    } catch {
      // Not the wrapper at all; a bare token is fine.
      return trimmed;
    }
    if (typeof parsed.value === 'string' && parsed.value.trim()) return parsed.value.trim();
    // No `value` key at all means this was never the wrapper — some other object, pasted by
    // mistake or from somewhere else. That is not the signed-out state, so it is used as-is
    // rather than being told to sign in.
    if (!('value' in parsed)) return trimmed;
    const message =
      'That userToken is empty, which is what chat.deepseek.com stores when you are not signed in. Open chat.deepseek.com, sign in, and copy it again.';
    throw new ProviderError('AUTHENTICATION_FAILED', message, {
      providerId: deepseekWebProviderId,
      publicMessage: message,
    });
  }
  return trimmed;
}

export function deepSeekWebCredential(raw: string): ProviderCredential {
  return { type: 'api-key', value: parseDeepSeekUserToken(raw) };
}

/**
 * Turns a non-ok status into the refusal it actually is.
 *
 * Every endpoint in this adapter's four-step flow goes through here, because the alternative was
 * the bug this replaces: `users/current` and `completion` mapped 401 to `AUTHENTICATION_FAILED`
 * while `create_pow_challenge` and `chat_session/create` mapped the *same* 401 to
 * `PROVIDER_UNAVAILABLE`. Which branch a user hit therefore depended on whether the access token
 * happened to be cached — invisible state deciding whether a dead session reads as "sign in again"
 * or as "the provider is down".
 *
 * The second mapping is the costly one. `PROVIDER_UNAVAILABLE` is retryable, so the router would
 * fail over to another provider for a session that can never recover, and the dashboard would show
 * a provider outage where the truth is an expired cookie.
 */
function refusalFor(status: number, what: string, onExpired?: () => void) {
  if (status === 401 || status === 403) {
    // The cached token is known bad now, so dropping it stops the next request from being sent
    // with a credential the provider has already refused.
    onExpired?.();
    return fail(
      'AUTHENTICATION_FAILED',
      `DeepSeek refused this session while ${what} (${status}). Sign in to chat.deepseek.com again and export a fresh userToken.`,
    );
  }
  if (status === 429) {
    const message = `DeepSeek is rate limiting this session (${status}) while ${what}.`;
    return new ProviderError('RATE_LIMITED', message, { providerId: deepseekWebProviderId, publicMessage: message, retryable: true });
  }
  return fail('PROVIDER_UNAVAILABLE', `DeepSeek answered ${status} while ${what}.`);
}

function userTokenFromCredential(credential: ProviderCredential | undefined): string {
  if (!credential || credential.type !== 'api-key' || !credential.value.trim()) {
    throw new ProviderError('AUTHENTICATION_FAILED', 'This DeepSeek Web connection has no userToken.', {
      providerId: deepseekWebProviderId,
      publicMessage: 'This DeepSeek Web connection has no userToken. Sign in again.',
    });
  }
  return credential.value.trim();
}

/** One place to build a provider error, so every failure carries the id and the public message. */
function fail(code: ProviderError['code'], message: string): ProviderError {
  return new ProviderError(code, message, { providerId: deepseekWebProviderId, publicMessage: message });
}

/** DeepSeek wraps every response in `{ code, msg, data: { biz_data } }` and `code !== 0` means trouble. */
function unwrap(json: unknown, what: string): Record<string, unknown> {
  const body = (json ?? {}) as { code?: unknown; msg?: unknown; data?: { biz_data?: Record<string, unknown>; biz_msg?: string } };
  if (typeof body.code === 'number' && body.code !== 0) {
    const message = typeof body.msg === 'string' && body.msg ? body.msg : (body.data?.biz_msg ?? `error code ${body.code}`);
    throw fail('PROVIDER_REQUEST_FAILED', `DeepSeek rejected the ${what}: ${message}`);
  }
  const biz = body.data?.biz_data;
  if (!biz || typeof biz !== 'object') throw fail('PROVIDER_REQUEST_FAILED', `DeepSeek returned no data for the ${what}.`);
  return biz;
}

type AccessToken = { token: string; expiresAt: number };

export class DeepSeekWebAdapter implements ProviderAdapter {
  readonly id = deepseekWebProviderId;
  readonly name = 'DeepSeek Web';
  /**
   * Streaming is not claimed. The upstream answer is an SSE stream, but every artifact this
   * provider was built against describes a completed turn, and presenting a whole answer as
   * a stream would imply tokens arriving over time when none were observed doing so.
   */
  readonly capabilities = { chat: true, streaming: false, models: true } as const;

  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  /** Keyed by userToken, because the access token is per-account and lasts about an hour. */
  private readonly accessTokens = new Map<string, AccessToken>();

  constructor(options: { now?: () => number; fetch?: typeof fetch } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetch ?? fetch;
  }

  async listModels(): Promise<Model[]> {
    return DEEPSEEK_WEB_MODELS.map((model) => ({ id: model.id, providerId: this.id, displayName: model.name }));
  }

  async validateCredential(credential: ProviderCredential | undefined): Promise<CredentialValidation> {
    // A real call, because a token's only meaningful test is whether DeepSeek accepts it.
    // Cheap: `users/current` is a single round trip and needs no proof of work. It skips the
    // access-token cache, so "valid" means DeepSeek said so just now rather than an hour ago.
    await this.accessToken(userTokenFromCredential(credential), undefined, { fresh: true });
    return { status: 'valid', checkedAt: new Date(this.now()).toISOString() };
  }

  /**
   * Exchanges the userToken for a short-lived access token.
   *
   * The userToken authorises this call and nothing else. Cached for an hour because it is
   * the same value for every request in that window, and a turn otherwise spends two
   * round trips before it sends anything.
   *
   * `fresh` skips that cache, and only the health check asks for it. A cache makes the check
   * cheap, but it also makes it meaningless: the dashboard reported "healthy in 0 ms" from a
   * cache entry that proved nothing, which is the same fault as every other confident
   * unverified answer in this area — it looks like a successful check because something was
   * returned. The point of a health check is to learn whether the credential works *now*.
   */
  private async accessToken(userToken: string, signal?: AbortSignal, options: { fresh?: boolean } = {}): Promise<string> {
    const cached = this.accessTokens.get(userToken);
    if (!options.fresh && cached && cached.expiresAt > this.now()) return cached.token;

    const response = await this.fetchImpl(`${API_BASE}/v0/users/current`, {
      method: 'GET',
      headers: { ...FINGERPRINT_HEADERS, Authorization: `Bearer ${userToken}` },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      // The 401 here is a *user* token rather than an access token, and a token from another
      // account or a signed-out session looks exactly like a dead one, so this says so.
      if (response.status === 401 || response.status === 403) {
        throw fail(
          'AUTHENTICATION_FAILED',
          'DeepSeek rejected that userToken. Sign in to chat.deepseek.com again and export a fresh one — a token from another account or a signed-out session looks exactly like this.',
        );
      }
      throw refusalFor(response.status, 'exchanging the userToken for an access token');
    }

    const biz = unwrap(await response.json(), 'sign-in');
    const token = biz.token;
    if (typeof token !== 'string' || !token) {
      throw fail('AUTHENTICATION_FAILED', 'DeepSeek accepted the request but returned no access token.');
    }
    // A minute of slack, so a token cannot expire between the check and the request.
    this.accessTokens.set(userToken, { token, expiresAt: this.now() + 55 * 60_000 });
    return token;
  }

  /**
   * Solves a fresh proof of work for the completion endpoint.
   *
   * A challenge per completion, not per session: the answer is bound to the target path and
   * carries the challenge's own expiry, so caching one would be reusing spent work.
   */
  private async proofOfWork(accessToken: string, signal: AbortSignal | undefined, onAuthFailure: () => void): Promise<string> {
    const response = await this.fetchImpl(`${API_BASE}/v0/chat/create_pow_challenge`, {
      method: 'POST',
      headers: { ...FINGERPRINT_HEADERS, 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw refusalFor(response.status, 'issuing a proof of work', onAuthFailure);
    const challenge = unwrap(await response.json(), 'proof of work').challenge as
      | { algorithm?: string; challenge?: string; salt?: string; difficulty?: number; signature?: string; target_path?: string; expire_at?: number }
      | undefined;
    if (!challenge?.challenge || typeof challenge.salt !== 'string' || typeof challenge.difficulty !== 'number') {
      throw fail('PROVIDER_REQUEST_FAILED', 'DeepSeek returned a proof-of-work challenge with no answer in it.');
    }
    if (challenge.algorithm !== undefined && challenge.algorithm !== 'DeepSeekHashV1') {
      // A new hash would silently produce a wrong answer, which DeepSeek reports as a plain
      // 401. Saying which algorithm arrived is the difference between a fixable error and a
      // mystery.
      throw fail('PROVIDER_REQUEST_FAILED', `DeepSeek changed its proof-of-work algorithm to ${challenge.algorithm}; this version solves DeepSeekHashV1.`);
    }
    const prefix = `${challenge.salt}_${challenge.expire_at ?? 0}_`;
    const nonce = findDeepSeekPowNonce(prefix, challenge.challenge, Math.min(challenge.difficulty, MAX_DEEPSEEK_POW_DIFFICULTY));
    if (nonce < 0) {
      throw fail(
        'PROVIDER_REQUEST_FAILED',
        `DeepSeek's proof of work had no answer within the range it announced (${challenge.difficulty}). The challenge may have expired before it was solved.`,
      );
    }
    return Buffer.from(
      JSON.stringify({
        algorithm: challenge.algorithm ?? 'DeepSeekHashV1',
        challenge: challenge.challenge,
        salt: challenge.salt,
        answer: nonce,
        signature: challenge.signature,
        target_path: challenge.target_path ?? '/api/v2/chat/completion',
      }),
    ).toString('base64');
  }

  private async createSession(accessToken: string, signal: AbortSignal | undefined, onAuthFailure: () => void): Promise<string> {
    const response = await this.fetchImpl(`${API_BASE}/v0/chat_session/create`, {
      method: 'POST',
      headers: { ...FINGERPRINT_HEADERS, 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({}),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw refusalFor(response.status, 'starting a chat session', onAuthFailure);
    const session = unwrap(await response.json(), 'chat session').chat_session as { id?: string } | undefined;
    if (!session?.id) throw fail('PROVIDER_REQUEST_FAILED', 'DeepSeek started no chat session.');
    return session.id;
  }

  /**
   * Reports whether the saved credential still works.
   *
   * Without this the provider's health is reported as `Health checks are not supported.` and
   * the dashboard's "Test provider" fails on a connection that can answer — which is exactly
   * what happened, and it looked like a broken credential rather than a missing method.
   *
   * A credential check, not a completion: it costs one round trip and no proof of work, which
   * is what makes it cheap enough to run on every health poll.
   */
  async healthCheck(context: ProviderRequestContext = {}): Promise<ProviderHealth> {
    try {
      await this.validateCredential(context.credential);
      return { status: 'healthy', verified: 'credential', checkedAt: new Date(this.now()).toISOString() };
    } catch (error) {
      return {
        status: 'unavailable', verified: 'credential',
        checkedAt: new Date(this.now()).toISOString(),
        // The provider's own words, because "not connected" tells the user nothing about
        // whether to sign in again or to wait.
        message: error instanceof Error ? error.message : 'The DeepSeek Web session could not be checked.',
      };
    }
  }

  async chat(request: ChatRequest, context: ProviderRequestContext = {}): Promise<ChatResponse> {
    const model = lookupModel(request.model);
    if (!model) {
      throw new ProviderError('NOT_SUPPORTED', `DeepSeek Web does not offer a model called ${request.model}.`, {
        providerId: this.id,
        publicMessage: `DeepSeek Web does not offer a model called ${request.model}. The models it serves are the ones on this page.`,
      });
    }
    const userToken = userTokenFromCredential(context.credential);
    const accessToken = await this.accessToken(userToken, context.signal);
    // One eviction for the whole flow: whichever of the three mid-flight endpoints answers 401,
    // the cached access token is now known bad and the next attempt must not reuse it.
    const onAuthFailure = () => this.accessTokens.delete(userToken);
    const sessionId = await this.createSession(accessToken, context.signal, onAuthFailure);
    const pow = await this.proofOfWork(accessToken, context.signal, onAuthFailure);

    /**
     * The endpoint takes one flat `prompt`, not a message array.
     *
     * History is flattened into it: a system turn is prefixed as an instruction and earlier
     * turns are labelled, because there is nowhere else to put them. Dropping them silently
     * would answer the last line and look like it had read the rest.
     */
    const prompt = flattenToPrompt(request.messages.map((message) => ({ role: message.role, text: messageText(message.content) })));

    const response = await this.fetchImpl(COMPLETION_URL, {
      method: 'POST',
      headers: {
        ...FINGERPRINT_HEADERS,
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'X-Ds-Pow-Response': pow,
        'X-Client-Timezone-Offset': String(new Date().getTimezoneOffset() * -60),
      },
      body: JSON.stringify({
        chat_session_id: sessionId,
        parent_message_id: null,
        model_type: model.expert ? 'expert' : 'default',
        prompt,
        ref_file_ids: [],
        thinking_enabled: model.thinking,
        search_enabled: model.search,
        preempt: false,
      }),
      ...(context.signal ? { signal: context.signal } : {}),
    });

    if (!response.ok) throw refusalFor(response.status, 'answering the completion', () => this.accessTokens.delete(userToken));

    const answer = decodeDeepSeekAnswer(await readBodyCapped(response, context.signal));
    if (!answer.content) {
      throw fail('PROVIDER_REQUEST_FAILED', 'DeepSeek answered, but the stream carried no text. Its response format may have changed.');
    }
    // A body that closes without `response/status: "FINISHED"` was cut off mid-generation — an
    // expired session, a dropped connection, an anti-bot challenge. Reporting the fragment as a
    // complete answer with `finish_reason: stop` is the worst version of this: it looks like a
    // model that finished, and the text is silently missing its ending.
    if (!answer.finished) {
      throw fail(
        'PROVIDER_REQUEST_FAILED',
        `DeepSeek's stream ended before it finished generating — the answer was cut off after ${answer.content.length} characters. This is usually a dropped connection or an expired session. Try again.`,
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
 * Flattens a message list into the single prompt the endpoint takes.
 *
 * Labelled rather than concatenated, because a bare join of `["You are terse.", "2+2?"]`
 * loses which was which.
 */
export function flattenToPrompt(messages: ReadonlyArray<{ role: string; text: string }>): string {
  const kept = messages.filter((message) => message.text.trim());
  const system = kept.filter((message) => message.role === 'system');
  const rest = kept.filter((message) => message.role !== 'system');
  const lines: string[] = [];
  if (system.length > 0) {
    lines.push('Follow these instructions:', ...system.map((message) => `- ${message.text.trim()}`), '');
  }
  for (const message of rest) {
    lines.push(`${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.text.trim()}`);
  }
  return lines.join('\n').trim();
}

/**
 * Reads a completed answer out of DeepSeek's SSE body.
 *
 * Two frame shapes arrive and both matter:
 *
 * ```json
 * {"v":{"response":{"thinking_enabled":true,"fragments":[{"type":"THINK","content":"…"}]}}}
 * {"p":"response/fragments","o":"append","v":[{"type":"ANSWER","content":"working"}]}
 * ```
 *
 * The first is a whole response with its fragments inline. The second appends more, and those
 * fragments often arrive **without a type**, addressed relative to the current message —
 * which is why `thinking_enabled` from the last whole response decides which side of the
 * reasoning/content split a bare fragment belongs to. Dropping that state and treating every
 * append as the answer is how a model that thinks first ends up answering with its
 * reasoning.
 */
/**
 * Reads a completed answer out of DeepSeek's SSE body.
 *
 * Captured from a live stream rather than assumed, and the shape is not what it looks like. A
 * real reply to "Count from 1 to 5" arrives as:
 *
 * ```text
 * data: {"v":{"response":{"thinking_enabled":false,"fragments":[{"type":"RESPONSE","content":"1"}]}}}
 * data: {"p":"response/fragments/-1/content","o":"APPEND","v":","}
 * data: {"v":" "}
 * data: {"v":"2"}
 * data: {"v":","}
 * data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":60}]}
 * data: {"p":"response/status","o":"SET","v":"FINISHED"}
 * ```
 *
 * **Only the first line is a fragment object.** The rest of the answer is a run of frames whose
 * value is a bare string, most of them carrying no path at all. A decoder that only recognises
 * fragment objects keeps the opening character and discards the rest — which is exactly what
 * happened: every answer came back one character long, `finish_reason: stop`, looking like a
 * working model that happened to be terse. "Count from 1 to 10" returned `1`.
 *
 * Two more things the stream requires:
 *
 * **The path is positional, and the last stated one wins.** A thinking model interleaves
 * `THINK` and `RESPONSE` fragments, and an untyped append belongs to whichever was last.
 *
 * **`FINISHED` is a status word, not text.** `{"p":"response/status","v":"FINISHED"}` has a
 * string value, so a decoder that appends every string value writes the literal word `FINISHED`
 * onto the end of the answer. It is consumed as status here, and the absence of it is reported:
 * a body that closes without `FINISHED` was cut off mid-generation, and reporting that as a
 * clean answer is the same fault as not reading the stream at all.
 */
export function decodeDeepSeekAnswer(body: string): { content: string; reasoning: string; finished: boolean } {
  let content = '';
  let reasoning = '';
  // Which side an untyped append belongs to, from the last fragment or response that said so.
  let currentPath: 'thinking' | 'content' = 'content';
  let finished = false;

  const append = (text: string) => {
    if (!text) return;
    if (currentPath === 'thinking') reasoning += text;
    else content += text;
  };

  const applyType = (fragment: { type?: unknown }) => {
    const type = String(fragment.type ?? '').toUpperCase();
    if (type === 'THINK') currentPath = 'thinking';
    else if (type === 'ANSWER' || type === 'RESPONSE') currentPath = 'content';
  };

  const takeFragment = (fragment: unknown, pathFromType: boolean) => {
    if (!fragment || typeof fragment !== 'object') return;
    const record = fragment as { type?: unknown; content?: unknown };
    if (pathFromType) applyType(record);
    if (typeof record.content !== 'string' || record.content.length === 0) return;
    if (!pathFromType) applyType(record);
    append(record.content);
  };

  for (const rawLine of body.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const frame = parsed as { p?: unknown; v?: unknown };
    const path = typeof frame.p === 'string' ? frame.p : '';
    const value = frame.v;

    // Status, not an answer. Checked before the string branch below, deliberately.
    if (path === 'response/status' && value === 'FINISHED') {
      finished = true;
      continue;
    }
    if (path === 'response/search_status' || path === 'response/search_results') continue;

    // A whole response: it declares the path and carries its own fragments.
    if (value && typeof value === 'object' && !Array.isArray(value) && 'response' in (value as Record<string, unknown>)) {
      const response = (value as { response: { thinking_enabled?: unknown; fragments?: unknown } }).response;
      if (response.thinking_enabled === true) currentPath = 'thinking';
      else if (response.thinking_enabled === false) currentPath = 'content';
      if (Array.isArray(response.fragments)) for (const fragment of response.fragments) takeFragment(fragment, false);
    }

    if (path === 'response/fragments') {
      if (Array.isArray(value)) for (const fragment of value) takeFragment(fragment, true);
      else takeFragment(value, true);
      continue;
    }

    // A metadata batch: token counts and status words, never text.
    if (path === 'response' && Array.isArray(value)) {
      for (const entry of value as Array<{ p?: unknown; v?: unknown }>) {
        if (entry?.p === 'response' && (entry.v as { thinking_enabled?: unknown } | undefined)?.thinking_enabled === true) currentPath = 'thinking';
      }
      continue;
    }

    // Most of a normal answer, and the part that was being dropped.
    if (typeof value === 'string') append(value);
  }
  /**
   * Not trimmed, deliberately.
   *
   * This decoder used to end with `content.trim()` and `reasoning.trim()`, which silently removed
   * the leading and trailing whitespace of every answer. It was the only adapter in the SDK that
   * did this, and the loss is not something a client can detect: an answer that was asked to be
   * exactly `"  indented  "` arrives as `"indented"`, and a code answer loses its trailing
   * newlines, which is visible as badly-indented code rather than as a truncated one.
   *
   * The provider contract's exact-equality assertion is what found it, and it found it because the
   * hostile fixture ends in a single space — a part that looks like nothing and is the whole point.
   */
  return { content, reasoning, finished };
}

/**
 * Reads the whole body, with a cap.
 *
 * The cap is not paranoia about a hostile server so much as about an endless one: a stream
 * that never terminates will grow a buffer until the process is killed, and the failure then
 * reads as an out-of-memory crash rather than as an upstream that never finished.
 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

async function readBodyCapped(response: Response, signal?: AbortSignal): Promise<string> {
  const body = response.body;
  if (!body) return response.text();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw fail('PROVIDER_REQUEST_FAILED', 'DeepSeek’s answer grew past 8 MB and was cut off.');
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released after a cancellation.
    }
  }
  return chunks.join('');
}
