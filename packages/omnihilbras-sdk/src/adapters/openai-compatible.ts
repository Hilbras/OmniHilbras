import { ProviderError } from '../errors.js';
import { parseSseJson, parseSseStream } from '../streaming.js';
import { FetchHttpTransport, type HttpTransport } from '../transport.js';
import type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  FinishReason,
  MessageContent,
  Model,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderCredential,
  ProviderRequestContext,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from '../types.js';

export type OpenAICompatibleAuth = {
  header?: string;
  prefix?: string;
  required?: boolean;
};

export type OpenAICompatibleAdapterConfig = {
  id: string;
  name: string;
  baseUrl: string;
  auth?: OpenAICompatibleAuth;
  modelsPath?: string;
  chatPath?: string;
  headers?: Record<string, string>;
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  capabilities?: ProviderCapabilities;
};

export type OpenAICompatibleAdapterOptions = {
  transport?: HttpTransport;
  timeoutMs?: number;
};

type OpenAIChoice = {
  message?: {
    role?: string;
    content?: string | null;
    tool_calls?: Array<{
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason?: string | null;
};

type OpenAIResponse = {
  id?: string;
  model?: string;
  created?: number;
  choices?: OpenAIChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

type OpenAIStreamChunk = OpenAIResponse & {
  error?: { message?: string };
  choices?: Array<{
    delta?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
};

type OpenAIModelList = {
  data?: Array<{ id?: string; owned_by?: string }>;
};

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  private readonly baseUrl: string;
  private readonly auth: Required<Pick<OpenAICompatibleAuth, 'required'>> & OpenAICompatibleAuth;
  private readonly modelsPath: string;
  private readonly chatPath: string;
  private readonly headers: Record<string, string>;
  private readonly maxTokensField: 'max_tokens' | 'max_completion_tokens';
  private readonly transport: HttpTransport;

  constructor(config: OpenAICompatibleAdapterConfig, options: OpenAICompatibleAdapterOptions = {}) {
    this.id = config.id;
    this.name = config.name;
    this.baseUrl = normalizeBaseUrl(config.baseUrl, config.id);
    this.auth = {
      header: config.auth?.header ?? (config.auth?.required === false ? undefined : 'Authorization'),
      prefix: config.auth?.prefix ?? (config.auth?.header ? undefined : 'Bearer'),
      required: config.auth?.required ?? true,
    };
    this.modelsPath = config.modelsPath ?? '/models';
    this.chatPath = config.chatPath ?? '/chat/completions';
    this.headers = config.headers ?? {};
    this.maxTokensField = config.maxTokensField ?? 'max_tokens';
    this.capabilities = {
      chat: true,
      streaming: true,
      models: true,
      ...config.capabilities,
    };
    this.transport = options.transport ?? new FetchHttpTransport({ timeoutMs: options.timeoutMs });
  }

  async listModels(context: ProviderRequestContext = {}): Promise<Model[]> {
    const response = await this.transport.request<OpenAIModelList>({
      method: 'GET',
      url: this.url(this.modelsPath),
      headers: this.requestHeaders(context.credential, 'application/json'),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const data = response.data?.data;
    if (!Array.isArray(data)) throw invalidResponse(this.id, 'Provider model list is missing data.');

    return data.flatMap((model) => model.id ? [{ id: model.id, providerId: this.id, ownedBy: model.owned_by }] : []);
  }

  async chat(request: ChatRequest, context: ProviderRequestContext = {}): Promise<ChatResponse> {
    const response = await this.transport.request<OpenAIResponse>({
      method: 'POST',
      url: this.url(this.chatPath),
      headers: this.requestHeaders(context.credential, 'application/json'),
      body: JSON.stringify(this.toRequestBody(request, false)),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    return this.toChatResponse(response.data, request.model);
  }

  async *streamChat(request: ChatRequest, context: ProviderRequestContext = {}): AsyncIterable<ChatChunk> {
    const events = this.transport.stream({
      method: 'POST',
      url: this.url(this.chatPath),
      headers: this.requestHeaders(context.credential, 'text/event-stream'),
      body: JSON.stringify(this.toRequestBody(request, true)),
      ...(context.signal ? { signal: context.signal } : {}),
    });

    for await (const event of parseSseStream(events)) {
      const payload = parseSseJson<OpenAIStreamChunk>(event, this.id);
      if (!payload) continue;
      if (payload.error) throw providerStreamError(this.id, payload.error);

      const choice = payload.choices?.[0];
      const delta = choice?.delta;
      const chunk: ChatChunk = {
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
      yield chunk;
    }
  }

  async healthCheck(context: ProviderRequestContext = {}) {
    const startedAt = performance.now();
    try {
      await this.listModels(context);
      return { status: 'healthy' as const, latencyMs: Math.round(performance.now() - startedAt), checkedAt: new Date().toISOString() };
    } catch {
      return { status: 'unavailable' as const, checkedAt: new Date().toISOString() };
    }
  }

  private url(path: string) {
    return new URL(path.replace(/^\/+/, ''), `${this.baseUrl}/`).toString();
  }

  private requestHeaders(credential: ProviderCredential | undefined, accept: string) {
    const headers: Record<string, string> = {
      accept,
      ...this.headers,
    };
    if (credential?.type === 'api-key' && this.auth.header) {
      headers[this.auth.header] = this.auth.prefix ? `${this.auth.prefix} ${credential.value}` : credential.value;
    } else if (this.auth.required) {
      throw new ProviderError('AUTHENTICATION_FAILED', `Missing API key for provider ${this.id}.`, { providerId: this.id });
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
    if (request.maxOutputTokens !== undefined) body[this.maxTokensField] = request.maxOutputTokens;
    if (request.stop !== undefined) body.stop = request.stop;
    if (request.tools !== undefined) body.tools = request.tools.map(toOpenAITool);
    return body;
  }

  private toChatResponse(response: OpenAIResponse, requestedModel: string): ChatResponse {
    const choice = response.choices?.[0];
    if (!choice?.message) throw invalidResponse(this.id, 'Provider chat response is missing a message.');

    return {
      id: response.id ?? `response-${requestedModel}`,
      providerId: this.id,
      model: response.model ?? requestedModel,
      createdAt: response.created ? new Date(response.created * 1000).toISOString() : new Date().toISOString(),
      message: {
        role: 'assistant',
        content: choice.message.content ?? null,
        ...(choice.message.tool_calls?.length ? { toolCalls: choice.message.tool_calls.map(normalizeToolCall) } : {}),
      },
      finishReason: normalizeFinishReason(choice.finish_reason),
      ...(response.usage ? { usage: normalizeUsage(response.usage) } : {}),
    };
  }
}

function normalizeBaseUrl(baseUrl: string, providerId: string) {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Unsupported protocol');
    return url.toString().replace(/\/$/, '');
  } catch (error) {
    throw new ProviderError('CONFIGURATION_ERROR', `Invalid base URL for provider ${providerId}.`, { providerId, cause: error });
  }
}

function toOpenAIMessage(message: ChatMessage) {
  return {
    role: message.role,
    content: toOpenAIContent(message.content),
    ...(message.name ? { name: message.name } : {}),
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map(toOpenAIToolCall) } : {}),
  };
}

function toOpenAIContent(content: MessageContent) {
  if (content === null || typeof content === 'string') return content;
  return content.map((part) => part.type === 'text' ? { type: 'text', text: part.text } : part);
}

function toOpenAITool(tool: ToolDefinition) {
  return { type: 'function', function: tool };
}

function toOpenAIToolCall(toolCall: ToolCall) {
  return { id: toolCall.id, type: 'function', function: toolCall.function };
}

function normalizeToolCall(toolCall: { id?: string; type?: string; function?: { name?: string; arguments?: string } }): ToolCall {
  return {
    id: toolCall.id ?? '',
    type: 'function',
    function: { name: toolCall.function?.name ?? '', arguments: toolCall.function?.arguments ?? '{}' },
  };
}

function normalizeToolCallDelta(toolCall: { index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }) {
  return {
    index: toolCall.index ?? 0,
    ...(toolCall.id ? { id: toolCall.id } : {}),
    ...(toolCall.type ? { type: 'function' as const } : {}),
    ...(toolCall.function?.name || toolCall.function?.arguments ? { function: {
      ...(toolCall.function.name ? { name: toolCall.function.name } : {}),
      ...(toolCall.function.arguments ? { arguments: toolCall.function.arguments } : {}),
    } } : {}),
  };
}

function normalizeRole(role: string): ChatMessage['role'] {
  return role === 'assistant' || role === 'system' || role === 'tool' ? role : 'user';
}

function normalizeFinishReason(reason: string | null | undefined): FinishReason {
  if (reason === 'stop' || reason === 'length' || reason === 'tool_calls' || reason === 'content_filter') return reason;
  if (reason === 'function_call') return 'tool_calls';
  return reason ? 'other' : 'other';
}

function normalizeUsage(usage: NonNullable<OpenAIResponse['usage']>): TokenUsage {
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
}

function providerStreamError(providerId: string, error: unknown) {
  const message = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : 'Provider stream returned an error.';
  return new ProviderError('PROVIDER_REQUEST_FAILED', message, { providerId, details: error });
}

function invalidResponse(providerId: string, message: string) {
  return new ProviderError('INVALID_RESPONSE', message, { providerId });
}
