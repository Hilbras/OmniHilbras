import { ProviderError, isProviderError } from '@omnihilbras/sdk-shared/errors';
import type { ChatMessage, ChatRequest, ChatResponse, FinishReason, TokenUsage, ToolCallDelta } from './types.js';

/**
 * The OpenAI **Responses** lane, for an endpoint that serves some of its catalog there and nowhere else.
 *
 * ## Where this came from
 *
 * Vendored from `Kernel/SDK/zen/adapter/index.ts` (`toResponsesInput` `:192`, `toResponsesBody` `:211`,
 * `toResponsesChatResponse` `:261`, `responsesText`, `responsesFinishReason`, `responsesUsage`,
 * `responsesRole`), which speaks the same two-lane arrangement against OpenCode Zen. **It is a copy
 * rather than an import** because this repo vendors shared machinery into each package's `lib/` — Zen's
 * copy lives in Zen's package and importing across SDK packages would make one provider's release a
 * dependency of another's (`tests/provider-standalone.test.js` is the check behind that rule).
 *
 * ## What is different from Zen's copy, and why
 *
 * - **The lane is decided by the provider's own refusal, not by the model name.** Zen ships a published
 *   per-family table, so `zenLaneFor` is a lookup; AgentRouter publishes none and its families overlap.
 *   See `responsesLaneRefusal` below.
 * - **Tools are carried.** Zen's copy sends none, which drops a caller's tools without saying so — no
 *   agent turn survives that, since every agent turn declares tools. The body carries them in the
 *   Responses shape (`{type: 'function', name, description, parameters}`, not nested under `function`)
 *   and the input replays both halves of a tool round: an assistant's call as a `function_call` item and
 *   its result as a `function_call_output` item, which is the pair OpenAI documents and the only way a
 *   stateless relay can be told which call a result answers.
 * - **`system` stays `system`.** Zen's copy collapses every non-assistant role into `user`; for a `tool`
 *   message that is a simplification, but for the system prompt it silently changes what the model was
 *   told, and the Responses input items take `system` directly.
 * - **The stream is read**, rather than refused as unsupported (`response.output_text.delta`,
 *   `response.function_call_arguments.delta`, `response.completed`/`incomplete`/`failed`).
 *
 * **Unverified against AgentRouter.** This machine has no working key for the relay, so the wire shapes
 * below are OpenAI's documented ones and nothing here is a measurement of this endpoint — unlike
 * `provider-client-identity.ts`, whose table came from live requests. The refusal that selects this lane
 * *is* measured (see the comment on `responsesLaneRefusal`).
 */

/* ------------------------------------------------------------------ *
 * Which lane a model is on
 * ------------------------------------------------------------------ */

/**
 * Models this process has learned are on the Responses lane, keyed `providerId -> model`.
 *
 * ## Learning from the refusal rather than matching the name
 *
 * The relay answers a model that has no `/v1/chat/completions` surface by naming the other endpoint. The turn
 * that exposed this was reported as `HTTP 502 provider=agentrouter`, which is **this gateway's** status for a
 * provider failure rather than the relay's (see `laneRefusalExcludedStatuses`); the relay's own body was:
 *
 * ```
 * {"error":{"message":"模型 gpt-6-astra 不支持 /v1/chat/completions 接口,请改用 /v1/responses(OpenAI
 *  Responses API). Model gpt-6-astra does not support /v1/chat/completions, please use /v1/responses
 *  instead. (request id: ...)"}}
 * ```
 *
 * That is the provider answering the question directly, and it costs one extra round trip **per model per
 * process** — the failed chat turn that was going to fail anyway. A name pattern would be a guess instead:
 * the same relay serves `glm`/`deepseek` families from `/v1/chat/completions`, publishes no table of which
 * models are where, and grows models without telling anyone. A regex would be wrong the first time they
 * add one, and would be wrong *silently* — on the model nobody had tried yet.
 *
 * So the memo is written by evidence and read by the next turn. It is process-lifetime and in-memory on
 * purpose: it is a fact about a third party's routing that is cheap to re-learn and must not be persisted
 * as though it were configuration.
 *
 * Keyed by provider **and** model, because the lane is a property of the model on that endpoint: the same
 * id may be served by another provider through the chat lane.
 */
const responsesLaneModels = new Set<string>();

const laneKey = (providerId: string, model: string) => `${providerId}\u0000${model}`;

/** Whether a previous turn in this process proved this model is on the Responses lane. */
export function responsesLaneFor(providerId: string, model: string): boolean {
  return responsesLaneModels.has(laneKey(providerId, model));
}

/** Records the provider's own answer: this model is served from `/responses`, not `/chat/completions`. */
export function rememberResponsesLane(providerId: string, model: string): void {
  responsesLaneModels.add(laneKey(providerId, model));
}

/** Drops every memo. For tests that assert the first turn for a model takes the chat path. */
export function forgetResponsesLanes(): void {
  responsesLaneModels.clear();
}

/**
 * The statuses that disqualify a lane refusal, whatever the message says.
 *
 * **An exclusion list, and the message is the discriminator.** A body that says "this model does not support
 * `/v1/chat/completions`, use `/v1/responses`" is a statement about the **surface**, and it is that statement
 * whichever envelope it arrived in — so the status decides nothing *except* in the four cases where a second
 * request is wrong on its own terms: a rejected credential (401), a refusal we are not meant to work around
 * (403), an aborted request (408), and a rate limit (429). Everything else qualifies, including any 4xx not
 * listed here and any 5xx.
 *
 * That direction is the point. An allowlist of accepted statuses is a guess about one relay's envelope, and
 * it fails **silently** the day they change it: the sentence the whole feature keys on would arrive in a
 * status nobody listed, the retry would not fire, and the turn would fail exactly as it did before the lane
 * existed. An exclusion list cannot do that — a new status is retried rather than ignored. What it costs is
 * one extra request in the case where a relay wraps this sentence in something other than a refusal, which is
 * a case nobody has seen and which the text has to match first.
 *
 * **The relay's own status is still not in the transcript.** The turn that exposed this arrived as
 * `HTTP 502 provider=agentrouter`, and 502 is *this gateway's* status for a `PROVIDER_REQUEST_FAILED`
 * (`Kernel/API/src/core/http.ts` maps every 4xx that is not 401/403/408/429/504 there, and 5xx to
 * `PROVIDER_UNAVAILABLE`, which also answers 502). Nor can it be recovered here: a deliberately bogus key is
 * judged **before** any model routing — measured 2026-11-16, `gpt-6-astra`, `glm-4.6` and a model that does
 * not exist all answer `401 无效的令牌` on both lanes. Which is why the unknown was resolved this way round
 * rather than by widening a guessed set of accepted statuses.
 */
const laneRefusalExcludedStatuses = new Set([401, 403, 408, 429]);

/**
 * The provider's own words for a refusal, wherever the transport left them.
 *
 * `providerErrorFromResponse` puts the body's message in `details.providerMessage` and its own generic
 * sentence in the message, so reading only one of the two is how a specific refusal reads as a vague one.
 */
function refusalText(error: ProviderError): string {
  const providerMessage = (error.details as { providerMessage?: unknown } | undefined)?.providerMessage;
  if (typeof providerMessage === 'string' && providerMessage) return providerMessage;
  return error.message;
}

/**
 * Whether this error is the provider saying "this model is not served here, use `/v1/responses`".
 *
 * Two conditions, and both are required. The **text** is the statement — it must name the endpoint the model
 * is not on and the one it is (`/chat/completions` and `/responses`), so a quota message that happens to
 * quote one URL, or a 400 about the request body, is a different refusal and must not spend a second request.
 * The **status** excludes only the four cases where a retry is wrong whatever the body says.
 */
export function responsesLaneRefusal(error: unknown): error is ProviderError {
  /**
   * Structural, not `instanceof`, and that is not a style preference.
   *
   * The runtime transport is the **gateway's** (`FetchHttpTransport`), and it throws the gateway's
   * `Kernel/API/src/core/provider-error.ts` — a different class object from this package's vendored
   * `./errors.js`, because this repository vendors its shared machinery per package. So `instanceof` was
   * **false in production and true in every test here**, where the error was constructed from this package's
   * own class: the retry silently never fired against AgentRouter, and the live turn returned the chat
   * surface's refusal. Both packages already ship `isProviderError` for exactly this reason; this call site
   * simply did not use it.
   */
  if (!isProviderError(error)) return false;
  if (error.statusCode !== undefined && laneRefusalExcludedStatuses.has(error.statusCode)) return false;
  const text = refusalText(error);
  return /\/chat\/completions/.test(text) && /\/responses\b/.test(text);
}

/* ------------------------------------------------------------------ *
 * Request
 * ------------------------------------------------------------------ */

type ResponsesInputTextPart = { type: 'input_text' | 'output_text'; text: string };
type ResponsesInputImagePart = { type: 'input_image'; image_url: string };
type ResponsesInputItem =
  | { role: string; content: Array<ResponsesInputTextPart | ResponsesInputImagePart> }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

function messageText(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/**
 * The messages as Responses input items, in the order they were given.
 *
 * The `type` of a text part is not cosmetic: `input_text` on an assistant turn is refused, and
 * `output_text` on a user turn is refused too. A tool round becomes two top-level items rather than a
 * message with a role, because that is what the Responses input is — `function_call` and
 * `function_call_output` are items, not chat turns, and `call_id` is what ties them together.
 */
export function toResponsesInput(messages: readonly ChatMessage[]): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && message.toolCalls?.length) {
      for (const call of message.toolCalls) {
        items.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
    }
    if (message.role === 'tool') {
      items.push({ type: 'function_call_output', call_id: message.toolCallId ?? '', output: messageText(message) });
      continue;
    }
    const parts: Array<ResponsesInputTextPart | ResponsesInputImagePart> = [];
    const textType = message.role === 'assistant' ? 'output_text' : 'input_text';
    const text = messageText(message);
    if (text) parts.push({ type: textType, text });
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        // An image part is carried as an image part. Dropping it would send a request that is not the one
        // the caller made, and a model that cannot see images answers better than a model that silently
        // never saw one.
        if (part.type === 'image_url') parts.push({ type: 'input_image', image_url: part.imageUrl.url });
      }
    }
    // An assistant turn that is only tool calls has already contributed its items above and carries no
    // text, so it contributes no empty message item here.
    if (parts.length === 0) continue;
    items.push({ role: message.role, content: parts });
  }
  return items;
}

/**
 * A function definition in the Responses shape.
 *
 * Flat — `{type, name, description, parameters}` — where `/chat/completions` nests the same thing under
 * `function`. Sending the chat shape here is a 400 that names the tool, so the difference is carried
 * rather than assumed.
 */
function toResponsesTool(tool: NonNullable<ChatRequest['tools']>[number]) {
  return {
    type: 'function' as const,
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.parameters,
  };
}

/** The Responses request body for one turn. `stream` is the caller's own choice of transport, not a lane. */
export function toResponsesBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    input: toResponsesInput(request.messages),
    stream,
  };
  if (request.maxOutputTokens !== undefined) body.max_output_tokens = request.maxOutputTokens;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.topP !== undefined) body.top_p = request.topP;
  if (request.stop?.length) body.stop = [...request.stop];
  if (request.tools?.length) body.tools = request.tools.map(toResponsesTool);
  if (request.toolChoice !== undefined) body.tool_choice = request.toolChoice;
  return body;
}

/* ------------------------------------------------------------------ *
 * Response
 * ------------------------------------------------------------------ */

type ResponsesFunctionCall = {
  type?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
};

export type ResponsesPayload = {
  id?: string;
  model?: string;
  created_at?: number;
  status?: string;
  error?: { message?: string } | string;
  output?: Array<{
    type?: string;
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    call_id?: string;
    name?: string;
    arguments?: string;
  }>;
  output_text?: string;
  incomplete_details?: { reason?: string } | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
};

export function responsesFinishReason(payload: ResponsesPayload): FinishReason {
  if (payload.incomplete_details?.reason === 'max_output_tokens') return 'length';
  const last = payload.output?.[payload.output.length - 1];
  if (last?.type === 'function_call') return 'tool_calls';
  if (payload.status === 'incomplete') return 'length';
  return 'stop';
}

/** Concatenates the text parts of every output message. */
export function responsesText(payload: ResponsesPayload): string {
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

/** The `function_call` items a non-streaming Responses payload returned, as our tool calls. */
function responsesToolCalls(payload: ResponsesPayload) {
  const calls = (payload.output ?? []).filter((item): item is ResponsesFunctionCall => item.type === 'function_call');
  if (calls.length === 0) return [];
  return calls.map((call, index) => ({
    // `call_id` is the id a result must reference, so it is the id a caller must see. The item's own `id`
    // is the API's handle on the item and means nothing to a client sending the answer back.
    id: call.call_id ?? call.id ?? `call-${index}`,
    type: 'function' as const,
    function: { name: call.name ?? '', arguments: call.arguments ?? '{}' },
  }));
}

export function responsesUsage(usage: ResponsesPayload['usage']): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    ...(usage.input_tokens === undefined ? {} : { inputTokens: usage.input_tokens }),
    ...(usage.output_tokens === undefined ? {} : { outputTokens: usage.output_tokens }),
    ...(usage.total_tokens === undefined ? {} : { totalTokens: usage.total_tokens }),
    ...(usage.input_tokens_details?.cached_tokens === undefined ? {} : { cacheReadTokens: usage.input_tokens_details.cached_tokens }),
    ...(usage.output_tokens_details?.reasoning_tokens === undefined ? {} : { reasoningTokens: usage.output_tokens_details.reasoning_tokens }),
  };
}

export function toResponsesChatResponse(payload: ResponsesPayload, requestedModel: string, providerId: string): ChatResponse {
  const toolCalls = responsesToolCalls(payload);
  return {
    id: payload.id ?? `response-${requestedModel}`,
    providerId,
    model: payload.model ?? requestedModel,
    createdAt: payload.created_at ? new Date(payload.created_at * 1000).toISOString() : new Date().toISOString(),
    message: {
      role: 'assistant',
      content: responsesText(payload) || null,
      ...(toolCalls.length ? { toolCalls } : {}),
    },
    finishReason: responsesFinishReason(payload),
    ...(payload.usage ? { usage: responsesUsage(payload.usage) } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Stream
 * ------------------------------------------------------------------ */

/**
 * One frame of the Responses event stream, as this code reads it.
 *
 * `output_index` is the index of the output item a delta belongs to, which is how parallel tool calls are
 * kept apart — the Responses stream interleaves them, and a reader that did not carry the index would join
 * two calls' arguments into one.
 */
export type ResponsesStreamEvent = {
  type?: string;
  delta?: unknown;
  output_index?: number;
  response?: ResponsesPayload;
  item?: ResponsesFunctionCall;
  error?: { message?: unknown } | string;
  message?: unknown;
};

/**
 * One frame, translated.
 *
 * `failure` is the provider's own words and is what the caller throws — a `response.failed` frame with the
 * reason dropped would read as a truncated stream.
 */
export type ResponsesFrameRead = {
  text?: string;
  toolCall?: ToolCallDelta;
  finishReason?: FinishReason;
  usage?: TokenUsage;
  failure?: string;
  /** The provider said the turn is over, so a caller may stop waiting for more. */
  terminal?: boolean;
};

/** The provider's own words inside a failed frame, wherever that frame put them. */
function streamFailure(payload: ResponsesStreamEvent): string | undefined {
  const error = typeof payload.error === 'string' ? payload.error : payload.error?.message;
  if (typeof error === 'string' && error) return error;
  const message = payload.message;
  if (typeof message === 'string' && message) return message;
  return payload.response?.error ? (typeof payload.response.error === 'string' ? payload.response.error : payload.response.error.message) : undefined;
}

export function readResponsesFrame(payload: ResponsesStreamEvent): ResponsesFrameRead {
  const type = payload.type ?? '';
  if (type === 'error' || type === 'response.failed') return { failure: streamFailure(payload) ?? 'The provider reported a failed response.' };

  if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
    return typeof payload.delta === 'string' && payload.delta ? { text: payload.delta } : {};
  }

  if (type === 'response.output_item.added' && payload.item?.type === 'function_call') {
    // The name and the id arrive once, on the item; the arguments arrive in pieces below it.
    return {
      toolCall: {
        index: payload.output_index ?? 0,
        ...(payload.item.call_id ? { id: payload.item.call_id } : {}),
        type: 'function',
        ...(payload.item.name ? { function: { name: payload.item.name } } : {}),
      },
    };
  }

  if (type === 'response.function_call_arguments.delta' && typeof payload.delta === 'string' && payload.delta) {
    return { toolCall: { index: payload.output_index ?? 0, function: { arguments: payload.delta } } };
  }

  if (type === 'response.completed' || type === 'response.incomplete') {
    const response = payload.response ?? {};
    return {
      finishReason: responsesFinishReason(response),
      ...(response.usage ? { usage: responsesUsage(response.usage) } : {}),
      terminal: true,
    };
  }

  return {};
}
