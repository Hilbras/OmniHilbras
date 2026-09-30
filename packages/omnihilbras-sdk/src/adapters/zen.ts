import { ProviderError } from '../errors.js';
import { FetchHttpTransport } from '../transport.js';
import type { HttpTransport } from '../transport.js';
import { OpenAICompatibleAdapter } from './openai-compatible.js';
import type { ChatChunk, ChatMessage, ChatRequest, ChatResponse, CredentialValidation, FinishReason, Model, ProviderAdapter, ProviderCredential, ProviderHealth, ProviderRequestContext, TokenUsage } from '../types.js';

/**
 * OpenCode Zen serves one catalog through three different wire formats. Which
 * format a model uses is a property of the model, not of the connection, so a
 * single base URL can only ever serve part of the catalog. The published table
 * at `opencode.ai/docs/zen` is the source for the routing below.
 *
 * Anything not listed is served from the chat lane, which is the format Zen
 * documents for the remainder of the catalog.
 */
export const ZEN_BASE_URL = 'https://opencode.ai/zen';
export const ZEN_LANES = {
  chat: `${ZEN_BASE_URL}/v1/chat/completions`,
  messages: `${ZEN_BASE_URL}/v1/messages`,
  responses: `${ZEN_BASE_URL}/v1/responses`,
} as const;

export type ZenLane = keyof typeof ZEN_LANES;

/**
 * Model families with a published non-chat endpoint. Matched by prefix so a new
 * `claude-*` or `gpt-*` is routed correctly without a code change, and matched
 * against the id after any vendor prefix.
 */
const messagesFamily = /^claude-/;
const messagesExact = new Set(['qwen3.8-flash', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus', 'qwen3.5-plus', 'union-alpha']);
const responsesFamily = /^(gpt-|grok-|muse-spark-)/;

/** Models Zen serves from an endpoint this adapter does not implement. */
const unsupported = new Set(['jev-1.13', 'jev-1.13-free']);
const unsupportedFamily = /^gemini-/;

/** The lane a model is served from, and whether this adapter can speak it. */
export function zenLaneFor(model: string): { lane: ZenLane; supported: boolean } {
  const id = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
  if (unsupported.has(id) || unsupportedFamily.test(id)) return { lane: 'chat', supported: false };
  if (messagesFamily.test(id) || messagesExact.has(id)) return { lane: 'messages', supported: true };
  if (responsesFamily.test(id)) return { lane: 'responses', supported: true };
  return { lane: 'chat', supported: true };
}

function unsupportedLane(model: string, id: string) {
  const kind = unsupported.has(id) ? 'decision models on /zen/v1/systemone' : 'Gemini models on /zen/v1/models/{id}';
  return new ProviderError('NOT_SUPPORTED', `OpenCode Zen serves ${kind}, which this gateway does not implement. Skipping ${model}.`, {
    providerId: 'opencode',
    publicMessage: `OpenCode Zen serves ${kind}, which this gateway does not implement yet.`,
  });
}

/* ------------------------------------------------------------------ *
 * Responses lane
 * ------------------------------------------------------------------ */

type ResponsesInputItem = { role: string; content: Array<{ type: string; text: string }> };

/** Maps a message role onto the Responses input item role. */
function responsesRole(message: ChatMessage): string {
  if (message.role === 'assistant') return 'assistant';
  if (message.role === 'tool') return 'user';
  return 'user';
}

/** The Responses API takes content as typed parts rather than a bare string. */
function toResponsesInput(messages: readonly ChatMessage[]): ResponsesInputItem[] {
  return messages.map((message) => ({
    role: responsesRole(message),
    content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: messageText(message) }],
  }));
}

function messageText(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') return part.text;
      return '';
    })
    .join('');
}

function toResponsesBody(request: ChatRequest) {
  const body: Record<string, unknown> = {
    model: request.model,
    input: toResponsesInput(request.messages),
    stream: false,
  };
  if (request.maxOutputTokens !== undefined) body.max_output_tokens = request.maxOutputTokens;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.topP !== undefined) body.top_p = request.topP;
  if (request.stop?.length) body.stop = [...request.stop];
  return body;
}

type ResponsesPayload = {
  id?: string;
  model?: string;
  created_at?: number;
  status?: string;
  error?: { message?: string } | string;
  output?: Array<{
    type?: string;
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  output_text?: string;
  incomplete_details?: { reason?: string } | null;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
};

function responsesFinishReason(payload: ResponsesPayload): FinishReason {
  if (payload.incomplete_details?.reason === 'max_output_tokens') return 'length';
  const last = payload.output?.[payload.output.length - 1];
  if (last?.type === 'tool_call') return 'tool_calls';
  if (payload.status === 'incomplete') return 'length';
  return 'stop';
}

/** Concatenates the text parts of every output message. */
function responsesText(payload: ResponsesPayload): string {
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) return payload.output_text;
  const parts: string[] = [];
  for (const item of payload.output ?? []) {
    if (item.type && item.type !== 'message') continue;
    for (const part of item.content ?? []) {
      if (part.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
    }
  }
  return parts.join('');
}

function toResponsesChatResponse(payload: ResponsesPayload, requestedModel: string): ChatResponse {
  const text = responsesText(payload);
  return {
    id: payload.id ?? `response-${requestedModel}`,
    providerId: 'opencode',
    model: payload.model ?? requestedModel,
    createdAt: payload.created_at ? new Date(payload.created_at * 1000).toISOString() : new Date().toISOString(),
    message: { role: 'assistant', content: text },
    finishReason: responsesFinishReason(payload),
    usage: responsesUsage(payload.usage),
  };
}

function responsesUsage(usage: ResponsesPayload['usage']): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    ...(usage.input_tokens === undefined ? {} : { inputTokens: usage.input_tokens }),
    ...(usage.output_tokens === undefined ? {} : { outputTokens: usage.output_tokens }),
    ...(usage.total_tokens === undefined ? {} : { totalTokens: usage.total_tokens }),
  };
}

/* ------------------------------------------------------------------ *
 * Messages lane (Anthropic shape)
 * ------------------------------------------------------------------ */

type MessagesPayload = {
  id?: string;
  model?: string;
  content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
};

function messagesFinishReason(reason: string | undefined): FinishReason {
  if (reason === 'max_tokens') return 'length';
  if (reason === 'tool_use') return 'tool_calls';
  return 'stop';
}

function toMessagesBody(request: ChatRequest) {
  const system = request.messages.filter((message) => message.role === 'system').map(messageText).filter(Boolean);
  const messages = request.messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: messageText(message) }));
  const body: Record<string, unknown> = {
    model: request.model,
    messages,
    max_tokens: request.maxOutputTokens ?? 1024,
    stream: false,
  };
  if (system.length > 0) body.system = system.join('\n\n');
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.topP !== undefined) body.top_p = request.topP;
  if (request.stop?.length) body.stop = [...request.stop];
  return body;
}

function toMessagesChatResponse(payload: MessagesPayload, requestedModel: string): ChatResponse {
  const text = (payload.content ?? []).filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('');
  return {
    id: payload.id ?? `msg-${requestedModel}`,
    providerId: 'opencode',
    model: payload.model ?? requestedModel,
    createdAt: new Date().toISOString(),
    message: { role: 'assistant', content: text },
    finishReason: messagesFinishReason(payload.stop_reason),
    usage: payload.usage
      ? { inputTokens: payload.usage.input_tokens, outputTokens: payload.usage.output_tokens }
      : undefined,
  };
}

/* ------------------------------------------------------------------ *
 * Adapter
 * ------------------------------------------------------------------ */

export type ZenAdapterOptions = {
  transport?: HttpTransport;
  /** Overrides the model catalog endpoint, for tests. */
  modelsUrl?: string;
};

export class ZenAdapter implements ProviderAdapter {
  readonly id = 'opencode';
  readonly name = 'OpenCode Zen';
  readonly capabilities = { chat: true, streaming: false, models: true } as const;
  private readonly transport: HttpTransport;
  private readonly chatLane: OpenAICompatibleAdapter;
  private readonly modelsUrl: string;

  constructor(options: ZenAdapterOptions = {}) {
    this.transport = options.transport ?? new FetchHttpTransport();
    this.chatLane = new OpenAICompatibleAdapter(
      { id: 'opencode', name: 'OpenCode Zen', baseUrl: `${ZEN_BASE_URL}/v1`, auth: { header: 'Authorization', prefix: 'Bearer' } },
      { transport: this.transport },
    );
    this.modelsUrl = options.modelsUrl ?? `${ZEN_BASE_URL}/v1/models`;
  }

  async listModels(context: ProviderRequestContext = {}): Promise<Model[]> {
    const response = await this.transport.request<{ data?: Array<{ id?: string }> }>({
      method: 'GET',
      providerId: this.id,
      url: this.modelsUrl,
      headers: this.authHeaders(context.credential),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const data = response.data?.data;
    if (!Array.isArray(data)) {
      throw new ProviderError('INVALID_RESPONSE', 'The OpenCode Zen model list is missing data.', { providerId: this.id });
    }
    return data
      .map((entry) => (typeof entry?.id === 'string' ? entry.id.trim() : ''))
      .filter((id) => id.length > 0)
      .map((id) => ({ id, providerId: this.id, displayName: id }));
  }

  /**
   * The catalog is public, so a successful listing says nothing about a token.
   * A signed-in probe would cost a billable request on every health poll, so the
   * credential is checked for presence and shape only.
   */
  async validateCredential(credential: ProviderCredential | undefined): Promise<CredentialValidation> {
    if (credential?.type === 'none' || !credential?.value) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'An OpenCode Zen API key is required.', {
        providerId: this.id,
        publicMessage: 'An OpenCode Zen API key is required.',
      });
    }
    return { status: 'valid', checkedAt: new Date().toISOString() };
  }

  async chat(request: ChatRequest, context: ProviderRequestContext = {}): Promise<ChatResponse> {
    const { lane, supported } = zenLaneFor(request.model);
    const id = request.model.includes('/') ? request.model.slice(request.model.lastIndexOf('/') + 1) : request.model;
    if (!supported) throw unsupportedLane(request.model, id);

    if (lane === 'chat') return this.chatLane.chat(request, context);

    const isResponses = lane === 'responses';
    const response = await this.transport.request<ResponsesPayload | MessagesPayload>({
      method: 'POST',
      providerId: this.id,
      url: ZEN_LANES[lane],
      // The messages lane does not take a bearer token. It takes the raw key in
      // `x-api-key`, and sending `Authorization: Bearer` there is answered with a
      // 401 even when the key is valid.
      headers: isResponses
        ? this.authHeaders(context.credential)
        : this.apiKeyHeaders(context.credential),
      body: JSON.stringify(isResponses ? toResponsesBody(request) : toMessagesBody(request)),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const payload = response.data as ResponsesPayload & MessagesPayload;
    if (payload?.error) {
      const reason = typeof payload.error === 'string' ? payload.error : payload.error.message;
      throw new ProviderError('PROVIDER_REQUEST_FAILED', reason ? `OpenCode Zen rejected the request: ${reason}` : 'OpenCode Zen rejected the request.', {
        providerId: this.id,
        publicMessage: reason ? `OpenCode Zen rejected the request: ${reason}` : 'OpenCode Zen rejected the request.',
      });
    }
    return isResponses ? toResponsesChatResponse(payload, request.model) : toMessagesChatResponse(payload, request.model);
  }

  /**
   * Streaming is not implemented for the messages or responses lanes. Saying so
   * is better than silently answering without a stream, which would break a
   * client that is waiting for one.
   */
  async *streamChat(request: ChatRequest, context: ProviderRequestContext = {}): AsyncIterable<ChatChunk> {
    const { lane, supported } = zenLaneFor(request.model);
    const id = request.model.includes('/') ? request.model.slice(request.model.lastIndexOf('/') + 1) : request.model;
    if (!supported) throw unsupportedLane(request.model, id);
    if (lane !== 'chat') {
      throw new ProviderError('NOT_SUPPORTED', `Streaming is not implemented for OpenCode Zen models on the ${lane} lane.`, {
        providerId: this.id,
        publicMessage: `Streaming is not implemented for this OpenCode Zen model. Use a non-streaming request.`,
      });
    }
    yield* this.chatLane.streamChat(request, context);
  }

  /**
   * `credential`, not `inference`, and that word is the fix.
   *
   * Listing the catalog proves the key is accepted and the account is reachable. It does not prove a
   * single model can answer: measured against this provider, the free models are refused with
   * `FreeTierError` and paid ones with `Insufficient account funds`, while the catalog lists 84 models
   * happily. So this reports what it established, and the dashboard says what that means.
   */
  async healthCheck(context: ProviderRequestContext = {}): Promise<ProviderHealth> {
    try {
      await this.listModels(context);
      return { status: 'healthy', verified: 'credential', checkedAt: new Date().toISOString() };
    } catch (error) {
      return {
        status: 'unavailable',
        verified: 'credential',
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : 'The OpenCode Zen model list could not be read.',
      };
    }
  }

  /** The messages lane: raw key in `x-api-key`, plus the required version header. */
  private apiKeyHeaders(credential: ProviderCredential | undefined) {
    const value = credential?.type === 'none' ? '' : credential?.value ?? '';
    return {
      accept: 'application/json',
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(value ? { 'x-api-key': value } : {}),
    };
  }

  private authHeaders(credential: ProviderCredential | undefined, extra: Record<string, string> = {}) {
    const value = credential?.type === 'none' ? '' : credential?.value ?? '';
    return {
      accept: 'application/json',
      'content-type': 'application/json',
      ...extra,
      ...(value ? { Authorization: `Bearer ${value}` } : {}),
    };
  }
}
