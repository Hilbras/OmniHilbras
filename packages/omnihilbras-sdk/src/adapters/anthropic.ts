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

export type AnthropicAdapterOptions = {
  baseUrl?: string;
  apiVersion?: string;
  defaultMaxTokens?: number;
  headers?: Record<string, string>;
  transport?: HttpTransport;
  timeoutMs?: number;
};

type AnthropicContentBlock = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  source?: { type?: string; url?: string; media_type?: string; data?: string };
};

type AnthropicMessageResponse = {
  id?: string;
  model?: string;
  content?: AnthropicContentBlock[];
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
};

type AnthropicModelList = {
  data?: Array<{
    id?: string;
    display_name?: string;
    max_input_tokens?: number;
  }>;
};

type AnthropicStreamEvent = {
  type?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  index?: number;
  content_block?: AnthropicContentBlock;
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
};

const defaultApiVersion = '2023-06-01';
const defaultMaxTokens = 4096;

export class AnthropicAdapter implements ProviderAdapter {
  readonly id = 'anthropic';
  readonly name = 'Anthropic';
  readonly capabilities: ProviderCapabilities = { chat: true, streaming: true, models: true };
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly defaultMaxTokens: number;
  private readonly defaultHeaders: Record<string, string>;
  private readonly transport: HttpTransport;

  constructor(options: AnthropicAdapterOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? 'https://api.anthropic.com');
    this.apiVersion = options.apiVersion ?? defaultApiVersion;
    this.defaultMaxTokens = options.defaultMaxTokens ?? defaultMaxTokens;
    this.defaultHeaders = options.headers ?? {};
    this.transport = options.transport ?? new FetchHttpTransport({ timeoutMs: options.timeoutMs });
  }

  async listModels(context: ProviderRequestContext = {}): Promise<Model[]> {
    const url = new URL('v1/models', `${this.baseUrl}/`);
    url.searchParams.set('limit', '1000');
    const response = await this.transport.request<AnthropicModelList>({
      method: 'GET',
      url: url.toString(),
      headers: this.requestHeaders(context.credential, 'application/json'),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const data = response.data?.data;
    if (!Array.isArray(data)) throw invalidResponse(this.id, 'Anthropic model list is missing data.');

    return data.flatMap((model) => model.id ? [{
      id: model.id,
      providerId: this.id,
      displayName: model.display_name,
      contextWindow: model.max_input_tokens,
    }] : []);
  }

  async chat(request: ChatRequest, context: ProviderRequestContext = {}): Promise<ChatResponse> {
    const response = await this.transport.request<AnthropicMessageResponse>({
      method: 'POST',
      url: this.url('v1/messages'),
      headers: this.requestHeaders(context.credential, 'application/json'),
      body: JSON.stringify(this.toRequestBody(request, false)),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    return this.toChatResponse(response.data, request.model);
  }

  async *streamChat(request: ChatRequest, context: ProviderRequestContext = {}): AsyncIterable<ChatChunk> {
    const events = this.transport.stream({
      method: 'POST',
      url: this.url('v1/messages'),
      headers: this.requestHeaders(context.credential, 'text/event-stream'),
      body: JSON.stringify(this.toRequestBody(request, true)),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const toolBlocks = new Map<number, { id?: string; name?: string }>();
    let responseId = `stream-${request.model}`;
    let responseModel = request.model;

    for await (const event of parseSseStream(events)) {
      const payload = parseSseJson<AnthropicStreamEvent>(event, this.id);
      if (!payload) continue;
      if (event.event === 'error' || payload.type === 'error') {
        throw new ProviderError('PROVIDER_REQUEST_FAILED', payload.error?.message ?? 'Anthropic stream returned an error.', {
          providerId: this.id,
          details: payload.error,
        });
      }

      if (payload.type === 'message_start') {
        responseId = payload.message?.id ?? responseId;
        responseModel = payload.message?.model ?? responseModel;
        continue;
      }

      if (payload.type === 'content_block_start' && payload.index !== undefined && payload.content_block?.type === 'tool_use') {
        toolBlocks.set(payload.index, { id: payload.content_block.id, name: payload.content_block.name });
        continue;
      }

      if (payload.type === 'content_block_delta' && payload.index !== undefined && payload.delta) {
        const block = toolBlocks.get(payload.index);
        if (payload.delta.type === 'text_delta' && payload.delta.text !== undefined) {
          yield {
            id: responseId,
            providerId: this.id,
            model: responseModel,
            delta: { role: 'assistant', content: payload.delta.text },
          };
        } else if (payload.delta.type === 'input_json_delta' && payload.delta.partial_json !== undefined) {
          yield {
            id: responseId,
            providerId: this.id,
            model: responseModel,
            delta: {
              toolCalls: [{
                index: payload.index,
                ...(block?.id ? { id: block.id } : {}),
                ...(block?.name ? { function: { name: block.name, arguments: payload.delta.partial_json } } : { function: { arguments: payload.delta.partial_json } }),
              }],
            },
          };
        }
        continue;
      }

      if (payload.type === 'message_delta') {
        const finishReason = payload.delta?.stop_reason ? normalizeFinishReason(payload.delta.stop_reason) : undefined;
        const usage = payload.usage ? normalizeUsage(payload.usage) : undefined;
        if (finishReason || usage) {
          yield {
            id: responseId,
            providerId: this.id,
            model: responseModel,
            delta: {},
            ...(finishReason ? { finishReason } : {}),
            ...(usage ? { usage } : {}),
          };
        }
      }
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
    if (credential?.type !== 'api-key') {
      throw new ProviderError('AUTHENTICATION_FAILED', `Missing API key for provider ${this.id}.`, { providerId: this.id });
    }
    return {
      accept,
      ...this.defaultHeaders,
      'content-type': 'application/json',
      'anthropic-version': this.apiVersion,
      'x-api-key': credential.value,
    };
  }

  private toRequestBody(request: ChatRequest, stream: boolean) {
    const system = request.messages.filter((message) => message.role === 'system').map((message) => contentToText(message.content)).filter(Boolean).join('\n\n');
    const messages = request.messages.filter((message) => message.role !== 'system').map(toAnthropicMessage);
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxOutputTokens ?? this.defaultMaxTokens,
      messages,
      stream,
    };
    if (system) body.system = system;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.topP !== undefined) body.top_p = request.topP;
    if (request.stop !== undefined) body.stop_sequences = request.stop;
    if (request.tools !== undefined) body.tools = request.tools.map(toAnthropicTool);
    return body;
  }

  private toChatResponse(response: AnthropicMessageResponse, requestedModel: string): ChatResponse {
    const blocks = response.content;
    if (!Array.isArray(blocks)) throw invalidResponse(this.id, 'Anthropic response is missing content blocks.');

    const text = blocks.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('');
    const toolCalls = blocks.filter((block) => block.type === 'tool_use').map(normalizeToolUse);
    if (!text && toolCalls.length === 0) throw invalidResponse(this.id, 'Anthropic response did not contain text or tool use.');

    return {
      id: response.id ?? `response-${requestedModel}`,
      providerId: this.id,
      model: response.model ?? requestedModel,
      createdAt: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length ? { toolCalls } : {}),
      },
      finishReason: normalizeFinishReason(response.stop_reason),
      ...(response.usage ? { usage: normalizeUsage(response.usage) } : {}),
    };
  }
}

function toAnthropicMessage(message: ChatMessage) {
  if (message.role === 'tool') {
    return {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: message.toolCallId ?? '', content: contentToText(message.content) }],
    };
  }

  const content = toAnthropicContent(message.content);
  if (message.role === 'assistant' && message.toolCalls?.length) {
    const toolBlocks = message.toolCalls.map((toolCall) => ({ type: 'tool_use', id: toolCall.id, name: toolCall.function.name, input: parseToolArguments(toolCall.function.arguments) }));
    return { role: message.role, content: [...content, ...toolBlocks] };
  }
  return { role: message.role, content };
}

function toAnthropicContent(content: MessageContent): Array<Record<string, unknown>> {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (content === null) return [];
  return content.map((part) => part.type === 'text'
    ? { type: 'text', text: part.text }
    : { type: 'image', source: { type: 'url', url: part.imageUrl.url } });
}

function contentToText(content: MessageContent) {
  if (typeof content === 'string') return content;
  if (content === null) return '';
  return content.filter((part) => part.type === 'text').map((part) => part.text).join('');
}

function toAnthropicTool(tool: ToolDefinition) {
  return { name: tool.name, description: tool.description, input_schema: tool.parameters };
}

function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function normalizeToolUse(block: AnthropicContentBlock): ToolCall {
  return {
    id: block.id ?? '',
    type: 'function',
    function: { name: block.name ?? '', arguments: JSON.stringify(block.input ?? {}) },
  };
}

function normalizeFinishReason(reason: string | null | undefined): FinishReason {
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'stop';
  if (reason === 'max_tokens') return 'length';
  if (reason === 'tool_use') return 'tool_calls';
  if (reason === 'refusal') return 'content_filter';
  return reason ? 'other' : 'other';
}

function normalizeUsage(usage: { input_tokens?: number; output_tokens?: number }): TokenUsage {
  return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
}

function normalizeBaseUrl(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Unsupported protocol');
    return url.toString().replace(/\/$/, '');
  } catch (error) {
    throw new ProviderError('CONFIGURATION_ERROR', 'Invalid Anthropic base URL.', { providerId: 'anthropic', cause: error });
  }
}

function invalidResponse(providerId: string, message: string) {
  return new ProviderError('INVALID_RESPONSE', message, { providerId });
}
