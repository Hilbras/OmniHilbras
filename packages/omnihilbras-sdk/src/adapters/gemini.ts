import { ProviderError } from '../errors.js';
import { parseSseJson, parseSseStream } from '../streaming.js';
import { FetchHttpTransport, type HttpTransport } from '../transport.js';
import { assertSafeProviderHeaderValue, normalizeProviderBaseUrl, resolveProviderUrl, sanitizeProviderHeaders } from '../url.js';
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
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; status?: string; message?: string };
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
    this.baseUrl = normalizeProviderBaseUrl(options.baseUrl ?? defaultBaseUrl, this.id);
    this.defaultHeaders = sanitizeProviderHeaders(options.headers, this.id);
    this.transport = options.transport ?? new FetchHttpTransport({ timeoutMs: options.timeoutMs });
  }

  async listModels(context: ProviderRequestContext = {}): Promise<Model[]> {
    const url = new URL(this.url('models'));
    url.searchParams.set('pageSize', '1000');
    const response = await this.transport.request<GeminiModelList>({
      method: 'GET',
      providerId: this.id,
      url: url.toString(),
      headers: this.requestHeaders(context.credential, 'application/json'),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const models = response.data?.models;
    if (!Array.isArray(models)) throw invalidResponse(this.id, 'Gemini model list is missing models.');

    return models.flatMap((model) => {
      if (!model.name || !model.supportedGenerationMethods?.includes('generateContent')) return [];
      return [{
        id: model.name.replace(/^models\//, ''),
        providerId: this.id,
        displayName: model.displayName,
        contextWindow: model.inputTokenLimit,
        capabilities: { chat: true, streaming: model.supportedGenerationMethods.includes('streamGenerateContent') },
      }];
    });
  }

  async chat(request: ChatRequest, context: ProviderRequestContext = {}): Promise<ChatResponse> {
    const response = await this.transport.request<GeminiResponse>({
      method: 'POST',
      providerId: this.id,
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
      providerId: this.id,
      url: url.toString(),
      headers: this.requestHeaders(context.credential, 'text/event-stream'),
      body: JSON.stringify(this.toRequestBody(request)),
      ...(context.signal ? { signal: context.signal } : {}),
    });

    let sawPayload = false;
    let sawFinishReason = false;
    for await (const event of parseSseStream(events)) {
      const payload = parseSseJson<GeminiStreamChunk>(event, this.id);
      if (!payload) continue;
      sawPayload = true;
      if (payload.error) {
        throw new ProviderError('PROVIDER_REQUEST_FAILED', 'The Gemini stream returned an error.', { providerId: this.id });
      }

      const candidate = payload.candidates?.[0];
      if (!candidate) {
        if (payload.promptFeedback?.blockReason) {
          sawFinishReason = true;
          yield {
            id: `stream-${request.model}`,
            providerId: this.id,
            model: request.model,
            delta: {},
            finishReason: 'content_filter',
          };
          continue;
        }
        throw invalidResponse(this.id, 'Gemini stream response is missing a candidate.');
      }

      const parts = candidate.content?.parts;
      if (!Array.isArray(parts)) {
        if (candidate.finishReason && isSafetyFinishReason(candidate.finishReason)) {
          sawFinishReason = true;
          yield {
            id: `stream-${request.model}`,
            providerId: this.id,
            model: request.model,
            delta: {},
            finishReason: 'content_filter',
          };
          continue;
        }
        throw invalidResponse(this.id, 'Gemini stream response is missing candidate parts.');
      }

      const text = parts.filter((part) => part.text !== undefined).map((part) => part.text ?? '').join('');
      const toolCalls = parts.flatMap((part, partIndex) => part.functionCall ? [{
        index: partIndex,
        id: `gemini-${partIndex}-${part.functionCall.name ?? 'tool'}`,
        function: {
          name: part.functionCall.name ?? '',
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        },
      }] : []);
      const usage = payload.usageMetadata ? normalizeUsage(payload.usageMetadata) : undefined;
      const finishReason = candidate?.finishReason ? normalizeFinishReason(candidate.finishReason) : undefined;
      if (finishReason) sawFinishReason = true;

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

    if (!sawPayload || !sawFinishReason) {
      throw new ProviderError('INVALID_RESPONSE', 'The Gemini stream returned no response data.', { providerId: this.id });
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
    return resolveProviderUrl(this.baseUrl, path, this.id);
  }

  private modelUrl(model: string, method: string) {
    const modelName = model.replace(/^models\//, '');
    return new URL(resolveProviderUrl(this.baseUrl, `models/${encodeURIComponent(modelName)}:${method}`, this.id));
  }

  private requestHeaders(credential: ProviderCredential | undefined, accept: string) {
    if (credential?.type !== 'api-key') {
      throw new ProviderError('AUTHENTICATION_FAILED', `Missing API key for provider ${this.id}.`, { providerId: this.id });
    }
    assertSafeProviderHeaderValue('x-goog-api-key', credential.value, this.id);
    return {
      accept,
      ...this.defaultHeaders,
      'content-type': 'application/json',
      'x-goog-api-key': credential.value,
    };
  }

  private toRequestBody(request: ChatRequest) {
    assertNoProviderOptions(request, this.id);
    const system = request.messages.filter((message) => message.role === 'system').map((message) => contentToText(message.content)).filter(Boolean).join('\n\n');
    const toolNames = new Map<string, string>();
    for (const message of request.messages) {
      if (message.role === 'assistant') {
        for (const toolCall of message.toolCalls ?? []) toolNames.set(toolCall.id, toolCall.function.name);
      }
    }
    const body: Record<string, unknown> = {
      contents: request.messages.filter((message) => message.role !== 'system').map((message) => toGeminiContent(message, toolNames)),
    };
    if (system) body.systemInstruction = { role: 'user', parts: [{ text: system }] };
    const generationConfig: Record<string, unknown> = {};
    if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
    if (request.topP !== undefined) generationConfig.topP = request.topP;
    if (request.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = request.maxOutputTokens;
    if (request.stop !== undefined) generationConfig.stopSequences = [...request.stop];
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
    if (request.tools !== undefined) body.tools = [{ functionDeclarations: request.tools.map(toGeminiTool) }];
    return body;
  }

  private toChatResponse(response: GeminiResponse, requestedModel: string): ChatResponse {
    const candidate = response.candidates?.[0];
    if (!candidate && response.promptFeedback?.blockReason) return contentFilterResponse(this.id, requestedModel);
    if (!candidate) throw invalidResponse(this.id, 'Gemini response is missing a candidate.');

    const parts = candidate.content?.parts;
    if (!Array.isArray(parts)) throw invalidResponse(this.id, 'Gemini response is missing candidate parts.');

    const text = parts.filter((part) => part.text !== undefined).map((part) => part.text ?? '').join('');
    const toolCalls = parts.flatMap((part, index) => part.functionCall ? [normalizeToolCall(part.functionCall, index)] : []);
    if (!text && toolCalls.length === 0) {
      if (candidate.finishReason && isSafetyFinishReason(candidate.finishReason)) return contentFilterResponse(this.id, requestedModel);
      throw invalidResponse(this.id, 'Gemini response did not contain text or a function call.');
    }

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
      finishReason: normalizeFinishReason(candidate.finishReason),
      ...(response.usageMetadata ? { usage: normalizeUsage(response.usageMetadata) } : {}),
    };
  }
}

function assertNoProviderOptions(request: ChatRequest, providerId: string) {
  if (request.providerOptions && Object.keys(request.providerOptions).length > 0) {
    throw new ProviderError('INVALID_REQUEST', `Provider options are not supported by ${providerId} yet.`, { providerId });
  }
}

function toGeminiContent(message: ChatMessage, toolNames: Map<string, string>) {
  if (message.role === 'tool') {
    const name = message.name ?? (message.toolCallId ? toolNames.get(message.toolCallId) : undefined);
    if (!name) throw new ProviderError('INVALID_REQUEST', 'Gemini tool results must include a function name.', { providerId: 'gemini' });
    return {
      role: 'user',
      parts: [{ functionResponse: { name, response: { content: contentToText(message.content) } } }],
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
      const match = part.imageUrl.url.match(/^data:([^;]+);base64,(.+)$/i);
      if (!match) throw new ProviderError('INVALID_REQUEST', 'Gemini image data URLs must be base64 encoded.', { providerId: 'gemini' });
      return { inlineData: { mimeType: match[1], data: match[2] } };
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

function normalizeToolCall(toolCall: { name?: string; args?: unknown }, index: number): ToolCall {
  const name = toolCall.name ?? '';
  return { id: `gemini-${index}-${name || 'tool'}`, type: 'function', function: { name, arguments: JSON.stringify(toolCall.args ?? {}) } };
}

function normalizeFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'STOP': return 'stop';
    case 'MAX_TOKENS': return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST':
    case 'SPII': return 'content_filter';
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

function isSafetyFinishReason(reason: string) {
  return ['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(reason);
}

function contentFilterResponse(providerId: string, model: string): ChatResponse {
  return {
    id: `gemini-${model}`,
    providerId,
    model,
    createdAt: new Date().toISOString(),
    message: { role: 'assistant', content: null },
    finishReason: 'content_filter',
  };
}

function invalidResponse(providerId: string, message: string) {
  return new ProviderError('INVALID_RESPONSE', message, { providerId });
}
