import { ProviderError } from '../lib/errors.js';
import { FetchHttpTransport } from '../lib/transport.js';
import type { HttpTransport } from '../lib/transport.js';
import { OpenAICompatibleAdapter } from '../lib/openai-compatible.js';
import { parseSseJson, parseSseStream } from '../lib/streaming.js';
import { ZEN_FINGERPRINT_TOOL_NAMES, isZenFreeTierRefusal, zenFingerprintTools, zenFreeTierHeaders, zenSessionId, zenContractSatisfied, zenConversationSeed, zenFreeTierRefusal, zenGatedToolChoice } from '../lib/zen-free-tier.js';
import type { ChatChunk, ChatMessage, ChatRequest, ChatResponse, CredentialValidation, FinishReason, Model, ProviderQuota, ProviderResourceQuota, ProviderAdapter, ProviderCredential, ProviderHealth, ProviderRequestContext, TokenUsage, ToolDefinition } from '../lib/types.js';

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
/**
 * OpenCode Go — the same product's **subscription** lane.
 *
 * A different base path under the same host (`/zen/go`), the same three wire formats and the same
 * per-model lane table; what differs is what a key entitles you to. The reference project ships it as a
 * separate provider (`opencode-go`) with its own usage endpoint, and so does this adapter now: the two are
 * one class with a different base.
 */
export const ZEN_GO_BASE_URL = 'https://opencode.ai/zen/go';
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
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
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
 * The provider's words when it is refusing through the **free-tier gate**, and `undefined` otherwise.
 *
 * The distinction carries the whole retry decision: a free-tier refusal means our request was missing
 * something we can add, while any other refusal means the retry would spend a second request to learn
 * exactly what the first one already said. The wording is matched because `FreeTierError` is the
 * upstream's own envelope type, not an inference about the status code — a 403 that is a bad key and
 * a 403 that is the gate look identical from the outside and are not from here.
 */
function freeTierRefusalReason(error: unknown): string | undefined {
  if (!(error instanceof ProviderError)) return undefined;
  const reason = readGatedErrorReason(error);
  return reason && /freetiererror|free tier|freeusage/i.test(reason) ? reason : undefined;
}

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

function unsupportedLane(model: string, id: string, providerId: string, providerName: string) {
  const kind = unsupported.has(id) ? 'decision models on /zen/v1/systemone' : 'Gemini models on /zen/v1/models/{id}';
  return new ProviderError('NOT_SUPPORTED', `${providerName} serves ${kind}, which this gateway does not implement. Skipping ${model}.`, {
    providerId,
    publicMessage: `${providerName} serves ${kind}, which this gateway does not implement yet.`,
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
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number; input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } };
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

function toResponsesChatResponse(payload: ResponsesPayload, requestedModel: string, providerId: string): ChatResponse {
  const text = responsesText(payload);
  return {
    id: payload.id ?? `response-${requestedModel}`,
    providerId,
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
    ...(usage.input_tokens_details?.cached_tokens === undefined ? {} : { cacheReadTokens: usage.input_tokens_details.cached_tokens }),
    ...(usage.output_tokens_details?.reasoning_tokens === undefined ? {} : { reasoningTokens: usage.output_tokens_details.reasoning_tokens }),
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
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
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

function toMessagesChatResponse(payload: MessagesPayload, requestedModel: string, providerId: string): ChatResponse {
  const text = (payload.content ?? []).filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('');
  return {
    id: payload.id ?? `msg-${requestedModel}`,
    providerId,
    model: payload.model ?? requestedModel,
    createdAt: new Date().toISOString(),
    message: { role: 'assistant', content: text },
    finishReason: messagesFinishReason(payload.stop_reason),
    usage: payload.usage
      ? {
        inputTokens: payload.usage.input_tokens,
        outputTokens: payload.usage.output_tokens,
        ...(payload.usage.cache_read_input_tokens === undefined ? {} : { cacheReadTokens: payload.usage.cache_read_input_tokens }),
        ...(payload.usage.cache_creation_input_tokens === undefined ? {} : { cacheWriteTokens: payload.usage.cache_creation_input_tokens }),
        ...(payload.usage.cache_read_input_tokens === undefined && payload.usage.cache_creation_input_tokens === undefined ? {} : { cacheTokensIncluded: false }),
      }
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
  /** The provider id this instance answers as — `opencode` (Zen) or `opencode-go`. */
  id?: string;
  /** The name a person sees, for the same reason. */
  name?: string;
  /** The Zen root this instance talks to, e.g. `https://opencode.ai/zen/go` for Go. */
  base?: string;
};

export class ZenAdapter implements ProviderAdapter {
  readonly id: string;
  readonly name: string;
  readonly capabilities = { chat: true, streaming: true, models: true } as const;
  private readonly transport: HttpTransport;
  private readonly chatLane: OpenAICompatibleAdapter;
  private readonly modelsUrl: string;
  private readonly base: string;

  constructor(options: ZenAdapterOptions = {}) {
    this.id = options.id ?? 'opencode';
    this.name = options.name ?? 'OpenCode Zen';
    this.base = (options.base ?? ZEN_BASE_URL).replace(/\/$/, '');
    this.transport = options.transport ?? new FetchHttpTransport();
    this.chatLane = new OpenAICompatibleAdapter(
      { id: this.id, name: this.name, baseUrl: `${this.base}/v1`, auth: { header: 'Authorization', prefix: 'Bearer' } },
      { transport: this.transport },
    );
    this.modelsUrl = options.modelsUrl ?? `${this.base}/v1/models`;
  }

  /** The endpoint for one lane, on this instance's root. */
  private lane(lane: ZenLane): string {
    return `${this.base}/v1/${lane === 'chat' ? 'chat/completions' : lane}`;
  }

  /**
   * The account's own usage report — `GET {base}/v1/usage`, the read the reference project parses for
   * both plugins.
   *
   * The shape is three percentage meters (`rolling`, `weekly`, `monthly`), each `{ percent, resetsAt }`.
   * `percent` is what is **used**, so it is carried as `used` against a limit of 100: the dashboard's
   * quota bar reads `used/limit`, and reporting 100 − used there would show an exhausted account as
   * empty. A meter the response omits is left out rather than shown as zero.
   *
   * The matrix varies by plan: a Zen pay-as-you-go key answers with a wallet rather than these meters, so
   * resources can legitimately be empty — the card then says the provider did not report one.
   */
  async quota(context: ProviderRequestContext = {}): Promise<ProviderQuota> {
    const credential = context.credential;
    const value = credential && 'value' in credential ? credential.value : undefined;
    if (typeof value !== 'string' || !value) {
      throw new ProviderError('AUTHENTICATION_FAILED', `Connect ${this.name} to read its usage.`, {
        providerId: this.id,
        publicMessage: `Connect ${this.name} to read its usage.`,
      });
    }
    const { data } = await this.transport.request<{ usage?: Record<string, { percent?: unknown; resetsAt?: unknown }> }>({
      method: 'GET',
      providerId: this.id,
      url: `${this.base}/v1/usage`,
      headers: { accept: 'application/json', Authorization: `Bearer ${value}` },
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const resources: Record<string, ProviderResourceQuota> = {};
    const names: Record<string, string> = { rolling: 'Rolling', weekly: 'Weekly', monthly: 'Monthly' };
    for (const [period, label] of Object.entries(names)) {
      const meter = data?.usage?.[period];
      if (!meter) continue;
      const percent = typeof meter.percent === 'number' ? meter.percent : Number(meter.percent);
      if (!Number.isFinite(percent)) continue;
      const used = Math.max(0, Math.min(100, Math.round(percent * 10) / 10));
      const resetsAt = typeof meter.resetsAt === 'string' && meter.resetsAt && !Number.isNaN(Date.parse(meter.resetsAt))
        ? new Date(meter.resetsAt).toISOString()
        : undefined;
      resources[label] = { used, limit: 100, remaining: Math.round((100 - used) * 10) / 10, ...(resetsAt ? { resetsAt } : {}) };
    }
    return { plan: this.name, resources };
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
   * **The catalog is public only when no credential is sent.**
   *
   * This used to report `valid` for any non-empty string, on the premise that a listing endpoint cannot
   * say anything about a token. Measured against the live host on 2026-11-08:
   *
   * ```
   * GET /zen/v1/models                          -> 200, no credential needed
   * GET /zen/v1/models  Authorization: Bearer <bad>  -> 401 {"error":{"message":"Invalid credential"}}
   * ```
   *
   * So the endpoint *does* judge the credential when one is present — which is exactly what `listModels`
   * sends — and a check that reads the catalog **with the key** is a real check. Found while checking the
   * free-tier group: the card showed "Credential check 100%" for a key the provider answered
   * `401 This API key has expired` to, because the check had never asked.
   *
   * It costs no tokens: it is the model listing, not an inference request.
   */
  async validateCredential(credential: ProviderCredential | undefined, context: ProviderRequestContext = {}): Promise<CredentialValidation> {
    if (credential?.type === 'none' || !credential?.value) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'An OpenCode Zen API key is required.', {
        providerId: this.id,
        publicMessage: 'An OpenCode Zen API key is required.',
      });
    }
    const startedAt = performance.now();
    // The listing carries the credential, so a key the provider refuses fails here rather than on the
    // first chat — which is what "the key looks valid" has to mean.
    try {
      await this.listModels({ ...context, credential });
    } catch (error) {
      const status = error && typeof error === 'object' && typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : undefined;
      if (status === 401 || status === 403) {
        throw new ProviderError('AUTHENTICATION_FAILED', `${this.name} refused this API key.`, {
          providerId: this.id,
          publicMessage: `${this.name} refused this key — it is invalid or expired. Create a new one at opencode.ai/auth.`,
        });
      }
      throw error;
    }
    return { status: 'valid', checkedAt: new Date().toISOString(), latencyMs: Math.round(performance.now() - startedAt) };
  }

  async chat(request: ChatRequest, context: ProviderRequestContext = {}): Promise<ChatResponse> {
    const { lane, supported } = zenLaneFor(request.model);
    const id = request.model.includes('/') ? request.model.slice(request.model.lastIndexOf('/') + 1) : request.model;
    if (!supported) throw unsupportedLane(request.model, id, this.id, this.name);

    if (lane === 'chat') {
      // Free-tier models need the request contract, which the delegated chat lane knows nothing
      // about — it sends `stream: false` and whatever tools the caller declared, which is a refusal.
      if (isFreeTierModel(id)) return this.gatedChat(request, context);
      try {
        return await this.chatLane.chat(request, context);
      } catch (error) {
        /**
         * Self-correcting rather than predictive.
         *
         * `isFreeTierModel` is a guess from a name suffix, and a guess is wrong in both directions: a
         * free model the suffix missed fails outright, and a paid model whose name happens to end in
         * `-free` pays for a contract it never needed. A provider saying "FreeTierError" is not a
         * guess — it is the answer — so when one arrives for a model we did *not* gate, the contract is
         * applied and the request is retried once.
         *
         * The cost is one failed round trip in exactly the case where we would otherwise have failed
         * the request outright. A refusal that is not a free-tier refusal is rethrown untouched: a
         * retry would spend a second request to learn the same thing.
         */
        if (!freeTierRefusalReason(error)) throw error;
        return this.gatedChat(request, context);
      }
    }

    const isResponses = lane === 'responses';
    const response = await this.transport.request<ResponsesPayload | MessagesPayload>({
      method: 'POST',
      providerId: this.id,
      url: this.lane(lane),
      // The messages lane does not take a bearer token. It takes the raw key in
      // `x-api-key`, and sending `Authorization: Bearer` there is answered with a
      // 401 even when the key is valid.
      headers: isResponses
        ? this.authHeaders(context.credential)
        : context.credential?.type === 'oauth'
          // An OAuth grant on the messages lane is still a bearer token. Sending it as `x-api-key`
          // reached the lane with no credential and no org header, which is a 401 for every Claude
          // model on an OAuth account.
          ? this.authHeaders(context.credential, { 'anthropic-version': '2023-06-01' })
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
    return isResponses ? toResponsesChatResponse(payload, request.model, this.id) : toMessagesChatResponse(payload, request.model, this.id);
  }

  /**
   * Streaming is not implemented for the messages or responses lanes. Saying so
   * is better than silently answering without a stream, which would break a
   * client that is waiting for one.
   */
  async *streamChat(request: ChatRequest, context: ProviderRequestContext = {}): AsyncIterable<ChatChunk> {
    const { lane, supported } = zenLaneFor(request.model);
    const id = request.model.includes('/') ? request.model.slice(request.model.lastIndexOf('/') + 1) : request.model;
    if (!supported) throw unsupportedLane(request.model, id, this.id, this.name);
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
    // A tool call arrives in pieces: its id and name once, then its arguments across several deltas. Each
    // piece is merged by index, so the arguments join into the whole JSON the model wrote.
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    for await (const chunk of this.streamGated(request, context)) {
      responseId = chunk.id || responseId;
      if (chunk.delta?.content) text += chunk.delta.content;
      for (const piece of chunk.delta?.toolCalls ?? []) {
        const call = calls.get(piece.index) ?? { id: '', name: '', arguments: '' };
        if (piece.id) call.id = piece.id;
        if (piece.function?.name) call.name = piece.function.name;
        if (piece.function?.arguments) call.arguments += piece.function.arguments;
        calls.set(piece.index, call);
      }
      if (chunk.finishReason) finishReason = chunk.finishReason;
    }
    const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => ({
      id: call.id,
      type: 'function' as const,
      function: { name: call.name, arguments: call.arguments },
    }));
    return {
      id: responseId || `zen-${request.model}`,
      providerId: this.id,
      model: request.model,
      createdAt: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: text,
        ...(toolCalls.length ? { toolCalls } : {}),
      },
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
      // Free models accept only "auto" (opencode-free-tool-choice.test.js), so the choice is stated
      // rather than left to whatever the caller happened to send.
      tool_choice: zenGatedToolChoice((request.tools ?? []).length > 0),
      ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.topP === undefined ? {} : { top_p: request.topP }),
    };
    const satisfied = zenContractSatisfied(headers, body);

    const events = this.captureGateRefusal(
      this.transport.stream({
        method: 'POST',
        providerId: this.id,
        url: this.lane('chat'),
        headers: { ...headers, accept: 'text/event-stream' },
        body: JSON.stringify(body),
        ...(context.signal ? { signal: context.signal } : {}),
      }),
      request.model,
      satisfied,
    );

    let opened = false;
    let sawDone = false;
    for await (const event of parseSseStream(events)) {
      if (event.data.trim() === '[DONE]') {
        sawDone = true;
        break;
      }
      const chunk = parseSseJson<GatedStreamChunk>(event, this.id);
      if (!chunk) continue;
      opened = true;
      if (chunk.error) throw this.gatedRefusal(request.model, chunk, satisfied);
      const chunkId = chunk.id ?? `zen-${id}`;
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) yield { id: chunkId, providerId: this.id, model: id, delta: { content: delta } };
      const toolCalls = chunk.choices?.[0]?.delta?.tool_calls;
      if (toolCalls?.length) {
        yield {
          id: chunkId,
          providerId: this.id,
          model: id,
          delta: {
            toolCalls: toolCalls.map((toolCall) => ({
              index: toolCall.index ?? 0,
              ...(toolCall.id ? { id: toolCall.id } : {}),
              ...(toolCall.type ? { type: 'function' as const } : {}),
              ...(toolCall.function?.name || toolCall.function?.arguments ? { function: {
                ...(toolCall.function.name ? { name: toolCall.function.name } : {}),
                ...(toolCall.function.arguments ? { arguments: toolCall.function.arguments } : {}),
              } } : {}),
            })),
          },
        };
      }
      const finish = chunk.choices?.[0]?.finish_reason;
      if (finish) {
        sawDone = true;
        yield { id: chunkId, providerId: this.id, model: id, delta: {}, finishReason: toGatedFinishReason(finish) };
      }
    }

    // The stream closed without a single payload: either the gate refused before the first event, or
    // the answer was JSON rather than SSE. Those need different messages, so it is read rather than
    // guessed at.
    if (!opened) throw this.gatedRefusal(request.model, undefined, satisfied);
    // A stream that stopped mid-answer is not a finished answer. The shared base treats a missing
    // terminator as fatal; this path used to return the partial text as a success.
    if (!sawDone) throw new ProviderError('INVALID_RESPONSE', 'The provider stream ended before completion.', { providerId: this.id });
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
    // One sentence, shared with OpenCode Console, which reaches the same models through the same
    // contract and must not describe the same refusal differently.
    return zenFreeTierRefusal({ providerId: this.id, model, label: 'OpenCode Zen', contractSatisfied: satisfied, gated, ...(reason ? { providerReason: reason } : {}) });
  }


  /** The messages lane: OAuth is a bearer on the messages lane too; an API key is raw `x-api-key`. */
  private apiKeyHeaders(credential: ProviderCredential | undefined) {
    const value = credential?.type === 'none' ? '' : credential?.value ?? '';
    const org = credential?.type === 'oauth' && credential.orgId ? credential.orgId : undefined;
    return {
      accept: 'application/json',
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(value ? { 'x-api-key': value } : {}),
      ...(org ? { 'x-opencode-org-id': org } : {}),
    };
  }

  private authHeaders(credential: ProviderCredential | undefined, extra: Record<string, string> = {}) {
    const value = credential?.type === 'none' ? '' : credential?.value ?? '';
    const org = credential?.type === 'oauth' && credential.orgId ? credential.orgId : undefined;
    return {
      accept: 'application/json',
      'content-type': 'application/json',
      ...extra,
      ...(value ? { Authorization: `Bearer ${value}` } : {}),
      ...(org ? { 'x-opencode-org-id': org } : {}),
    };
  }
}
export * from '../lib/openai-compatible.js';
