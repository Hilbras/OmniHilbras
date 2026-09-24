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

export type GeminiAdapterOptions = {
  baseUrl?: string;
  headers?: Record<string, string>;
  transport?: HttpTransport;
  timeoutMs?: number;
};

type GeminiPart = {
  text?: string;
  functionCall?: { name?: string; args?: unknown };
  functionResponse?: { name?: string; response?: unknown };
  inlineData?: { mimeType?: string; data?: string };
  fileData?: { mimeType?: string; fileUri?: string };
};

type GeminiCandidate = {
  content?: { role?: string; parts?: GeminiPart[] };
  finishReason?: string;
  index?: number;
};

type GeminiResponse = {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
};

type GeminiModelList = {
  models?: Array<{
    name?: string;
    displayName?: string;
    inputTokenLimit?: number;
    supportedGenerationMethods?: string[];
  }>;
};

type GeminiStreamChunk = GeminiResponse;

const defaultBaseUrl = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiAdapter implements ProviderAdapter {
  readonly id = 'gemini';
  readonly name = 'Gemini';
  readonly capabilities: ProviderCapabilities = { chat: true, streaming: true, models: true };
  private readonly baseUrl: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly transport: HttpTransport;

  constructor(options: GeminiAdapterOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? defaultBaseUrl);
    this.defaultHeaders = options.headers ?? {};
    this.transport = options.transport ?? new FetchHttpTransport({ timeoutMs: options.timeoutMs });
  }

  async listModels(context: ProviderRequestContext = {}): Promise<Model[]> {
    const url = new URL('models', `${this.baseUrl}/`);
    url.searchParams.set('pageSize', '1000');
    const response = await this.transport.request<GeminiModelList>({
      method: 'GET',
      url: url.toString(),
      headers: this.requestHeaders(context.credential, 'application/json'),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const models = response.data?.models;
    if (!Array.isArray(models)) throw invalidResponse(this.id, 'Gemini model list is missing models.');

    return models.flatMap((model) => {
      if (!model.name) return [];
      return [{
        id: model.name.replace(/^models\//, ''),
        providerId: this.id,
        displayName: model.displayName,
        contextWindow: model.inputTokenLimit,
        capabilities: model.supportedGenerationMethods?.includes('generateContent') ? { chat: true } : undefined,
      }];
    });
  }

  async chat(request: ChatRequest, context: ProviderRequestContext = {}): Promise<ChatResponse> {
    const response = await this.transport.request<GeminiResponse>({
      method: 'POST',
      url: this.modelUrl(request.model, 'generateContent').toString(),
      headers: this.requestHeaders(context.credential, 'application/json'),
      body: JSON.stringify(this.toRequestBody(request)),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    return this.toChatResponse(response.data, request.model);
  }

  async *streamChat(request: ChatRequest, context: ProviderRequestContext = {}): AsyncIterable<ChatChunk> {
    const url = this.modelUrl(request.model, 'streamGenerateContent');
    url.searchParams.set('alt', 'sse');
    const events = this.transport.stream({
      method: 'POST',
      url: url.toString(),
      headers: this.requestHeaders(context.credential, 'text/event-stream'),
      body: JSON.stringify(this.toRequestBody(request)),
      ...(context.signal ? { signal: context.signal } : {}),
    });

    for await (const event of parseSseStream(events)) {
      const payload = parseSseJson<GeminiStreamChunk>(event, this.id);
      if (!payload) continue;
      const candidate = payload.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];
      const text = parts.filter((part) => part.text !== undefined).map((part) => part.text ?? '').join('');
      const toolCalls = parts.flatMap((part, partIndex) => part.functionCall ? [{
        index: partIndex,
        function: {
          name: part.functionCall.name ?? '',
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        },
      }] : []);
      const usage = payload.usageMetadata ? normalizeUsage(payload.usageMetadata) : undefined;
      const finishReason = candidate?.finishReason ? normalizeFinishReason(candidate.finishReason) : undefined;

      if (text || toolCalls.length || usage || finishReason) {
        yield {
          id: `stream-${request.model}`,
          providerId: this.id,
          model: request.model,
          delta: {
            ...(text ? { role: 'assistant', content: text } : {}),
            ...(toolCalls.length ? { toolCalls } : {}),
          },
          ...(finishReason ? { finishReason } : {}),
          ...(usage ? { usage } : {}),
        };
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

  private modelUrl(model: string, method: string) {
    const modelName = model.replace(/^models\//, '');
    return new URL(`models/${encodeURIComponent(modelName)}:${method}`, `${this.baseUrl}/`);
  }

  private requestHeaders(credential: ProviderCredential | undefined, accept: string) {
    if (credential?.type !== 'api-key') {
      throw new ProviderError('AUTHENTICATION_FAILED', `Missing API key for provider ${this.id}.`, { providerId: this.id });
    }
    return {
      accept,
      ...this.defaultHeaders,
      'content-type': 'application/json',
      'x-goog-api-key': credential.value,
    };
  }

  private toRequestBody(request: ChatRequest) {
    const system = request.messages.filter((message) => message.role === 'system').map((message) => contentToText(message.content)).filter(Boolean).join('\n\n');
    const body: Record<string, unknown> = {
      contents: request.messages.filter((message) => message.role !== 'system').map(toGeminiContent),
    };
    if (system) body.systemInstruction = { role: 'user', parts: [{ text: system }] };
    const generationConfig: Record<string, unknown> = {};
    if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
    if (request.topP !== undefined) generationConfig.topP = request.topP;
    if (request.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = request.maxOutputTokens;
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
    if (request.tools !== undefined) body.tools = [{ functionDeclarations: request.tools.map(toGeminiTool) }];
    return body;
  }

  private toChatResponse(response: GeminiResponse, requestedModel: string): ChatResponse {
    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts;
    if (!Array.isArray(parts)) throw invalidResponse(this.id, 'Gemini response is missing candidate parts.');

    const text = parts.filter((part) => part.text !== undefined).map((part) => part.text ?? '').join('');
    const toolCalls = parts.flatMap((part) => part.functionCall ? [normalizeToolCall(part.functionCall)] : []);
    if (!text && toolCalls.length === 0) throw invalidResponse(this.id, 'Gemini response did not contain text or a function call.');

    return {
      id: `gemini-${requestedModel}`,
      providerId: this.id,
      model: requestedModel,
      createdAt: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length ? { toolCalls } : {}),
      },
      finishReason: normalizeFinishReason(candidate?.finishReason),
      ...(response.usageMetadata ? { usage: normalizeUsage(response.usageMetadata) } : {}),
    };
  }
}

function toGeminiContent(message: ChatMessage) {
  if (message.role === 'tool') {
    return {
      role: 'user',
      parts: [{ functionResponse: { name: message.name ?? message.toolCallId ?? 'tool', response: { content: contentToText(message.content) } } }],
    };
  }

  const parts = toGeminiParts(message.content);
  if (message.role === 'assistant' && message.toolCalls?.length) {
    parts.push(...message.toolCalls.map((toolCall) => ({ functionCall: { name: toolCall.function.name, args: parseToolArguments(toolCall.function.arguments) } })));
  }
  return { role: message.role === 'assistant' ? 'model' : message.role, parts };
}

function toGeminiParts(content: MessageContent): GeminiPart[] {
  if (typeof content === 'string') return [{ text: content }];
  if (content === null) return [];
  return content.map((part) => {
    if (part.type === 'text') return { text: part.text };
    if (part.imageUrl.url.startsWith('data:')) {
      const match = part.imageUrl.url.match(/^data:([^;]+);base64,(.+)$/);
      if (match) return { inlineData: { mimeType: match[1], data: match[2] } };
    }
    return { fileData: { mimeType: 'image/*', fileUri: part.imageUrl.url } };
  });
}

function contentToText(content: MessageContent) {
  if (typeof content === 'string') return content;
  if (content === null) return '';
  return content.filter((part) => part.type === 'text').map((part) => part.text).join('');
}

function toGeminiTool(tool: ToolDefinition) {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function normalizeToolCall(toolCall: { name?: string; args?: unknown }): ToolCall {
  return { id: '', type: 'function', function: { name: toolCall.name ?? '', arguments: JSON.stringify(toolCall.args ?? {}) } };
}

function normalizeFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'STOP': return 'stop';
    case 'MAX_TOKENS': return 'length';
    case 'SAFETY':
    case 'RECITATION': return 'content_filter';
    case 'TOOL_CALL': return 'tool_calls';
    default: return reason ? 'other' : 'other';
  }
}

function normalizeUsage(usage: NonNullable<GeminiResponse['usageMetadata']>): TokenUsage {
  return {
    inputTokens: usage.promptTokenCount,
    outputTokens: usage.candidatesTokenCount,
    totalTokens: usage.totalTokenCount,
  };
}

function normalizeBaseUrl(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Unsupported protocol');
    return url.toString().replace(/\/$/, '');
  } catch (error) {
    throw new ProviderError('CONFIGURATION_ERROR', 'Invalid Gemini base URL.', { providerId: 'gemini', cause: error });
  }
}

function invalidResponse(providerId: string, message: string) {
  return new ProviderError('INVALID_RESPONSE', message, { providerId });
}
