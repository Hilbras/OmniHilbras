import { ProviderError } from '../../core/errors.js';
import { FetchHttpTransport } from '../../core/transport.js';
import type { HttpTransport } from '../../core/transport.js';
import { OpenAICompatibleAdapter } from '../openai-compatible/index.js';
import { parseSseJson, parseSseStream } from '../../core/streaming.js';
import { ZEN_FINGERPRINT_TOOL_NAMES, isZenFreeTierRefusal, zenFingerprintTools, zenFreeTierHeaders, zenSessionId, zenContractSatisfied, zenConversationSeed } from './zen-free-tier.js';
import type { ChatChunk, ChatMessage, ChatRequest, ChatResponse, CredentialValidation, FinishReason, Model, ProviderAdapter, ProviderCredential, ProviderHealth, ProviderRequestContext, TokenUsage, ToolDefinition } from '../../core/types.js';

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

/* ------------------------------------------------------------------ *
 * Free-tier gated request
 * ------------------------------------------------------------------ */

/** The slice of an OpenAI chat stream this adapter reads. */
type GatedStreamChunk = {
  id?: string;
  choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
  error?: { message?: string } | string;
};

function toGatedMessage(message: ChatMessage) {
  return {
    role: message.role,
    content: messageText(message),
    ...(message.name ? { name: message.name } : {}),
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
  };
}

/**
 * A tool in the shape the upstream expects.
 *
 * Kept local rather than imported because `openai-compatible.ts` keeps its own copy private, and a
 * second export used once would be a wider surface than the duplication is worth.
 */
function toGatedTool(tool: ToolDefinition) {
  return {
    type: 'function' as const,
    function: { name: tool.name, ...(tool.description ? { description: tool.description } : {}), parameters: tool.parameters },
  };
}

export function gatedTools(tools: readonly ToolDefinition[] | undefined) {
  const quartet = new Set<string>(ZEN_FINGERPRINT_TOOL_NAMES);
  const seen = new Set<string>();
  const out: ReturnType<typeof toGatedTool>[] = [];
  for (const tool of tools ?? []) {
    const lower = tool.name.trim().toLowerCase();
    const name = quartet.has(lower) ? lower : tool.name;
    if (quartet.has(lower)) {
      if (seen.has(lower)) continue;
      seen.add(lower);
    }
    out.push(toGatedTool({ ...tool, name }));
  }
  for (const name of ZEN_FINGERPRINT_TOOL_NAMES) {
    if (!seen.has(name)) out.push(...zenFingerprintTools().filter((tool) => tool.function.name === name));
  }
  return out;
}

function toGatedFinishReason(reason: string): FinishReason {
  const map: Record<string, FinishReason> = {
    stop: 'stop', length: 'length', tool_calls: 'tool_calls', function_call: 'tool_calls', content_filter: 'content_filter',
  };
  return map[reason] ?? 'stop';
}

/**
 * The upstream's own words, wherever they ended up.
 *
 * Two shapes reach here: a payload envelope from the stream (`{error: {message}}`), and the
 * `ProviderError` the transport raised, which carries the provider's text in `details.providerMessage`.
 * Reading only the first is what produced a bare "The provider refused the request." on every gated
 * model — the cause was in hand and the code was not looking at it.
 */
function readGatedErrorReason(payload: unknown): string | undefined {
  const details = (payload as { details?: { providerMessage?: unknown } } | undefined)?.details;
  if (typeof details?.providerMessage === 'string') return details.providerMessage;
  const error = (payload as { error?: unknown } | undefined)?.error;
  if (typeof error === 'string') return error;
  const message = (error as { message?: unknown } | undefined)?.message;
  if (typeof message === 'string') return message;
  return typeof (payload as { message?: unknown } | undefined)?.message === 'string'
    ? (payload as { message: string }).message
    : undefined;
}

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

/**
 * Whether a model is on the gated free tier, and so needs the request contract.
 *
 * The suffix is the whole test rather than a list, because **the upstream rotates its free lineup** —
 * OmniRoute records `minimax-m2.5-free`, `ling-2.6-1t-free` and three others being delisted and
 * replaced within a week. A list would be stale the day after it was written and would keep serving
 * models that no longer exist while refusing ones that do. A suffix tracks the tier.
 */
function isFreeTierModel(id: string): boolean {
  return /-free$/.test(id);
}

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

    if (lane === 'chat') {
      // Free-tier models need the request contract, which the delegated chat lane knows nothing
      // about — it sends `stream: false` and whatever tools the caller declared, which is a refusal.
      if (isFreeTierModel(id)) return this.gatedChat(request, context);
      return this.chatLane.chat(request, context);
    }

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
    if (isFreeTierModel(id)) {
      // The contract requires a stream, so a free model is streamed upstream **regardless** of what the
      // caller asked for — `gatedChat` aggregates that same stream back into one response. Asking
      // upstream for JSON instead is refused with `FreeTierError`, so there is no other path to take.
      yield* this.streamGated(request, context);
      return;
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

  /**
   * A free-tier chat, with the request contract applied.
   *
   * The contract requires `stream: true`, so this always sends a stream and re-aggregates it into the
   * `ChatResponse` the caller asked for. A caller that wanted JSON is not getting a different request;
   * they are getting the same one the gate permits, decoded. That is stated in the method name rather
   * than hidden in the body, because "why is a JSON request streaming?" is a fair question.
   */
  private async gatedChat(request: ChatRequest, context: ProviderRequestContext): Promise<ChatResponse> {
    let text = '';
    let finishReason: FinishReason | undefined;
    let responseId = '';
    for await (const chunk of this.streamGated(request, context)) {
      responseId = chunk.id || responseId;
      if (chunk.delta?.content) text += chunk.delta.content;
      if (chunk.finishReason) finishReason = chunk.finishReason;
    }
    return {
      id: responseId || `zen-${request.model}`,
      providerId: this.id,
      model: request.model,
      createdAt: new Date().toISOString(),
      message: { role: 'assistant', content: text },
      finishReason: finishReason ?? 'stop',
    };
  }

  /**
   * The one request this adapter sends for a free model: contract applied, stream requested.
   *
   * The refusal below is the part worth reading. Measured from this machine, a request carrying **all
   * four** conditions still answers `403 FreeTierError`, and the working implementation's own comments
   * name the likely reason twice — the CLI identity headers exist because "Cloudflare requires [them]
   * on VPS egress", and the free tier "rejects generic client UAs from datacenter IPs". So when the
   * contract has been applied and the request is *still* refused, telling the user to check their
   * access sends them to rotate a key that was already accepted. It says what was sent and names the
   * network as the likely cause, which is the thing they can act on.
   */
  private async *streamGated(request: ChatRequest, context: ProviderRequestContext): AsyncIterable<ChatChunk> {
    const id = request.model.includes('/') ? request.model.slice(request.model.lastIndexOf('/') + 1) : request.model;
    const headers = this.authHeaders(context.credential, zenFreeTierHeaders(zenSessionId(zenConversationSeed(request))));
    const body: Record<string, unknown> = {
      model: id,
      messages: request.messages.map(toGatedMessage),
      stream: true,
      // The caller's tools, with any quartet member they lack appended. A tool the model could actually call
      // is never removed to make room for the quartet, and a caller's own `Bash` is renamed to `bash`
      // rather than declared twice.
      tools: gatedTools(request.tools),
      ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.topP === undefined ? {} : { top_p: request.topP }),
    };
    const satisfied = zenContractSatisfied(headers, body);

    const events = this.captureGateRefusal(
      this.transport.stream({
        method: 'POST',
        providerId: this.id,
        url: ZEN_LANES.chat,
        headers: { ...headers, accept: 'text/event-stream' },
        body: JSON.stringify(body),
        ...(context.signal ? { signal: context.signal } : {}),
      }),
      request.model,
      satisfied,
    );

    let opened = false;
    for await (const event of parseSseStream(events)) {
      if (event.data.trim() === '[DONE]') return;
      const chunk = parseSseJson<GatedStreamChunk>(event, this.id);
      if (!chunk) continue;
      opened = true;
      if (chunk.error) throw this.gatedRefusal(request.model, chunk, satisfied);
      const chunkId = chunk.id ?? `zen-${id}`;
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) yield { id: chunkId, providerId: this.id, model: id, delta: { content: delta } };
      const finish = chunk.choices?.[0]?.finish_reason;
      if (finish) yield { id: chunkId, providerId: this.id, model: id, delta: {}, finishReason: toGatedFinishReason(finish) };
    }

    // The stream closed without a single payload: either the gate refused before the first event, or
    // the answer was JSON rather than SSE. Those need different messages, so it is read rather than
    // guessed at.
    if (!opened) throw this.gatedRefusal(request.model, undefined, satisfied);
  }

  /**
   * Pass the stream through, turning a transport-level refusal into the gated one.
   *
   * `transport.stream` raises its own `ProviderError` for a non-2xx **before** yielding a single event,
   * so the gate's refusal arrives as a throw and never reaches the chunk loop below. Left alone the user
   * sees the transport's generic *"The provider refused the request."* — the reasonless verdict this
   * whole change exists to remove, arriving from the layer underneath. Wrapping is the only place that
   * can still tell it was the gate, because by the time it throws the contract state is gone.
   */
  private async *captureGateRefusal(stream: AsyncIterable<string>, model: string, satisfied: boolean): AsyncIterable<string> {
    try {
      yield* stream;
    } catch (error) {
      throw error instanceof ProviderError && /refused the request/i.test(error.message)
        ? this.gatedRefusal(model, error, satisfied)
        : error;
    }
  }

  /** The refusal, naming what was sent — the difference between a key problem and a network one. */
  private gatedRefusal(model: string, payload: unknown, satisfied: boolean) {
    // `providerErrorFromResponse` maps every 403 to `PROVIDER_REQUEST_FAILED` and attaches no
    // `statusCode`, so the status cannot be recovered from the thrown error — but the **cause** can,
    // and that is what decides the code. Recognising the gate by the provider's own `FreeTierError`
    // wording rather than by status is therefore more honest than assuming a 403: a 429 on the free
    // tier stays `RATE_LIMITED` and a 5xx stays `PROVIDER_UNAVAILABLE`, instead of every gated refusal
    // collapsing into one code that means nothing to the retry policy.
    const reason = readGatedErrorReason(payload);
    const gated = isZenFreeTierRefusal(403, payload) || /freetiererror|free tier/i.test(reason ?? '');
    const message = satisfied
      ? `OpenCode Zen refused ${model} after this gateway sent everything its free-tier request contract requires — a streaming request, a declared tool, a session header and a client version. The API key was accepted, so this is not a credential problem: OpenCode limits its free tier to non-datacenter networks, and this host's egress address is the likely cause.`
      : `OpenCode Zen refused ${model}, and this gateway could not satisfy its free-tier request contract.`;
    return new ProviderError(
      gated ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_REQUEST_FAILED',
      message,
      {
        providerId: this.id,
        publicMessage: message,
        ...(reason ? { details: { providerReason: reason } } : {}),
      },
    );
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
