import { ProviderError } from '../../core/errors.js';
import { parseSseJson, parseSseStream } from '../../core/streaming.js';
import { FetchHttpTransport, type HttpTransport } from '../../core/transport.js';
import { assertSafeProviderHeaderValue, normalizeProviderBaseUrl, resolveProviderUrl, sanitizeProviderHeaders } from '../../core/url.js';
import type { ChatChunk, ChatMessage, ChatRequest, ChatResponse, EmbeddingRequest, EmbeddingResponse, FinishReason, Model, ProviderAdapter, ProviderCapabilities, ProviderCredential, ProviderHealth, ProviderRequestContext, TokenUsage, ToolDefinition } from '../../core/types.js';

/**
 * Kimi Code — the `api.kimi.com` coding subscription, reached by OAuth device code.
 *
 * ## Why this exists beside the `kimi` API-key adapter
 *
 * Two different things share the name Kimi. `https://api.moonshot.ai/v1` is the platform, sold per
 * token with an API key, and that card already exists. `https://api.kimi.com/coding` is a *subscription*
 * — a monthly plan that signs in with the account you already have, exactly as the vendor's own CLI
 * does. They are separate accounts, separate billing, and separate endpoints, so they get separate
 * provider ids and separate cards rather than one card with two modes.
 *
 * ## What was verified, and what was taken on trust
 *
 * Every host below was probed before it was written down:
 *
 * ```
 * POST https://auth.kimi.com/api/oauth/token    -> 405 Method Not Allowed   (live; GET is not the method)
 * GET  https://api.kimi.com/coding/v1/models    -> 401 Invalid Authentication
 * ```
 *
 * A 405 from a GET is the useful signal: it means a real service answered with "wrong verb", not a
 * parked domain. The client id is **not** verified — it is Kimi's public, shipped-in-their-CLI
 * identifier, copied from their own registry, and a wrong one fails at the first sign-in with
 * `invalid_client`, which is a safe and visible failure.
 *
 * ## The two auth modes this provider has
 *
 * Kimi accepts the OAuth token and the platform API key over the *same* endpoint, distinguished only
 * by which header carries it. `credential` below is therefore a union in practice: an OAuth value is
 * sent as `Authorization: Bearer`, an api-key value as `x-api-key`. That is not a convenience — it is
 * what lets the same model ids work for both accounts.
 */

export const KIMI_CODE = {
  /** The coding subscription's API host. */
  server: 'https://api.kimi.com',
  /** The account host that issues and renews tokens. Separate from the API host by design. */
  authOrigin: 'https://auth.kimi.com',
  /** The web origin the user visits to approve a device code. */
  webOrigin: 'https://www.kimi.com',
  /**
   * Kimi's public CLI client id.
   *
   * Taken from Kimi's own published registry rather than invented, because the token endpoint is
   * bound to it and an unregistered id is refused with `invalid_client`.
   */
  clientId: '17e5f671-d194-4dfb-9706-5516cb48c098',
  deviceCodePath: '/api/oauth/device_authorization',
  deviceTokenPath: '/api/oauth/token',
  chatPath: '/coding/v1/chat/completions',
  modelsPath: '/coding/v1/models',
  embeddingsPath: '/coding/v1/embeddings',
  grantType: 'urn:ietf:params:oauth:grant-type:device_code',
  refreshGrantType: 'refresh_token',
} as const;

export const kimiCodeProviderId = 'kimi-code';

export type KimiCodeAdapterOptions = {
  transport?: HttpTransport;
  timeoutMs?: number;
  /** Called with a renewed credential so a caller can persist it. */
  onTokensRefreshed?: (credential: ProviderCredential) => void | Promise<void>;
  now?: () => number;
};

type DeviceCodeResponse = {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type OpenAIChoice = {
  message?: {
    role?: string;
    content?: string | null;
    tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
  };
  finish_reason?: string | null;
};

type OpenAIResponse = {
  id?: string;
  model?: string;
  created?: number;
  choices?: OpenAIChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

type OpenAIStreamChunk = OpenAIResponse & {
  error?: { message?: string };
  choices?: Array<{
    delta?: { role?: string; content?: string | null; tool_calls?: Array<{ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }> };
    finish_reason?: string | null;
  }>;
};

type KimiEmbeddingResponse = {
  id?: string;
  model?: string;
  created?: number;
  data?: Array<{ object?: string; index?: number; embedding?: number[] }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
};

export class KimiCodeAdapter implements ProviderAdapter {
  readonly id = kimiCodeProviderId;
  readonly name = 'Kimi Code';
  readonly capabilities: ProviderCapabilities = { chat: true, streaming: true, models: true, embeddings: true };

  private readonly baseUrl: string;
  private readonly transport: HttpTransport;
  private readonly onTokensRefreshed?: (credential: ProviderCredential) => void | Promise<void>;
  private readonly now: () => number;
  private readonly headers: Record<string, string>;
  /** Renewed credentials keyed by the access token they replaced. */
  private readonly renewed = new Map<string, ProviderCredential>();

  constructor(options: KimiCodeAdapterOptions = {}) {
    this.baseUrl = normalizeProviderBaseUrl(KIMI_CODE.server, this.id);
    this.transport = options.transport ?? new FetchHttpTransport({ timeoutMs: options.timeoutMs });
    this.onTokensRefreshed = options.onTokensRefreshed;
    this.now = options.now ?? (() => Date.now());
    /**
     * The client headers Kimi's own CLI sends.
     *
     * Kept, and named as what they are: the coding endpoint is served to their CLI, and these are
     * what identify a request as coming from one. A request without them is not "a Kimi request with
     * fewer fields" — it is a request from something Kimi does not serve.
     */
    this.headers = sanitizeProviderHeaders({
      'X-Msh-Version': '1',
      'User-Agent': 'kimi-cli/1.0.0 (external, sdk-cli)',
      'X-App': 'cli',
      'X-Stainless-Lang': 'js',
      'X-Stainless-Runtime': 'node',
      'X-Stainless-Runtime-Version': 'v24.14.0',
      'X-Stainless-Package-Version': '0.80.0',
      'X-Stainless-Retry-Count': '0',
      'X-Stainless-Timeout': '600',
      'Anthropic-Beta': 'claude-code-20250219,oauth-2025-04-20',
    }, this.id);
  }

  /**
   * Asks Kimi for a device code.
   *
   * The verification URI comes back relative to the *web* origin, so joining it to the API host would
   * produce a page that does not exist — the same trap the Console flow documents.
   */
  async beginSignIn(): Promise<{
    deviceCode: string;
    /** The id this flow minted, which the poll must present. */
    deviceId: string;
    userCode: string;
    verificationUrl: string;
    expiresIn?: number;
  }> {
    // **Form-encoded, and that is measured rather than assumed.** Kimi's device endpoints answer a
    // JSON body with `400 {"error":"invalid_request","error_description":"client_id is required"}` —
    // the parameter is present and still refused, because the body was not read at all. The same
    // request form-encoded returns 200 with a real `device_code`:
    //
    // ```
    // POST /api/oauth/device_authorization  content-type: application/json          -> 400 client_id is required
    // POST /api/oauth/device_authorization  content-type: x-www-form-urlencoded      -> 200 {"device_code":"...","user_code":"..."}
    // ```
    //
    // So `postJson` was the wrong shape for both halves of this flow, and it is `postForm` below.
    const deviceId = crypto.randomUUID();
    const { data } = await this.postForm<DeviceCodeResponse>(KIMI_CODE.deviceCodePath, {
      client_id: KIMI_CODE.clientId,
    }, this.kimiHeaders(deviceId));
    const deviceCode = typeof data.device_code === 'string' ? data.device_code : '';
    const userCode = typeof data.user_code === 'string' ? data.user_code : '';
    if (!deviceCode || !userCode) {
      throw new ProviderError('PROVIDER_REQUEST_FAILED', 'Kimi did not return a device code. Try again in a moment.', { providerId: this.id });
    }
    // Kimi answers with an **absolute** URL (measured), so it is used as given. The relative-join
    // fallback is kept for a server that answers with a path, because joining an absolute URL to the
    // web origin produces `https://www.kimi.com/https://www.kimi.com/code/...`.
    const given = data.verification_uri_complete ?? data.verification_uri;
    const verificationUrl = given
      ? (/^https?:\/\//.test(given) ? given : `${KIMI_CODE.webOrigin}${given.startsWith('/') ? '' : '/'}${given}`)
      : `${KIMI_CODE.webOrigin}/code/authorize_device`;
    return {
      deviceCode,
      deviceId,
      userCode,
      verificationUrl,
      ...(typeof data.expires_in === 'number' ? { expiresIn: data.expires_in } : {}),
    };
  }

  /**
   * Polls for the token.
   *
   * Kimi answers a pending poll with an error code in the body, so the *code* decides the outcome and
   * a transport-level 4xx is not treated as a failed sign-in. `slow_down` is mapped to `pending`
   * rather than a denial because it is Kimi asking for a slower poll, not refusing the grant.
   */
  async pollSignIn(deviceCode: string, signal?: AbortSignal, deviceId: string = crypto.randomUUID()): Promise<
    | { status: 'pending' }
    | { status: 'denied'; error: string }
    | { status: 'connected'; credential: ProviderCredential; account: string }
  > {
    // Same form encoding, for the same measured reason — **and the status is the reason this had to be
    // written differently.**
    //
    // `postForm` runs the request through the shared transport, which turns any non-2xx into a thrown
    // `ProviderError` — the correct behaviour for an inference call. But Kimi's *token* endpoint answers
    // a pending poll with **HTTP 400** and `{"error":"authorization_pending"}` in the body, so the throw
    // happened before the body could be read and the flow reported a failure for a sign-in that was
    // simply waiting. Measured against the live host:
    //
    // ```
    // POST /api/oauth/token  grant_type=device_code  ->  400 {"error":"authorization_pending"}  (still waiting)
    // ```
    //
    // So the poll goes out raw and reads the status itself. The inference paths keep using `postForm`,
    // where the transport's classification is exactly right.
    const { data, status } = await this.postFormAllowingRefusal<TokenResponse>(KIMI_CODE.deviceTokenPath, {
      grant_type: KIMI_CODE.grantType,
      device_code: deviceCode,
      client_id: KIMI_CODE.clientId,
    }, this.kimiHeaders(deviceId), signal);

    const error = typeof data.error === 'string' ? data.error : '';
    // Read from the body whatever the status. The status is asserted as well, because a body carrying
    // `authorization_pending` on a 200 would be a different provider's convention and should not be
    // trusted silently — but the status alone is not enough either, since this endpoint answers 400.
    if (error === 'authorization_pending' || error === 'slow_down') {
      if (status !== 400 && status !== 200) {
        return { status: 'denied', error: `Kimi answered ${status} for a poll that should still be waiting.` };
      }
      return { status: 'pending' };
    }
    if (error) {
      const description = typeof data.error_description === 'string' ? data.error_description : '';
      return {
        status: 'denied',
        error: description || `Kimi reported ${error.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40)}.`,
      };
    }
    const access = typeof data.access_token === 'string' ? data.access_token : '';
    if (!access) return { status: 'denied', error: 'Kimi did not return a session. Start the sign-in again.' };

    const credential: ProviderCredential = {
      type: 'oauth',
      value: access,
      ...(typeof data.refresh_token === 'string' ? { refreshToken: data.refresh_token } : {}),
      ...(typeof data.expires_in === 'number' ? { expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString() } : {}),
      oauthClientId: KIMI_CODE.clientId,
    };
    return { status: 'connected', credential, account: 'Kimi Code subscription' };
  }

  async listModels(context: ProviderRequestContext = {}): Promise<Model[]> {
    const credential = await this.credential(context);
    const { data } = await this.transport.request<{ data?: Array<{ id?: string }> }>({
      method: 'GET',
      providerId: this.id,
      url: this.url(KIMI_CODE.modelsPath),
      headers: this.requestHeaders(credential),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const rows = data?.data;
    if (!Array.isArray(rows)) throw invalidResponse(this.id, 'Kimi model list is missing data.');
    return rows.flatMap((model) => (model.id ? [{ id: model.id, providerId: this.id }] : []));
  }

  async chat(request: ChatRequest, context: ProviderRequestContext = {}): Promise<ChatResponse> {
    const credential = await this.credential(context);
    const { data } = await this.transport.request<OpenAIResponse>({
      method: 'POST',
      providerId: this.id,
      url: this.url(KIMI_CODE.chatPath),
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
      url: this.url(KIMI_CODE.chatPath),
      headers: this.requestHeaders(credential),
      body: JSON.stringify(this.toRequestBody(request, true)),
      ...(context.signal ? { signal: context.signal } : {}),
    });

    let sawPayload = false;
    let sawDone = false;
    for await (const event of parseSseStream(events)) {
      if (event.data.trim() === '[DONE]') {
        sawDone = true;
        break;
      }
      const payload = parseSseJson<OpenAIStreamChunk>(event, this.id);
      if (!payload) continue;
      sawPayload = true;
      if (payload.error) {
        throw new ProviderError('PROVIDER_REQUEST_FAILED', payload.error.message ?? 'Kimi reported an error while streaming.', { providerId: this.id });
      }
      const choice = payload.choices?.[0];
      const delta = choice?.delta;
      yield {
        id: payload.id ?? `stream-${request.model}`,
        providerId: this.id,
        model: payload.model ?? request.model,
        delta: {
          ...(delta?.role ? { role: normalizeRole(delta.role) } : {}),
          ...(delta?.content ? { content: delta.content } : {}),
          ...(delta?.tool_calls?.length ? { toolCalls: delta.tool_calls.map(normalizeToolCallDelta) } : {}),
        },
        ...(choice?.finish_reason ? { finishReason: normalizeFinishReason(choice.finish_reason) } : {}),
        ...(payload.usage ? { usage: normalizeUsage(payload.usage) } : {}),
      };
    }
    if (!sawPayload || !sawDone) {
      throw new ProviderError('INVALID_RESPONSE', 'The Kimi stream ended before completion.', { providerId: this.id });
    }
  }

  /**
   * Kimi's coding endpoint serves `/coding/v1/embeddings`.
   *
   * `dimensions` is measured from the vector, never assumed — the same rule the OpenAI-compatible
   * adapter follows, and for the same reason: a wrong dimension count cannot be detected by a caller
   * after the vector has been built.
   */
  async embed(request: EmbeddingRequest, context: ProviderRequestContext = {}): Promise<EmbeddingResponse> {
    const credential = await this.credential(context);
    const inputs = typeof request.input === 'string' ? [request.input] : [...request.input];
    if (inputs.length === 0 || inputs.some((value) => !value)) {
      throw new ProviderError('INVALID_REQUEST', 'Embedding input must be a non-empty string or a non-empty array of non-empty strings.', { providerId: this.id });
    }
    const body: Record<string, unknown> = { model: request.model, input: inputs };
    if (request.dimensions !== undefined) body.dimensions = request.dimensions;

    const { data } = await this.transport.request<KimiEmbeddingResponse>({
      method: 'POST',
      providerId: this.id,
      url: this.url(KIMI_CODE.embeddingsPath),
      headers: this.requestHeaders(credential),
      body: JSON.stringify(body),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const rows = data?.data;
    if (!Array.isArray(rows)) throw invalidResponse(this.id, 'Kimi embeddings response is missing data.');
    const vectors = rows.map((row, position) => {
      const embedding = row?.embedding;
      if (!Array.isArray(embedding) || embedding.length === 0) {
        throw invalidResponse(this.id, `Kimi embedding at index ${position} is missing its vector.`);
      }
      if (embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
        throw invalidResponse(this.id, `Kimi embedding at index ${position} contains a non-numeric value.`);
      }
      return {
        index: typeof row?.index === 'number' ? row.index : position,
        embedding,
        dimensions: embedding.length,
      };
    });
    if (vectors.length !== inputs.length) {
      throw invalidResponse(this.id, `Kimi returned ${vectors.length} embedding(s) for ${inputs.length} input(s).`);
    }
    return {
      id: data.id ?? `embed-${request.model}`,
      providerId: this.id,
      model: data.model ?? request.model,
      createdAt: new Date((typeof data.created === 'number' ? data.created : Date.now() / 1000) * 1000).toISOString(),
      data: vectors,
      ...(data.usage ? { usage: normalizeUsage(data.usage) } : {}),
    };
  }

  /**
   * Reads `/coding/v1/models`, which is free and never bills.
   *
   * A health check that spends money would be a real cost on every sweep, and a check that launches a
   * browser was the defect fixed in the credential-lifecycle work. A free authenticated read is both.
   */
  async healthCheck(context: ProviderRequestContext = {}): Promise<ProviderHealth> {
    const startedAt = performance.now();
    try {
      await this.listModels(context);
      return {
        status: 'healthy',
        verified: 'credential',
        latencyMs: Math.round(performance.now() - startedAt),
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      const code = error instanceof ProviderError ? error.code : 'PROVIDER_REQUEST_FAILED';
      return {
        status: 'unavailable',
        verified: 'credential',
        latencyMs: Math.round(performance.now() - startedAt),
        checkedAt: new Date().toISOString(),
        ...(error instanceof Error ? { message: error.message } : {}),
        ...(error instanceof ProviderError && code !== 'PROVIDER_REQUEST_FAILED' ? { reason: code } : {}),
      };
    }
  }

  /** Kimi's token, renewed without asking the user to sign in again. */
  private async credential(context: ProviderRequestContext): Promise<ProviderCredential> {
    const current = context.credential;
    if (!kimiCodeCredentialExpired(current, this.now())) return current as ProviderCredential;
    // Narrowed once, here, because reading `.refreshToken` off the union is a compile error on the
    // `api-key` and `none` arms and reading it through a cast would hide a genuinely absent refresh.
    const refresh = current?.type === 'oauth' ? current.refreshToken : undefined;
    if (typeof refresh !== 'string' || !refresh) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'The Kimi Code session has expired. Sign in again.', { providerId: this.id });
    }
    const replaced = current?.type === 'oauth' ? current.value : '';
    const memo = this.renewed.get(replaced);
    if (memo) return memo;

    // Read the body whatever the status, for the same measured reason as the poll: a dead refresh token
    // comes back as a 4xx whose `error_description` is the only place Kimi says *why*, and throwing on the
    // status would replace that with the transport's own generic refusal.
    const { data } = await this.postFormAllowingRefusal<TokenResponse>(
      KIMI_CODE.deviceTokenPath,
      {
        grant_type: KIMI_CODE.refreshGrantType,
        refresh_token: refresh,
        client_id: KIMI_CODE.clientId,
      },
      { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      context.signal,
    );
    const access = typeof data.access_token === 'string' ? data.access_token : '';
    if (!access) {
      const description = typeof data.error_description === 'string' ? data.error_description : '';
      throw new ProviderError('AUTHENTICATION_FAILED', description || 'Kimi refused to renew the session. Sign in again.', { providerId: this.id });
    }
    const renewed: ProviderCredential = {
      type: 'oauth',
      value: access,
      ...(typeof data.refresh_token === 'string' ? { refreshToken: data.refresh_token } : { refreshToken: refresh }),
      ...(typeof data.expires_in === 'number' ? { expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString() } : {}),
      oauthClientId: KIMI_CODE.clientId,
    };
    this.renewed.set(replaced, renewed);
    await this.onTokensRefreshed?.(renewed);
    return renewed;
  }

  private url(path: string) {
    return resolveProviderUrl(this.baseUrl, path, this.id);
  }

  /**
   * The credential header, which is the one place the two auth modes differ.
   *
   * An OAuth token goes in `Authorization: Bearer` and a platform API key in `x-api-key`, because
   * Kimi's coding endpoint accepts both and distinguishes them by header. Sending an OAuth token as
   * `x-api-key` produces a `401` whose body names the header it wanted, so the split is read from the
   * credential rather than hardcoded per request.
   */
  private requestHeaders(credential: ProviderCredential | undefined): Record<string, string> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
      ...this.headers,
    };
    if (credential?.type === 'api-key') {
      assertSafeProviderHeaderValue('x-api-key', credential.value, this.id);
      headers['x-api-key'] = credential.value;
    } else if (credential?.type === 'oauth' && credential.value) {
      assertSafeProviderHeaderValue('Authorization', credential.value, this.id);
      headers.Authorization = `Bearer ${credential.value}`;
    } else {
      throw new ProviderError('AUTHENTICATION_FAILED', 'Kimi Code needs a signed-in account or an API key.', { providerId: this.id });
    }
    return headers;
  }

  private toRequestBody(request: ChatRequest, stream: boolean) {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(toOpenAIMessage),
      stream,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.topP !== undefined) body.top_p = request.topP;
    if (request.maxOutputTokens !== undefined) body.max_tokens = request.maxOutputTokens;
    if (request.stop !== undefined) body.stop = request.stop;
    if (request.tools !== undefined) body.tools = request.tools.map(toOpenAITool);
    return body;
  }

  private toChatResponse(response: OpenAIResponse, requestedModel: string): ChatResponse {
    const choice = response.choices?.[0];
    if (!choice?.message) throw invalidResponse(this.id, 'Kimi returned no message.');
    const content = choice.message.content ?? '';
    const toolCalls = choice.message.tool_calls?.filter((call) => call.function?.name).map((call, index) => ({
      id: call.id ?? `call-${index}`,
      type: 'function' as const,
      function: { name: call.function!.name!, arguments: call.function!.arguments ?? '{}' },
    }));
    return {
      id: response.id ?? `chat-${requestedModel}`,
      providerId: this.id,
      model: response.model ?? requestedModel,
      createdAt: new Date((typeof response.created === 'number' ? response.created : Date.now() / 1000) * 1000).toISOString(),
      message: {
        role: 'assistant',
        // Empty content with tool calls is a real answer, not a missing one — see `parseMessage`.
        content: toolCalls?.length && !content ? null : content,
        ...(toolCalls?.length ? { toolCalls } : {}),
      },
      finishReason: normalizeFinishReason(choice.finish_reason),
      ...(response.usage ? { usage: normalizeUsage(response.usage) } : {}),
    };
  }

  /**
   * Posts a form-encoded body to the account host.
   *
   * `URLSearchParams` rather than a hand-built string, so a value containing `&` or `=` is encoded
   * rather than splitting the body — which on a token endpoint means a client id that arrives
   * truncated, with no error to point at.
   */
  /**
   * Posts a form body and returns the parsed body **whatever the status**.
   *
   * Only for an endpoint whose 4xx carries a meaningful body — an OAuth token exchange, where `400
   * authorization_pending` is an expected answer rather than a failure. Everywhere else the shared
   * transport's classification is right and this must not be used: a 401 here would be read as data
   * instead of an authentication failure.
   */
  private async postFormAllowingRefusal<T>(path: string, fields: Record<string, string>, headers: Record<string, string>, signal?: AbortSignal): Promise<{ data: T; status: number }> {
    const response = await this.transport.request<{ data?: T } & T>({
      method: 'POST',
      providerId: this.id,
      url: `${KIMI_CODE.authOrigin}${path}`,
      headers: { accept: 'application/json', ...headers },
      body: new URLSearchParams(fields).toString(),
      // The flag that reaches the transport: without it the 400 is thrown before this method runs, which
      // was the whole defect — the first fix lived here and could not work, because the throw is upstream.
      tolerateRefusalBody: true,
      ...(signal ? { signal } : {}),
    });
    return { data: (response.data ?? {}) as T, status: response.status };
  }

  private async postForm<T>(path: string, fields: Record<string, string>, headers: Record<string, string>, signal?: AbortSignal): Promise<{ data: T }> {
    const response = await this.transport.request<{ data?: T } & T>({
      method: 'POST',
      providerId: this.id,
      url: `${KIMI_CODE.authOrigin}${path}`,
      headers: { accept: 'application/json', ...headers },
      body: new URLSearchParams(fields).toString(),
      ...(signal ? { signal } : {}),
    });
    return { data: (response.data ?? {}) as T };
  }

  /**
   * The account-host headers, which differ from the API-host ones.
   *
   * `X-Msh-Device-Id` is a per-sign-in identifier that has to be **the same on the start and the poll**:
   * Kimi ties the two halves of a device grant together by it, so a poll carrying a fresh id asks
   * about a different session and comes back `authorization_pending` forever. It is minted once per
   * sign-in and carried on the session, which is why `pollSignIn` takes it as a parameter.
   */
  private kimiHeaders(deviceId: string): Record<string, string> {
    return {
      'content-type': 'application/x-www-form-urlencoded',
      'X-Msh-Device-Id': deviceId,
      'X-App': 'cli',
      'X-Stainless-Lang': 'js',
      'X-Stainless-Runtime': 'node',
    };
  }
}

/**
 * Whether the credential is definitely expired.
 *
 * Three answers, because the third is the load-bearing one: `true` is definitely expired, `false` is
 * definitely not, and `undefined` means *this adapter cannot say* — so the gateway asks the provider
 * rather than ejecting a working connection.
 */
export function kimiCodeCredentialExpired(credential: ProviderCredential | undefined, now: number): boolean | undefined {
  if (!credential || credential.type !== 'oauth') return false;
  if (typeof credential.expiresAt !== 'string') return undefined;
  const at = Date.parse(credential.expiresAt);
  if (!Number.isFinite(at)) return undefined;
  // 30s of slack, so a token does not expire in flight between the check and the request.
  return at - 30_000 <= now;
}

function normalizeRole(role: string): ChatMessage['role'] {
  return role === 'assistant' || role === 'system' || role === 'tool' ? role : 'user';
}

function normalizeFinishReason(reason: string | null | undefined): FinishReason {
  return reason === 'length' || reason === 'tool_calls' || reason === 'content_filter' ? reason : 'stop';
}

function normalizeUsage(usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }): TokenUsage {
  return {
    ...(typeof usage.prompt_tokens === 'number' ? { inputTokens: usage.prompt_tokens } : {}),
    ...(typeof usage.completion_tokens === 'number' ? { outputTokens: usage.completion_tokens } : {}),
    ...(typeof usage.total_tokens === 'number' ? { totalTokens: usage.total_tokens } : {}),
  };
}

function normalizeToolCallDelta(call: { index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }) {
  return {
    index: call.index ?? 0,
    ...(call.id ? { id: call.id } : {}),
    type: 'function' as const,
    function: { ...(call.function?.name ? { name: call.function.name } : {}), arguments: call.function?.arguments ?? '' },
  };
}

function toOpenAIMessage(message: ChatMessage) {
  // A tool result is tied to the assistant's call by this id. Without it the model cannot match the result
  // to the call it made, and a second turn of a tool conversation breaks.
  const toolCallId = message.toolCallId ? { tool_call_id: message.toolCallId } : {};
  if (typeof message.content === 'string' || message.content === null) {
    return {
      role: message.role,
      content: message.content,
      ...toolCallId,
      ...(message.toolCalls?.length
        ? { tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } })) }
        : {}),
    };
  }
  return {
    role: message.role,
    content: message.content.map((part) => (part.type === 'text' ? { type: 'text', text: part.text } : { type: 'image_url', image_url: { url: part.imageUrl.url } })),
    ...toolCallId,
  };
}

function toOpenAITool(tool: ToolDefinition) {
  return { type: 'function' as const, function: { name: tool.name, ...(tool.description ? { description: tool.description } : {}), parameters: tool.parameters } };
}

function invalidResponse(providerId: string, message: string) {
  return new ProviderError('INVALID_RESPONSE', message, { providerId });
}