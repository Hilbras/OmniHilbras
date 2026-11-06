import { ProviderError } from '../lib/errors.js';
import { parseSseJson, parseSseStream } from '../lib/streaming.js';
import { FetchHttpTransport, type HttpTransport } from '../lib/transport.js';
import { normalizeProviderBaseUrl, resolveProviderUrl, sanitizeProviderHeaders } from '../lib/url.js';

import type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  FinishReason,
  Model,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderCredential,
  ProviderHealth,
  ProviderRequestContext,
  TokenUsage,
  ToolDefinition,
} from '../lib/types.js';

export const KILOCODE = {
  server: 'https://api.kilo.ai',
  deviceAuthUrl: 'https://api.kilo.ai/api/device-auth/codes',
  profileUrl: 'https://api.kilo.ai/api/profile',
  modelsUrl: 'https://api.kilo.ai/api/gateway/models',
  chatPath: '/api/openrouter/chat/completions',
} as const;

export const kilocodeProviderId = 'kilocode';

export type KiloCodeAdapterOptions = {
  transport?: HttpTransport;
  timeoutMs?: number;
  onTokensRefreshed?: (credential: ProviderCredential) => void | Promise<void>;
  now?: () => number;
};

type DeviceAuthResponse = {
  code?: string;
  user_code?: string;
  device_code?: string;
  verificationUrl?: string;
  expiresIn?: number;
  error?: string;
};

type PollResponse = {
  status?: string;
  token?: string;
  userEmail?: string;
  error?: string;
  error_description?: string;
};

type ProfileResponse = {
  organizations?: Array<{ id?: string }>;
};

type OpenAIChatResponse = {
  id?: string;
  model?: string;
  created?: number;
  choices?: Array<{
    message?: { role?: string; content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

type OpenAIChatChunk = OpenAIChatResponse & {
  error?: { message?: string };
  choices?: Array<{
    delta?: { role?: string; content?: string | null; tool_calls?: Array<{ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }> };
    finish_reason?: string | null;
  }>;
};

type ModelCatalogItem = { id?: string; name?: string };

class KiloCodeAdapter implements ProviderAdapter {
  readonly id = kilocodeProviderId;
  readonly name = 'Kilo Code';
  readonly capabilities: ProviderCapabilities = { chat: true, streaming: true, models: true };

  private readonly baseUrl: string;
  private readonly transport: HttpTransport;

  constructor(options: KiloCodeAdapterOptions = {}) {
    this.baseUrl = normalizeProviderBaseUrl(KILOCODE.server, this.id);
    this.transport = options.transport ?? new FetchHttpTransport({ timeoutMs: options.timeoutMs });
  }

  /**
   * Kilo Code's custom device-auth flow.
   *
   * Kilo returns **three** identifiers, and they are not interchangeable (measured against the live
   * `api.kilo.ai` on a freshly issued grant):
   *
   * ```
   * { "code":"J7tRaIz…", "user_code":"KJCN-QX4Q", "device_code":"7BugHhSv…",
   *   "verificationUrl":"https://app.kilo.ai/device-auth?code=KJCN-QX4Q", "expiresIn":599 }
   *
   * GET …/codes/<code>         -> 202 {"status":"pending"}   ← the one that polls
   * GET …/codes/<device_code>  -> 410 {"status":"expired"}
   * GET …/codes/<user_code>    -> 410 {"status":"expired"}
   * ```
   *
   * So the poll presents **`code`**, despite its name; `device_code` is *not* what `/device-auth/codes`
   * polls with here (it answers `410`). `user_code` is the human-readable code the user types
   * (`KJCN-QX4Q`), and it is already inside `verificationUrl`.
   */
  async beginSignIn(): Promise<{ deviceCode: string; userCode: string; verificationUrl: string; expiresIn?: number }> {
    const response = await this.transport.request<DeviceAuthResponse>({
      method: 'POST',
      providerId: this.id,
      url: KILOCODE.deviceAuthUrl,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: '{}',
      tolerateRefusalBody: true,
    });

    if (response.status === 429) {
      throw new ProviderError('PROVIDER_REQUEST_FAILED', 'Too many pending authorization requests. Please try again later.', {
        providerId: this.id,
      });
    }
    const data = response.data ?? {};
    // `code` is the poll key (measured); `user_code` is what the user reads.
    const pollCode = typeof data.code === 'string' ? data.code : '';
    const userCode = typeof data.user_code === 'string' ? data.user_code : '';
    if (!pollCode) {
      throw new ProviderError('PROVIDER_REQUEST_FAILED', 'Kilo Code did not return a device code.', { providerId: this.id });
    }
    return {
      deviceCode: pollCode,
      userCode: userCode || pollCode.slice(0, 8).toUpperCase(),
      verificationUrl: (data.verificationUrl ?? 'https://kilocode.ai').trim(),
      ...(typeof data.expiresIn === 'number' ? { expiresIn: data.expiresIn } : {}),
    };
  }

  /**
   * Kilo Code answers status codes that normally mean failure: `202` is still-waiting, `403` is
   * denied, `410` is expired, and `200` with `status: approved` carries the token.
   */
  async pollSignIn(deviceCode: string, signal?: AbortSignal): Promise<
    | { status: 'pending' }
    | { status: 'denied'; error: string }
    | { status: 'expired'; error: string }
    | { status: 'connected'; credential: ProviderCredential; account: string }
  > {
    const response = await this.transport.request<PollResponse>({
      method: 'GET',
      providerId: this.id,
      url: `${KILOCODE.deviceAuthUrl}/${encodeURIComponent(deviceCode)}`,
      headers: { accept: 'application/json' },
      tolerateRefusalBody: true,
      ...(signal ? { signal } : {}),
    });

    if (response.status === 202) return { status: 'pending' };
    if (response.status === 403) return { status: 'denied', error: 'Authorization denied by Kilo Code.' };
    if (response.status === 410) return { status: 'expired', error: 'The device-auth code expired.' };
    if (response.status !== 200) {
      return { status: 'denied', error: `Kilo Code returned HTTP ${response.status} while polling.` };
    }

    const data = response.data ?? {};
    const token = typeof data.token === 'string' ? data.token : '';
    if (data.status !== 'approved' || !token) {
      return { status: 'denied', error: data.error_description ?? data.error ?? 'Kilo Code did not return an approved session.' };
    }

    let orgId: string | undefined;
    try {
      const profile = await this.transport.request<ProfileResponse>({
        method: 'GET',
        providerId: this.id,
        url: KILOCODE.profileUrl,
        headers: { accept: 'application/json', Authorization: `Bearer ${token}` },
      });
      orgId = profile.data?.organizations?.[0]?.id;
    } catch {
      // The profile is only needed for the org header; a missing one still leaves a usable token.
    }

    return {
      status: 'connected',
      credential: { type: 'oauth', value: token, ...(orgId ? { orgId } : {}) },
      account: 'Kilo Code account',
    };
  }

  async listModels(context: ProviderRequestContext = {}): Promise<Model[]> {
    const credential = await this.credential(context);
    const response = await this.transport.request<{ data?: ModelCatalogItem[] }>({
      method: 'GET',
      providerId: this.id,
      url: KILOCODE.modelsUrl,
      headers: this.requestHeaders(credential),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const rows = response.data?.data;
    if (!Array.isArray(rows)) return fallbackModels(this.id);
    return rows.flatMap((row) => (row.id ? [{ id: row.id, providerId: this.id, ...(row.name ? { displayName: row.name } : {}) }] : []));
  }

  async chat(request: ChatRequest, context: ProviderRequestContext = {}): Promise<ChatResponse> {
    const credential = await this.credential(context);
    const response = await this.transport.request<OpenAIChatResponse>({
      method: 'POST',
      providerId: this.id,
      url: resolveProviderUrl(this.baseUrl, KILOCODE.chatPath, this.id),
      headers: this.requestHeaders(credential),
      body: JSON.stringify(this.toRequestBody(request, false)),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    return this.toChatResponse(response.data, request.model);
  }

  async *streamChat(request: ChatRequest, context: ProviderRequestContext = {}): AsyncIterable<ChatChunk> {
    const credential = await this.credential(context);
    const events = this.transport.stream({
      method: 'POST',
      providerId: this.id,
      url: resolveProviderUrl(this.baseUrl, KILOCODE.chatPath, this.id),
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
      const payload = parseSseJson<OpenAIChatChunk>(event, this.id);
      if (!payload) continue;
      sawPayload = true;
      if (payload.error) {
        throw new ProviderError('PROVIDER_REQUEST_FAILED', payload.error.message ?? 'Kilo Code reported an error while streaming.', { providerId: this.id });
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
      throw new ProviderError('INVALID_RESPONSE', 'The Kilo Code stream ended before completion.', { providerId: this.id });
    }
  }

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

  isCredentialExpired(_credential: ProviderCredential | undefined, _now?: number): boolean | undefined {
    // Kilo Code issues a long-lived token with neither an expiry nor a refresh token, so this
    // adapter can never say a credential is expired.
    return false;
  }

  private async credential(context: ProviderRequestContext): Promise<ProviderCredential> {
    const current = context.credential;
    if (!current || current.type !== 'oauth' || !current.value) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'Kilo Code needs an OAuth sign-in.', { providerId: this.id });
    }
    return current;
  }

  private requestHeaders(credential: ProviderCredential): Record<string, string> {
    if (credential.type !== 'oauth' || !credential.value) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'Kilo Code needs an OAuth access token.', { providerId: this.id });
    }
    return sanitizeProviderHeaders(
      {
        accept: 'application/json',
        'content-type': 'application/json',
        Authorization: `Bearer ${credential.value}`,
        ...(credential.orgId ? { 'X-Kilocode-OrganizationID': credential.orgId } : {}),
      },
      this.id,
      { allowCredential: true },
    );
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
    if (request.toolChoice !== undefined) body.tool_choice = request.toolChoice;
    return body;
  }

  private toChatResponse(response: OpenAIChatResponse, requestedModel: string): ChatResponse {
    const choice = response.choices?.[0];
    if (!choice?.message) throw invalidResponse(this.id, 'Kilo Code returned no message.');
    return {
      id: response.id ?? `chat-${requestedModel}`,
      providerId: this.id,
      model: response.model ?? requestedModel,
      createdAt: new Date((typeof response.created === 'number' ? response.created : Date.now() / 1000) * 1000).toISOString(),
      message: { role: 'assistant', content: choice.message.content ?? '' },
      finishReason: normalizeFinishReason(choice.finish_reason),
      ...(response.usage ? { usage: normalizeUsage(response.usage) } : {}),
    };
  }
}

export function createKiloCodeAdapter(options: KiloCodeAdapterOptions = {}): ProviderAdapter {
  return new KiloCodeAdapter(options);
}

function fallbackModels(providerId: string): Model[] {
  return [
    'anthropic/claude-sonnet-4-20250514',
    'anthropic/claude-opus-4-20250514',
    'google/gemini-2.5-pro',
    'google/gemini-2.5-flash',
    'openai/gpt-4.1',
    'openai/o3',
    'deepseek/deepseek-chat',
    'deepseek/deepseek-reasoner',
  ].map((id) => ({ id, providerId }));
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
