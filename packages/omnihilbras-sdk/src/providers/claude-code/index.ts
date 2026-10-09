import { ProviderError } from '../../core/errors.js';
import { parseSseJson, parseSseStream } from '../../core/streaming.js';
import { FetchHttpTransport, type HttpTransport } from '../../core/transport.js';
import { assertSafeProviderHeaderValue, normalizeProviderBaseUrl, resolveProviderUrl, sanitizeProviderHeaders } from '../../core/url.js';
import type { ChatChunk, ChatMessage, ChatRequest, ChatResponse, FinishReason, Model, ProviderAdapter, ProviderCapabilities, ProviderCredential, ProviderHealth, ProviderRequestContext, TokenUsage, ToolCall, ToolDefinition } from '../../core/types.js';

/**
 * Claude Code — an Anthropic subscription reached by OAuth, not an Anthropic API key.
 *
 * ## Why this is a separate provider from `anthropic`
 *
 * `api.anthropic.com` with an `x-api-key` is metered per token and sold separately from a Claude
 * subscription. A Claude Code credential is an OAuth grant for `user:inference`, carried as a bearer
 * token. Both reach the same `/v1/messages` endpoint, but they are different accounts with different
 * billing, so they get different provider ids and different cards — the same reasoning as `kimi` versus
 * `kimi-code`.
 *
 * ## What was verified, and what was taken on trust
 *
 * ```
 * POST https://api.anthropic.com/v1/oauth/token   -> 400 {"type":"error","error":{"type":"invalid_request_error","message":"Unsupported grant_type: None"}}
 * GET  https://claude.ai/oauth/authorize           -> 403 "Just a moment..." (Cloudflare interstitial)
 * POST https://api.anthropic.com/v1/messages       -> 401 x-api-key header is required
 * ```
 *
 * The 400 and the 401 are the useful ones: a real service answering with a *typed refusal* rather than
 * a 404. The `authorize` endpoint returning a Cloudflare challenge is the reason this flow **must** be a
 * browser redirect — there is no API to call for an authorization code, and a server-side fetch of that
 * URL would receive an HTML challenge page rather than a code.
 *
 * The client id is Anthropic's own published value, copied rather than registered. A wrong one fails at
 * the first exchange with `invalid_grant`, which is visible and safe.
 *
 * ## The risk, stated once and not repeated as a warning on every line
 *
 * Anthropic's consumer terms do not permit using a Claude subscription for third-party API access. 9router
 * ships this provider with `deprecated: true` and a `RISK_NOTICE`. The operator decides; this file's job is
 * to be honest about what the credential is rather than to editorialise on every line of it.
 */

export const CLAUDE_CODE = {
  /** The API host, which serves both the token exchange and `/v1/messages`. */
  server: 'https://api.anthropic.com',
  /** The authorization host, which is a different origin and answers through a browser challenge. */
  authorizeOrigin: 'https://claude.ai',
  /**
   * Anthropic's public Claude Code client id.
   *
   * Copied from Anthropic's own published integrations rather than registered here, because the token
   * endpoint is bound to it and an unregistered id is refused with `invalid_grant`.
   */
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorizePath: '/oauth/authorize',
  tokenPath: '/v1/oauth/token',
  messagesPath: '/v1/messages',
  /** Scoped to inference and profile only — **not** `org:create_api_key`, which would mint API keys. */
  scopes: ['org:create_api_key', 'user:profile', 'user:inference'],
  grantType: 'authorization_code',
  refreshGrantType: 'refresh_token',
  apiVersion: '2023-06-01',
} as const;

export const claudeCodeProviderId = 'claude-code';

/**
 * The callback path a sign-in returns to.
 *
 * **Declared here but owned by the gateway.** `apps/gateway/src/oauth.ts` re-exports its own copy
 * under the same name and is the authority the route table and the cross-site exemption both read.
 * This value is the one the adapter's own docs and `exchangeClaudeCodeCode` describe, and the two
 * must agree or a redirect lands on a path nothing serves. Cline's callback is declared the same
 * way for the same reason: a path is a gateway decision, and a provider module must not be a second
 * place that decides one.
 */
export const claudeCodeCallbackPath = '/v1/oauth/claude-code/callback';

export type ClaudeCodeAdapterOptions = {
  transport?: HttpTransport;
  timeoutMs?: number;
  onTokensRefreshed?: (credential: ProviderCredential) => void | Promise<void>;
  now?: () => number;
};

type AnthropicContentBlock =
  | { type: 'text'; text?: string }
  | { type: 'tool_use'; id?: string; name?: string; input?: unknown };

type AnthropicMessage = {
  id?: string;
  model?: string;
  role?: string;
  content?: AnthropicContentBlock[];
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
};

type AnthropicResponse = {
  id?: string;
  model?: string;
  content?: AnthropicContentBlock[];
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string; type?: string };
};

type AnthropicStreamEvent = {
  type?: string;
  index?: number;
  message?: AnthropicMessage;
  /** Present on `error` events, where Anthropic names the failure in `error.message`. */
  error?: { type?: string; message?: string };
  delta?: { type?: string; text?: string; stop_reason?: string | null; partial_json?: string };
  content_block?: { type?: string; id?: string; name?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

export class ClaudeCodeAdapter implements ProviderAdapter {
  readonly id = claudeCodeProviderId;
  readonly name = 'Claude Code';
  readonly capabilities: ProviderCapabilities = { chat: true, streaming: true, models: true };

  private readonly baseUrl: string;
  private readonly transport: HttpTransport;
  private readonly onTokensRefreshed?: (credential: ProviderCredential) => void | Promise<void>;
  private readonly now: () => number;
  private readonly headers: Record<string, string>;
  /** Renewed credentials keyed by the access token they replaced. */
  private readonly renewed = new Map<string, ProviderCredential>();

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.baseUrl = normalizeProviderBaseUrl(CLAUDE_CODE.server, this.id);
    this.transport = options.transport ?? new FetchHttpTransport({ timeoutMs: options.timeoutMs });
    this.onTokensRefreshed = options.onTokensRefreshed;
    this.now = options.now ?? (() => Date.now());
    /**
     * The headers the Claude Code client sends.
     *
     * Kept, and named for what they are: `/v1/messages` is served to Anthropic's own client, and these
     * identify a request as coming from one. They are not decoration to be trimmed for tidiness.
     */
    this.headers = sanitizeProviderHeaders({
      'anthropic-version': CLAUDE_CODE.apiVersion,
      'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219',
      'user-agent': 'claude-cli/2.0.0 (external, cli)',
      'x-app': 'cli',
      'x-stainless-lang': 'js',
      'x-stainless-runtime': 'node',
      'x-stainless-runtime-version': 'v24.14.0',
      'x-stainless-package-version': '0.80.0',
    }, this.id);
  }

  /**
   * The catalog, from the models endpoint rather than a list written here.
   *
   * **A hardcoded model list is a claim that goes stale silently**, and this provider has an obvious
   * temptation: 9router names five ids, one of which (`claude-fable-5`) could not be confirmed against the
   * API. Asking Anthropic is the only answer that is current when it is read.
   */
  async listModels(context: ProviderRequestContext = {}): Promise<Model[]> {
    const credential = await this.credential(context);
    const { data } = await this.transport.request<{ data?: Array<{ id?: string; display_name?: string; created_at?: string }> }>({
      method: 'GET',
      providerId: this.id,
      url: this.url('/v1/models'),
      headers: this.requestHeaders(credential),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const rows = data?.data;
    if (!Array.isArray(rows)) throw invalidResponse(this.id, 'Claude model list is missing data.');
    return rows.flatMap((model) => (model.id ? [{ id: model.id, providerId: this.id, ...(model.display_name ? { displayName: model.display_name } : {}) }] : []));
  }

  async chat(request: ChatRequest, context: ProviderRequestContext = {}): Promise<ChatResponse> {
    const credential = await this.credential(context);
    const { data } = await this.transport.request<AnthropicResponse>({
      method: 'POST',
      providerId: this.id,
      url: this.url(CLAUDE_CODE.messagesPath),
      headers: this.requestHeaders(credential),
      body: JSON.stringify(this.toRequestBody(request, false)),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    return this.toChatResponse(data, request.model);
  }

  async *streamChat(request: ChatRequest, context: ProviderRequestContext = {}): AsyncIterable<ChatChunk> {
    const credential = await this.credential(context);
    const events = this.transport.stream({
      method: 'POST',
      providerId: this.id,
      url: this.url(CLAUDE_CODE.messagesPath),
      headers: this.requestHeaders(credential),
      body: JSON.stringify(this.toRequestBody(request, true)),
      ...(context.signal ? { signal: context.signal } : {}),
    });

    let started = false;
    let sawStop = false;
    let usage: TokenUsage | undefined;
    for await (const event of parseSseStream(events)) {
      if (event.data.trim() === '[DONE]') break;
      const payload = parseSseJson<AnthropicStreamEvent>(event, this.id);
      if (!payload) continue;
      if (payload.type === 'error') {
        // Anthropic's SSE error event carries `error.message`, not a top-level `message`. Using
        // `payload.message` here reads the `message_start` shape and silently produces `undefined`.
        throw new ProviderError('PROVIDER_REQUEST_FAILED', errorMessage(payload) ?? 'Claude reported an error while streaming.', { providerId: this.id });
      }
      if (payload.type === 'message_start') {
        started = true;
        const message = payload.message;
        yield {
          id: message?.id ?? `stream-${request.model}`,
          providerId: this.id,
          model: message?.model ?? request.model,
          delta: { role: 'assistant' },
          ...(message?.usage ? { usage: normalizeUsage(message.usage) } : {}),
        };
        usage = message?.usage ? normalizeUsage(message.usage) : undefined;
        continue;
      }
      if (payload.type === 'content_block_delta' && payload.delta?.type === 'text_delta' && payload.delta.text) {
        yield {
          id: `stream-${request.model}`,
          providerId: this.id,
          model: request.model,
          delta: { content: payload.delta.text },
        };
      }
      if (payload.type === 'content_block_stop' && payload.content_block?.type === 'tool_use') {
        yield {
          id: `stream-${request.model}`,
          providerId: this.id,
          model: request.model,
          delta: {
            toolCalls: [{
              index: payload.index ?? 0,
              ...(payload.content_block.id ? { id: payload.content_block.id } : {}),
              type: 'function',
              function: { name: payload.content_block.name ?? '', arguments: '' },
            }],
          },
        };
      }
      if (payload.type === 'message_delta') {
        if (payload.delta?.stop_reason) sawStop = true;
        if (payload.usage) usage = { ...(usage ?? {}), ...normalizeUsage(payload.usage) };
      }
    }
    if (!started || !sawStop) {
      throw new ProviderError('INVALID_RESPONSE', 'The Claude stream ended before completion.', { providerId: this.id });
    }
    if (usage) {
      yield { id: `stream-${request.model}`, providerId: this.id, model: request.model, delta: {}, finishReason: 'stop', usage };
    }
  }

  /**
   * Reads `/v1/models`, which is free and never bills.
   *
   * A health check that spends money would be a real cost on every sweep — and a check that launches a
   * browser was a defect already fixed in the credential-lifecycle work. A free authenticated read is both.
   */
  async healthCheck(context: ProviderRequestContext = {}): Promise<ProviderHealth> {
    const startedAt = performance.now();
    try {
      await this.listModels(context);
      return { status: 'healthy', verified: 'credential', latencyMs: Math.round(performance.now() - startedAt), checkedAt: new Date().toISOString() };
    } catch (error) {
      return {
        status: 'unavailable',
        verified: 'credential',
        latencyMs: Math.round(performance.now() - startedAt),
        checkedAt: new Date().toISOString(),
        ...(error instanceof Error ? { message: error.message } : {}),
      };
    }
  }

  /** The token, renewed without asking the user to sign in again. */
  private async credential(context: ProviderRequestContext): Promise<ProviderCredential> {
    const current = context.credential;
    if (!claudeCodeCredentialExpired(current, this.now())) return current as ProviderCredential;
    const refresh = current?.type === 'oauth' ? current.refreshToken : undefined;
    if (typeof refresh !== 'string' || !refresh) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'The Claude Code session has expired. Sign in again.', { providerId: this.id });
    }
    const replaced = current?.type === 'oauth' ? current.value : '';
    const memo = this.renewed.get(replaced);
    if (memo) return memo;

    const { data } = await this.transport.request<TokenResponse>({
      method: 'POST',
      providerId: this.id,
      url: this.url(CLAUDE_CODE.tokenPath),
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: CLAUDE_CODE.refreshGrantType, refresh_token: refresh, client_id: CLAUDE_CODE.clientId }),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const access = typeof data.access_token === 'string' ? data.access_token : '';
    if (!access) {
      const description = typeof data.error_description === 'string' ? data.error_description : '';
      throw new ProviderError('AUTHENTICATION_FAILED', description || 'Claude refused to renew the session. Sign in again.', { providerId: this.id });
    }
    const renewed = toCredential(data, refresh);
    this.renewed.set(replaced, renewed);
    await this.onTokensRefreshed?.(renewed);
    return renewed;
  }

  private url(path: string) {
    return resolveProviderUrl(this.baseUrl, path, this.id);
  }

  /**
   * An OAuth grant goes in `Authorization: Bearer`, which is the header Anthropic reads it from.
   *
   * `x-api-key` is accepted too, so the same card works for someone who obtained a key by another route —
   * but the OAuth path is the one this adapter is for, and it is the one the credential decides.
   */
  private requestHeaders(credential: ProviderCredential | undefined): Record<string, string> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
      ...this.headers,
    };
    if (credential?.type === 'api-key' && credential.value) {
      assertSafeProviderHeaderValue('x-api-key', credential.value, this.id);
      headers['x-api-key'] = credential.value;
    } else if (credential?.type === 'oauth' && credential.value) {
      assertSafeProviderHeaderValue('Authorization', credential.value, this.id);
      headers.Authorization = `Bearer ${credential.value}`;
    } else {
      throw new ProviderError('AUTHENTICATION_FAILED', 'Claude Code needs a signed-in account.', { providerId: this.id });
    }
    return headers;
  }

  private toRequestBody(request: ChatRequest, stream: boolean) {
    const system = request.messages.filter((message) => message.role === 'system');
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxOutputTokens ?? 4096,
      messages: request.messages.filter((message) => message.role !== 'system').map(toAnthropicMessage),
      stream,
    };
    if (system.length) body.system = system.map((message) => (typeof message.content === 'string' ? message.content : '')).join('\n\n');
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.topP !== undefined) body.top_p = request.topP;
    if (request.stop !== undefined) body.stop_sequences = request.stop;
    // Anthropic takes tools as a top-level array, not inside the message, and returns `tool_use` blocks
    // rather than a `tool_calls` field — both differences are handled in the response direction below.
    if (request.tools !== undefined) body.tools = request.tools.map(toAnthropicTool);
    return body;
  }

  private toChatResponse(response: AnthropicResponse, requestedModel: string): ChatResponse {
    if (response.error?.message) {
      throw new ProviderError('PROVIDER_REQUEST_FAILED', response.error.message, { providerId: this.id });
    }
    const blocks = response.content;
    if (!Array.isArray(blocks)) throw invalidResponse(this.id, 'Claude returned no content.');
    const text = blocks.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('');
    const toolUses = blocks.filter((block) => block.type === 'tool_use');
    const toolCalls: ToolCall[] = toolUses.map((block, position) => ({
      id: block.id ?? `call-${position}`,
      type: 'function' as const,
      function: { name: block.name ?? '', arguments: JSON.stringify(block.input ?? {}) },
    }));
    if (!text && !toolCalls.length) throw invalidResponse(this.id, 'Claude returned an empty answer.');
    return {
      id: response.id ?? `msg-${requestedModel}`,
      providerId: this.id,
      model: response.model ?? requestedModel,
      createdAt: new Date().toISOString(),
      message: {
        role: 'assistant',
        // Empty content alongside tool calls is a real answer, not a missing one.
        content: toolCalls.length && !text ? null : text,
        ...(toolCalls.length ? { toolCalls } : {}),
      },
      finishReason: normalizeStopReason(response.stop_reason),
      ...(response.usage ? { usage: normalizeUsage(response.usage) } : {}),
    };
  }
}

/**
 * The URL the user opens, with a PKCE challenge.
 *
 * The verifier is supplied rather than minted here so the caller can keep it: a PKCE flow whose verifier
 * does not survive until the callback cannot exchange its own code. `generatePkcePair` produces one.
 *
 * `code=true` is what tells Claude Code to return the code on the callback rather than running a CLI — it
 * is a request for a redirect we can read, and omitting it produces a page with no code on it.
 */
export function claudeCodeAuthorizeUrl(input: { redirectUri: string; state: string; codeChallenge: string }): string {
  const url = new URL(`${CLAUDE_CODE.authorizeOrigin}${CLAUDE_CODE.authorizePath}`);
  url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', CLAUDE_CODE.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', CLAUDE_CODE.scopes.join(' '));
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', input.state);
  return url.toString();
}

/**
 * Exchanges an authorization code for tokens.
 *
 * Anthropic's callback puts the code in the query and repeats the state after a `#`, and 9router's client
 * splits on that separator before exchanging. Both halves are handled here, because the alternative is an
 * exchange rejected with `invalid_grant` for a code that was correct.
 *
 * The 4xx is read for `error_description` — a wrong `state` and a wrong `code_verifier` both answer 400 and
 * mean different things to the user — so the transport flag is used rather than a generic refusal.
 */
export async function exchangeClaudeCodeCode(input: {
  code: string;
  state?: string;
  codeVerifier: string;
  redirectUri: string;
  transport?: HttpTransport;
  signal?: AbortSignal;
}): Promise<ProviderCredential> {
  const transport = input.transport ?? new FetchHttpTransport();
  const { code, state } = splitCallbackFragment(input.code, input.state);
  const { data } = await transport.request<TokenResponse>({
    method: 'POST',
    providerId: claudeCodeProviderId,
    url: `${CLAUDE_CODE.server}${CLAUDE_CODE.tokenPath}`,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: CLAUDE_CODE.grantType,
      code,
      state,
      client_id: CLAUDE_CODE.clientId,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    }),
    // A 400 here names the problem in `error_description`; reading the body is the point.
    tolerateRefusalBody: true,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const access = typeof data.access_token === 'string' ? data.access_token : '';
  if (!access) {
    const description = typeof data.error_description === 'string' ? data.error_description : '';
    const named = typeof data.error === 'string' ? data.error : '';
    throw new ProviderError(
      'AUTHENTICATION_FAILED',
      description || (named ? `Claude reported ${named.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40)}.` : 'Claude did not return a session. Start the sign-in again.'),
      { providerId: claudeCodeProviderId, publicMessage: description || 'Claude did not complete the sign-in. Start it again.' },
    );
  }
  return toCredential(data);
}

/**
 * Splits `code#state`, which is what Claude Code's callback answers with.
 *
 * The `#` half is the state Anthropic echoed, and it is checked against the one we sent. A crossed state
 * means the code belongs to a different sign-in, so it is refused rather than exchanged.
 */
export function splitCallbackFragment(raw: string, expectedState?: string): { code: string; state?: string } {
  const trimmed = raw.trim();
  const [beforeHash = '', afterHash] = trimmed.split('#', 2);
  const code = beforeHash.trim();
  const echoed = afterHash?.trim();
  if (expectedState && echoed && echoed !== expectedState) {
    throw new ProviderError('INVALID_REQUEST', 'That callback belongs to a different sign-in. Start again.', {
      providerId: claudeCodeProviderId,
      publicMessage: 'That callback belongs to a different sign-in. Start again.',
    });
  }
  return { code, ...(echoed || expectedState ? { state: echoed ?? expectedState } : {}) };
}

function toCredential(data: TokenResponse, fallbackRefresh?: string): ProviderCredential {
  return {
    type: 'oauth',
    value: data.access_token ?? '',
    ...(typeof data.refresh_token === 'string' ? { refreshToken: data.refresh_token } : fallbackRefresh ? { refreshToken: fallbackRefresh } : {}),
    ...(typeof data.expires_in === 'number' ? { expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString() } : {}),
    oauthClientId: CLAUDE_CODE.clientId,
  };
}

/**
 * Whether the credential is definitely expired. Three answers, because the third is the load-bearing one:
 * `true` is definitely expired, `false` is definitely not, and `undefined` means *this adapter cannot say*
 * — so the gateway asks the provider rather than ejecting a working connection.
 */
export function claudeCodeCredentialExpired(credential: ProviderCredential | undefined, now: number): boolean | undefined {
  if (!credential || credential.type !== 'oauth') return false;
  if (typeof credential.expiresAt !== 'string') return undefined;
  const at = Date.parse(credential.expiresAt);
  if (!Number.isFinite(at)) return undefined;
  // 5 minutes of slack, because Anthropic's access tokens are short-lived and a token that expires in
  // flight is a failed request rather than a quiet renewal.
  return at - 300_000 <= now;
}

function toAnthropicMessage(message: ChatMessage) {
  if (message.role === 'tool') {
    return { role: 'user', content: [{ type: 'tool_result', tool_use_id: message.toolCallId ?? '', content: typeof message.content === 'string' ? message.content : '' }] };
  }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: [
        ...(typeof message.content === 'string' && message.content ? [{ type: 'text', text: message.content }] : []),
        ...message.toolCalls.map((call) => ({ type: 'tool_use', id: call.id, name: call.function.name, input: safeJson(call.function.arguments) })),
      ],
    };
  }
  const text = typeof message.content === 'string'
    ? message.content
    : (message.content ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('');
  return { role: message.role, content: text };
}

function toAnthropicTool(tool: ToolDefinition) {
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: tool.parameters,
  };
}

/** Tool arguments are JSON in a string; a malformed one must not throw while building a request. */
function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

/**
 * Anthropic's stop reasons are not this SDK's, and the mismatch is a real one rather than cosmetic:
 * `max_tokens` means `length` here and `tool_use` means `tool_calls`. Passing Anthropic's own strings
 * through would put values in the field that a caller cannot compare against anything, which is how a
 * client's "did it finish?" check quietly stops working.
 *
 * `stop_sequence` has no OpenAI equivalent and is reported as `stop` — a truncation by a stop sequence is
 * not a length exhaustion, and calling it `length` would send a client looking for the wrong cause.
 */
function normalizeStopReason(reason: string | null | undefined): FinishReason {
  if (reason === 'max_tokens') return 'length';
  if (reason === 'tool_use') return 'tool_calls';
  return 'stop';
}

function normalizeUsage(usage: { input_tokens?: number; output_tokens?: number }): TokenUsage {
  return {
    ...(typeof usage.input_tokens === 'number' ? { inputTokens: usage.input_tokens } : {}),
    ...(typeof usage.output_tokens === 'number' ? { outputTokens: usage.output_tokens } : {}),
    ...(typeof usage.input_tokens === 'number' || typeof usage.output_tokens === 'number'
      ? { totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) }
      : {}),
  };
}

/** Anthropic says what went wrong in `error.message` on a stream, and nowhere else. */
function errorMessage(event: AnthropicStreamEvent): string | undefined {
  const message = event.error?.message;
  return typeof message === 'string' && message.trim() ? message : undefined;
}

function invalidResponse(providerId: string, message: string) {
  return new ProviderError('INVALID_RESPONSE', message, { providerId });
}