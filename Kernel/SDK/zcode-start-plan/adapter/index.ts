import { ProviderError } from '../lib/errors.js';
import { parseSseJson, parseSseStream } from '../lib/streaming.js';
import { FetchHttpTransport, type HttpTransport } from '../lib/transport.js';
import { assertSafeProviderHeaderValue, resolveProviderUrl } from '../lib/url.js';
import { START_PLAN_TEMPLATE } from '../lib/startPlanTemplate.js';
import type { ChatChunk, ChatMessage, ChatRequest, ChatResponse, CredentialValidation, FinishReason, MessageContent, Model, ProviderAdapter, ProviderCapabilities, ProviderCredential, ProviderHealth, ProviderId, ProviderQuota, ProviderRequestContext, TokenUsage, ToolCall, ToolDefinition } from '../lib/types.js';

/**
 * ZCode (Start Plan) — a signed-in ZCode account, reached through its Anthropic-compatible endpoint.
 *
 * ## What this is, and what it is not
 *
 * This is **not** a Z.ai API key and not GLM's native API. A ZCode Start Plan account is a subscription
 * reached by the session token the ZCode desktop app stores; the backend it talks to is
 * `https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`, which speaks the **Anthropic Messages**
 * shape. That is why this adapter is Anthropic-shaped rather than OpenAI-shaped.
 *
 * ## The stock template is load-bearing
 *
 * The backend refuses a request whose *system* prompt was replaced: measured by the reference client as
 * `HTTP 405, code 3012 "request has been blocked due to unusual activity"`. So the captured stock system
 * blocks ship in `lib/startPlanTemplate.ts` and are sent unchanged. A caller's own system message is
 * carried into the first user turn instead of replacing the stock one, so nothing is silently dropped and
 * the request is not refused.
 *
 * Tools are the caller's when it sends any; otherwise none are advertised. Advertising the stock ZCode
 * agent tools to a plain chat client would invite tool calls the client cannot run.
 *
 * ## Unverified against the live backend
 *
 * The reference proxies flatten the conversation to one prompt and buffer the answer; this adapter talks
 * the endpoint natively and streams. Whether structured multi-turn messages and tool results survive the
 * stock template, and whether this account's model requests require the Aliyun CAPTCHA, are the two things
 * a live turn must confirm — see `tasks/zcode-provider-plan.md`.
 */

export const zcodeProviderId: ProviderId = 'zcode';

export const ZCODE = {
  origin: 'https://zcode.z.ai',
  /** The Anthropic-compatible base; the messages path is appended to it. */
  apiBase: 'https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1',
  messagesPath: 'messages',
  balanceUrl: 'https://zcode.z.ai/api/v1/zcode-plan/billing/balance',
  /** The desktop client version these headers imitate. Network-level mimicry, not an API version. */
  appVersion: '3.14.4',
  anthropicVersion: '2023-06-01',
  anthropicBeta: 'mid-conversation-system-2026-04-07',
} as const;

/** The models the Start Plan endpoint serves. There is no model-list endpoint to read them from. */
export const ZCODE_MODELS = ['glm-5.3', 'glm-5.3-flash'] as const;
export type ZcodeModel = (typeof ZCODE_MODELS)[number];

export type ZcodeAdapterOptions = {
  baseUrl?: string;
  appVersion?: string;
  transport?: HttpTransport;
  timeoutMs?: number;
  /**
   * The `X-Device-Mid` the ZCode app reports, and the account id from `oauth:<provider>:user_info`.
   *
   * Both are request attribution, not authentication: the token alone authorises the turn. They are
   * read from the local ZCode store by the gateway (`Kernel/API/src/core/zcode-local.ts`) and handed
   * in, because the SDK stays browser-safe and must not read the filesystem.
   */
  deviceMid?: string;
  accountUuid?: string;
  /**
   * Replaces `__ZCODE_PRIMARY_WORKING_DIRECTORY__` in the stock template. The desktop app substitutes
   * the signed-in workspace path; a gateway has no workspace, so the caller passes one (the gateway's
   * cwd by default). Left literal, the model reads the placeholder as the directory and repeats it.
   */
  workingDirectory?: string;
};

type AnthropicContentBlock = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  /** `type: 'thinking'` — the model's reasoning, which this provider returns as its own block. */
  thinking?: string;
  /** The thinking block's integrity token, echoed back on the next turn. */
  signature?: string;
};

type AnthropicMessageResponse = {
  id?: string;
  model?: string;
  content?: AnthropicContentBlock[];
  stop_reason?: string | null;
  usage?: AnthropicUsage;
};

type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

type AnthropicStreamEvent = {
  type?: string;
  message?: { id?: string; model?: string; usage?: AnthropicUsage };
  index?: number;
  content_block?: AnthropicContentBlock;
  delta?: { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string; stop_reason?: string | null };
  usage?: AnthropicUsage;
  error?: { type?: string; message?: string };
};

type BalanceBody = {
  data?: {
    server_time?: string;
    plans?: Array<{ name?: string; plan_id?: string; status?: string }>;
    balances?: Array<{
      show_name?: string;
      entitlement_id?: string;
      total_units?: number;
      used_units?: number;
      remaining_units?: number;
      expires_at?: string;
      period_end?: string;
    }>;
  };
};

export class ZcodeAdapter implements ProviderAdapter {
  readonly id = zcodeProviderId;
  readonly name = 'ZCode (Start Plan)';
  readonly capabilities: ProviderCapabilities = { chat: true, streaming: true, models: true };
  private readonly baseUrl: string;
  private readonly appVersion: string;
  private readonly transport: HttpTransport;
  /** A stable id for this adapter instance, reported as `metadata.user_id.device_id`. */
  private deviceId: string;
  /** The account id, reported as `metadata.user_id.account_uuid`. Empty when the store had none. */
  private accountUuid: string;
  /** Substituted for the template's workspace placeholder. */
  private readonly workingDirectory: string;
  private readonly defaultMaxTokens = START_PLAN_TEMPLATE.maxTokens;

  constructor(options: ZcodeAdapterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? ZCODE.apiBase).replace(/\/+$/, '');
    this.appVersion = options.appVersion ?? ZCODE.appVersion;
    this.transport = options.transport ?? new FetchHttpTransport({ timeoutMs: options.timeoutMs });
    this.deviceId = options.deviceMid?.trim() || randomId();
    this.accountUuid = options.accountUuid?.trim() ?? '';
    this.workingDirectory = options.workingDirectory?.trim() || '/';
  }

  /**
   * Adopts the ZCode app's own device and account ids, once the gateway has read them.
   *
   * Called after the adapter is constructed, because the local store is read asynchronously and the
   * on-demand factory is synchronous. Attribution only; a missing value degrades to the generated id.
   */
  setLocalIdentity(identity: { deviceMid?: string; accountUuid?: string }): void {
    if (identity.deviceMid?.trim()) this.deviceId = identity.deviceMid.trim();
    this.accountUuid = identity.accountUuid?.trim() ?? this.accountUuid;
  }

  /**
   * The Start Plan endpoint has no model-list route, so this is the catalog the reference client
   * verifies. A static list is the honest answer: it cannot drift from a provider call that does not
   * exist.
   */
  async listModels(): Promise<readonly Model[]> {
    // Both Start Plan models are 1M-context. Declared here rather than inferred: the catalog endpoint
    // does not exist, and a context window is what the dashboard's model row shows.
    return ZCODE_MODELS.map((id) => ({
      id,
      providerId: this.id,
      displayName: id === 'glm-5.3' ? 'GLM-5.3' : 'GLM-5.3-Flash',
      contextWindow: 1_000_000,
    }));
  }

  async chat(request: ChatRequest, context: ProviderRequestContext = {}): Promise<ChatResponse> {
    return this.postChat(request, context);
  }

  /**
   * One non-streaming turn.
   *
   * `thinking` is not a choice here. Measured against the live endpoint, sending
   * `thinking: { type: 'disabled' }` is refused with `1210 — this model always thinks; disabling is not
   * supported; use low, high or max`. So every turn keeps it enabled, and a response whose only block
   * is `thinking` (a small `max_tokens` spent entirely on reasoning) is accepted as a served turn by
   * `toChatResponse` rather than reported as a malformed answer.
   */
  private async postChat(request: ChatRequest, context: ProviderRequestContext): Promise<ChatResponse> {
    const sessionId = randomId();
    const response = await this.transport.request<AnthropicMessageResponse>({
      method: 'POST',
      providerId: this.id,
      url: this.url(ZCODE.messagesPath),
      headers: this.requestHeaders(context.credential, 'application/json', sessionId),
      body: JSON.stringify(this.toRequestBody(request, false, sessionId)),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    return this.toChatResponse(response.data, request.model);
  }

  async *streamChat(request: ChatRequest, context: ProviderRequestContext = {}): AsyncIterable<ChatChunk> {
    const sessionId = randomId();
    const events = this.transport.stream({
      method: 'POST',
      providerId: this.id,
      url: this.url(ZCODE.messagesPath),
      headers: this.requestHeaders(context.credential, 'text/event-stream', sessionId),
      body: JSON.stringify(this.toRequestBody(request, true, sessionId)),
      ...(context.signal ? { signal: context.signal } : {}),
    });

    const toolBlocks = new Map<number, { id?: string; name?: string }>();
    let responseId = `stream-${request.model}`;
    let responseModel = request.model;
    let sawPayload = false;
    let sawFinishReason = false;
    let sawMessageStop = false;
    let streamUsage: TokenUsage | undefined;

    for await (const event of parseSseStream(events)) {
      const payload = parseSseJson<AnthropicStreamEvent>(event, this.id);
      if (!payload) continue;
      sawPayload = true;
      if (event.event === 'error' || payload.type === 'error') {
        throw new ProviderError('PROVIDER_REQUEST_FAILED', payload.error?.message ? `The ZCode stream returned an error: ${payload.error.message}` : 'The ZCode stream returned an error.', { providerId: this.id });
      }

      if (payload.type === 'message_stop') {
        sawMessageStop = true;
        break;
      }

      if (payload.type === 'message_start') {
        responseId = payload.message?.id ?? responseId;
        responseModel = payload.message?.model ?? responseModel;
        streamUsage = payload.message?.usage ? normalizeUsage(payload.message.usage) : undefined;
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
        } else if (payload.delta.type === 'thinking_delta' && payload.delta.thinking !== undefined) {
          // GLM always thinks; the OpenAI surface carries this as `reasoning_content`, which is what an
          // agent app shows as the model's reasoning before the answer.
          yield {
            id: responseId,
            providerId: this.id,
            model: responseModel,
            delta: { reasoning: payload.delta.thinking },
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
        if (finishReason) sawFinishReason = true;
        const usage = payload.usage ? { ...(streamUsage ?? {}), ...normalizeUsage(payload.usage) } : streamUsage;
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

    if (!sawPayload || !sawFinishReason || !sawMessageStop) {
      throw new ProviderError('INVALID_RESPONSE', 'The ZCode stream ended before completion.', { providerId: this.id });
    }
  }

  /**
   * A one-token turn, which is the reference client's own smoke test.
   *
   * The model list is static, so a health check that read it would prove nothing about the credential.
   * A real turn is the only thing that establishes the token is accepted and the Start Plan entitlement
   * can serve inference.
   */
  async healthCheck(context: ProviderRequestContext = {}): Promise<ProviderHealth> {
    const startedAt = performance.now();
    try {
      // A small budget is enough: the provider accepts the turn even when the reply is thinking-only,
      // which is what "this model always thinks" means.
      await this.postChat({ model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'Reply only OK.' }], maxOutputTokens: 32, temperature: 0 }, context);
      return { status: 'healthy' as const, verified: 'inference', latencyMs: Math.round(performance.now() - startedAt), checkedAt: new Date().toISOString() };
    } catch (error) {
      return {
        status: 'unavailable' as const,
        verified: 'inference',
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : 'The ZCode health check failed without a reason.',
      };
    }
  }

  /** Proves the token before a connection stores it, with the same one-token turn. */
  async validateCredential(credential: ProviderCredential | undefined, context: ProviderRequestContext = {}): Promise<CredentialValidation> {
    const startedAt = performance.now();
    await this.postChat({ model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'Reply only OK.' }], maxOutputTokens: 32, temperature: 0 }, { ...context, ...(credential ? { credential } : {}) });
    return { status: 'valid', checkedAt: new Date().toISOString(), latencyMs: Math.round(performance.now() - startedAt) };
  }

  /** The Start Plan balance buckets, each with its own entitlement period. */
  async quota(context: ProviderRequestContext = {}): Promise<ProviderQuota> {
    const response = await this.transport.request<BalanceBody>({
      method: 'GET',
      providerId: this.id,
      url: ZCODE.balanceUrl,
      headers: this.requestHeaders(context.credential, 'application/json', randomId()),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const data = response.data?.data ?? {};
    const resources: ProviderQuota['resources'] = {};
    for (const balance of data.balances ?? []) {
      const key = String(balance.show_name ?? balance.entitlement_id ?? 'balance');
      const total = Number(balance.total_units ?? 0);
      const remaining = Number(balance.remaining_units ?? 0);
      const used = Number(balance.used_units ?? Math.max(total - remaining, 0));
      const resetsAt = balance.expires_at ?? balance.period_end;
      resources[key] = {
        used: Number.isFinite(used) ? used : 0,
        limit: Number.isFinite(total) ? total : 0,
        remaining: Number.isFinite(remaining) ? remaining : 0,
        ...(resetsAt ? { resetsAt: String(resetsAt) } : {}),
      };
    }
    const plan = data.plans?.find((entry) => entry.name)?.name;
    return { ...(plan ? { plan: String(plan) } : {}), resources };
  }

  private url(path: string) {
    return resolveProviderUrl(this.baseUrl, path, this.id);
  }

  private requestHeaders(credential: ProviderCredential | undefined, accept: string, sessionId: string) {
    if (credential?.type !== 'api-key' || !credential.value.trim()) {
      throw new ProviderError('AUTHENTICATION_FAILED', `Missing ZCode access token for ${this.id}.`, {
        providerId: this.id,
        publicMessage: 'This ZCode connection has no access token. Paste the token from the ZCode desktop app again.',
      });
    }
    assertSafeProviderHeaderValue('x-api-key', credential.value, this.id);
    return {
      accept,
      'content-type': 'application/json',
      // Desktop-client mimicry: the Start Plan backend expects the ZCode app's own headers, not an
      // OpenAI/Anthropic client's. The token is sent both ways, which is what the packaged client does.
      'user-agent': `ZCode/${this.appVersion} ai-sdk/anthropic/3.0.81`,
      'x-zcode-app-version': this.appVersion,
      'x-platform': 'win32-x64',
      'x-release-channel': 'production',
      'x-zcode-agent': 'glm',
      'x-zcode-session-type': 'main',
      // The app marks a directly-user-initiated turn `main_turn`; the transport diagnostic keys on it.
      'x-zcode-query-source': 'main_turn',
      'x-zcode-trace-id': randomId(),
      'x-query-id': randomId(),
      'x-session-id': sessionId,
      'anthropic-version': ZCODE.anthropicVersion,
      'anthropic-beta': ZCODE.anthropicBeta,
      'x-api-key': credential.value,
      authorization: `Bearer ${credential.value}`,
    };
  }

  private toRequestBody(request: ChatRequest, stream: boolean, sessionId: string) {
    const messages = request.messages.filter((message) => message.role !== 'system').map(toAnthropicMessage);
    const systemText = request.messages.filter((message) => message.role === 'system').map((message) => contentToText(message.content)).filter(Boolean).join('\n\n');

    // The stock system blocks are what the backend accepts; a caller's system prompt is carried into the
    // first user turn so it is not silently dropped. Replacing `system` returns 405/3012.
    if (systemText) {
      const index = messages.findIndex((message) => message.role === 'user');
      const block = { type: 'text', text: systemText };
      if (index === -1) {
        messages.unshift({ role: 'user', content: [block] });
      } else {
        const existing = messages[index]!;
        messages[index] = { ...existing, content: [block, ...(existing.content as Array<Record<string, unknown>>)] };
      }
    }

    return {
      model: zcodeModel(request.model),
      max_tokens: Math.min(request.maxOutputTokens ?? this.defaultMaxTokens, this.defaultMaxTokens),
      system: JSON.parse(JSON.stringify(START_PLAN_TEMPLATE.system).replaceAll('__ZCODE_PRIMARY_WORKING_DIRECTORY__', this.workingDirectory)) as unknown[],
      // The caller's tools when it has them; none otherwise, so the model cannot call Stock agent tools
      // the client cannot run. The stock `tool_choice` only applies when the stock tools are sent.
      tools: request.tools !== undefined ? request.tools.map(toAnthropicTool) : [],
      tool_choice: request.tools !== undefined ? toAnthropicToolChoice(request.toolChoice) : { type: 'auto' },
      stream,
      thinking: { type: 'enabled' },
      output_config: { effort: zcodeEffort(request.reasoningEffort) },
      metadata: {
        user_id: JSON.stringify({ device_id: this.deviceId, account_uuid: this.accountUuid, session_id: sessionId }),
      },
      messages,
    };
  }

  private toChatResponse(response: AnthropicMessageResponse, requestedModel: string): ChatResponse {
    const blocks = response.content;
    if (!Array.isArray(blocks)) {
      // A 200 with a business envelope is an error the transport did not see. Surface the provider's
      // own message (`1005 exceed quota limit`) as the public message, because "the provider returned an
      // invalid response" hides the one thing a user can act on.
      const business = (response as { error?: { message?: string }; msg?: string }).error?.message ?? (response as { msg?: string }).msg;
      if (business && business.trim()) {
        throw new ProviderError('PROVIDER_REQUEST_FAILED', `ZCode refused the turn: ${business}`, {
          providerId: this.id,
          publicMessage: `ZCode refused the turn: ${business}`,
          details: { providerMessage: business },
        });
      }
      throw invalidResponse(this.id, 'ZCode response is missing content blocks.');
    }

    const text = blocks.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('');
    // GLM always thinks, and the OpenAI surface carries that as `reasoning_content`. Dropping it here is
    // why the reasoning was invisible to clients while the ZCode app showed it. The signed block is kept
    // separately so a tool round can replay it, which some thinking models require.
    const reasoning = blocks.filter((block) => block.type === 'thinking').map((block) => block.thinking ?? '').join('').trim();
    const signedThinking = blocks.find((block) => block.type === 'thinking' && typeof block.signature === 'string' && block.signature.length > 0);
    const reasoningFields = {
      ...(reasoning ? { reasoning } : {}),
      ...(reasoning && signedThinking?.signature ? { thinking: { text: reasoning, signature: signedThinking.signature } } : {}),
    };
    const toolCalls = blocks.filter((block) => block.type === 'tool_use').map(normalizeToolUse);
    if (!text && toolCalls.length === 0) {
      if (response.stop_reason === 'refusal') {
        return {
          id: response.id ?? `response-${requestedModel}`,
          providerId: this.id,
          model: response.model ?? requestedModel,
          createdAt: new Date().toISOString(),
          message: { role: 'assistant', content: null, ...reasoningFields },
          finishReason: 'content_filter',
          ...(response.usage ? { usage: normalizeUsage(response.usage) } : {}),
        };
      }
      // A turn that spent its whole budget inside a `thinking` block is a served turn, not a malformed
      // one. The reasoning is reported, so a reasoning-only reply is readable instead of empty.
      return {
        id: response.id ?? `response-${requestedModel}`,
        providerId: this.id,
        model: response.model ?? requestedModel,
        createdAt: new Date().toISOString(),
        message: { role: 'assistant', content: null, ...reasoningFields },
        finishReason: normalizeFinishReason(response.stop_reason),
        ...(response.usage ? { usage: normalizeUsage(response.usage) } : {}),
      };
    }

    return {
      id: response.id ?? `response-${requestedModel}`,
      providerId: this.id,
      model: response.model ?? requestedModel,
      createdAt: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: text || null,
        ...reasoningFields,
        ...(toolCalls.length ? { toolCalls } : {}),
      },
      finishReason: normalizeFinishReason(response.stop_reason),
      ...(response.usage ? { usage: normalizeUsage(response.usage) } : {}),
    };
  }
}

/** The model id the Start Plan endpoint expects, from any spelling or provider prefix. */
export function zcodeModel(model: string): string {
  const normalized = model.trim().toLowerCase().replace(/^[a-z0-9_-]+\//, '').replace(/^zcode-/, '');
  if (normalized === 'glm-5.3' || normalized === 'glm-5.3-flash') return normalized === 'glm-5.3' ? 'GLM-5.3' : 'GLM-5.3-Flash';
  return 'GLM-5.3-Flash';
}

/** The Start Plan backend takes `low | high | max`; our three levels fold onto it. */
export function zcodeEffort(effort: 'low' | 'medium' | 'high' | undefined): 'low' | 'high' | 'max' {
  if (effort === 'low') return 'low';
  if (effort === 'medium' || effort === 'high') return 'high';
  return 'max';
}

function toAnthropicMessage(message: ChatMessage) {
  if (message.role === 'tool') {
    return {
      role: 'user' as const,
      content: [{ type: 'tool_result', tool_use_id: message.toolCallId ?? '', content: contentToText(message.content), ...(message.isError ? { is_error: true } : {}) }],
    };
  }

  const content = toAnthropicContent(message.content);
  // A signed thinking block must be replayed with an assistant turn that used tools, or the provider
  // rejects the round. It is the same block the provider issued, not a reconstruction.
  const thinkingBlocks = message.role === 'assistant' && message.thinking?.signature
    ? [{ type: 'thinking', thinking: message.thinking.text, signature: message.thinking.signature }]
    : [];
  if (message.role === 'assistant' && message.toolCalls?.length) {
    const toolBlocks = message.toolCalls.map((toolCall) => ({ type: 'tool_use', id: toolCall.id, name: toolCall.function.name, input: parseToolArguments(toolCall.function.arguments) }));
    return { role: message.role, content: [...thinkingBlocks, ...content, ...toolBlocks] };
  }
  if (thinkingBlocks.length > 0) return { role: message.role, content: [...thinkingBlocks, ...content] };
  return { role: message.role, content };
}

function toAnthropicContent(content: MessageContent): Array<Record<string, unknown>> {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (content === null) return [];
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    const dataUrl = part.imageUrl.url.match(/^data:([^;]+);base64,(.+)$/i);
    if (dataUrl) return { type: 'image', source: { type: 'base64', media_type: dataUrl[1], data: dataUrl[2] } };
    return { type: 'image', source: { type: 'url', url: part.imageUrl.url } };
  });
}

function contentToText(content: MessageContent) {
  if (typeof content === 'string') return content;
  if (content === null) return '';
  return content.filter((part) => part.type === 'text').map((part) => part.text).join('');
}

function toAnthropicToolChoice(choice: 'auto' | 'none' | 'required' | undefined) {
  if (choice === 'required') return { type: 'any' };
  if (choice === 'none') return { type: 'none' };
  return { type: 'auto' };
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
  return 'other';
}

function normalizeUsage(usage: AnthropicUsage): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(usage.cache_read_input_tokens === undefined ? {} : { cacheReadTokens: usage.cache_read_input_tokens }),
    ...(usage.cache_creation_input_tokens === undefined ? {} : { cacheWriteTokens: usage.cache_creation_input_tokens }),
    ...(usage.cache_read_input_tokens === undefined && usage.cache_creation_input_tokens === undefined ? {} : { cacheTokensIncluded: false }),
  };
}

function invalidResponse(providerId: ProviderId, message: string) {
  return new ProviderError('INVALID_RESPONSE', message, { providerId });
}

/** UUIDv4 from the Web Crypto global, so the adapter stays browser-safe (no `node:crypto`). */
function randomId(): string {
  const crypto = globalThis.crypto;
  if (!crypto?.randomUUID) throw new ProviderError('CONFIGURATION_ERROR', 'This runtime has no crypto.randomUUID.');
  return crypto.randomUUID();
}