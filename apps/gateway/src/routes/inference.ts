/**
 * `/v1/models` and `/v1/chat/completions` in OpenAI's shape.
 *
 * The authentication gate lives here rather than in the dispatcher, because it protects exactly
 * this module's routes and nothing else. A gate in the dispatcher is one edit away from guarding
 * the wrong thing.
 */

import { ProviderError, isLoopbackHostname, type ProviderId, isPrivateHostname, type ChatChunk, type ChatMessage, type ChatRequest, type ChatResponse, type EmbeddingRequest, type EmbeddingResponse, type MessageContent, type Model, type ToolDefinition } from '@hilbras/omnihilbras';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext } from './route-context.js';
import { attachRequestId, type RequestScope } from '../request-context.js';
import { isTrustedDashboard } from '../runtime.js';
import type { GatewayServerOptions } from '../server.js';
import type { GatewayService } from '../service.js';
import type { UsageAttempt, UsageOutcome } from '../usage-store.js';
import type { GatewayFailoverAttempt } from '../request-executor.js';
import {
  invalidRequest,
  isRecord,
  maxPresentedKeyLength,
  readJsonBody,
  sendJson,
  toErrorEnvelope,
} from '../http.js';

export async function handleInferenceRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, service, origin, options, signal, auth } = ctx;

    // The LLM surface is the only authenticated part of the gateway. Requests
    // from the allowlisted dashboard origin are local administration traffic
    // and stay reachable so the dashboard can keep testing models.
    if (isPublicLlmRoute(request.method, url.pathname) && !isTrustedDashboard(auth)) {
      await service.authorizePublicRequest(extractApiKey(request));
    }

    if (request.method === 'GET' && url.pathname === '/v1/models') {
      const result = await service.listAllModels(signal);
      sendJson(response, 200, {
        object: 'list',
        data: result.models.map(toOpenAIModel),
        unavailable: result.unavailable,
      }, origin);
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
      await handleChat(request, response, service, options, origin, signal);
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/v1/responses') {
      await handleResponses(request, response, service, options, origin, signal);
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/v1/embeddings') {
      await handleEmbeddings(request, response, service, options, origin, signal);
      return true;
    }

  return false;
}

/**
 * `POST /v1/embeddings`, in OpenAI's shape.
 *
 * Deliberately a sibling of `handleChat` and not a call into it: the two share the auth gate, the
 * request scope, the attempt ledger and the usage vocabulary, and nothing else. Embeddings has no
 * stream, no tools, no temperature and no continuation, and modelling it as "chat with fewer fields"
 * would put four branches in the chat path that can never be true for an embeddings request.
 */
export async function handleEmbeddings(request: IncomingMessage, response: ServerResponse, service: GatewayService, options: GatewayServerOptions, origin: string | undefined, signal: AbortSignal) {
  const body = await readJsonBody(request, options.maxBodyBytes ?? 1_000_000);
  const embeddingRequest = parseEmbeddingRequest(body);
  const explicitProviderId = getExplicitProviderId(request, body);
  const scope = service.startScope(embeddingRequest.model, explicitProviderId);

  const startedAt = Date.now();
  let responseBody: { response: EmbeddingResponse; attempts: GatewayFailoverAttempt[] };
  try {
    responseBody = await service.embedWithFailover(embeddingRequest, explicitProviderId, signal, scope);
  } catch (error) {
    // The same ledger read as chat's failure path, and for the same reason: `attachAttempts` rebuilds
    // the error, so `details.attempts` is the only place the list survives.
    const details = error instanceof ProviderError ? error.details : undefined;
    const ledger: GatewayFailoverAttempt[] =
      typeof details === 'object' && details !== null && Array.isArray((details as { attempts?: unknown }).attempts)
        ? ((details as { attempts: GatewayFailoverAttempt[] }).attempts)
        : [];
    const cancelled = signal.aborted || (error instanceof ProviderError && error.code === 'CANCELLED');
    recordUsage(service, {
      model: embeddingRequest.model,
      providerId: ledger[ledger.length - 1]?.providerId,
      connectionId: ledger[ledger.length - 1]?.connectionId,
      outcome: cancelled ? 'cancelled' : 'failure',
      attempts: ledger.length,
      latencyMs: Date.now() - startedAt,
      ...(error instanceof ProviderError ? { errorCode: error.code } : {}),
    });
    throw attachRequestId(error, scope);
  }

  const serving = responseBody.attempts.find((attempt) => attempt.ok);
  recordUsage(service, {
    model: responseBody.response.model,
    providerId: responseBody.response.providerId,
    connectionId: serving?.connectionId,
    outcome: 'success',
    attempts: responseBody.attempts.length,
    latencyMs: Date.now() - startedAt,
    usage: responseBody.response.usage,
  });

  sendJson(response, 200, {
    object: 'list',
    data: responseBody.response.data.map((vector) => ({
      object: 'embedding',
      index: vector.index,
      embedding: [...vector.embedding],
      // **Only when the adapter measured it.** OpenAI omits this field entirely, and a client that
      // reads it needs to be able to tell "the provider did not say" from "it is zero". The value comes
      // from the vector's own length, so it cannot disagree with the vector.
      ...(vector.dimensions === undefined ? {} : { dimensions: vector.dimensions }),
    })),
    model: responseBody.response.model,
    provider: responseBody.response.providerId,
    usage: responseBody.response.usage
      ? {
          prompt_tokens: responseBody.response.usage.inputTokens,
          total_tokens: responseBody.response.usage.totalTokens,
        }
      : undefined,
    gateway: { requestId: scope.id, ...(responseBody.attempts.length > 1 ? { attempts: responseBody.attempts.map(toPublicAttempt) } : {}) },
  }, origin);
}

/**
 * Parses an OpenAI `/v1/embeddings` body.
 *
 * `input` is required and must be a non-empty string or a non-empty array of them, mirroring the
 * adapter's own check. Two reasons to be strict at the edge rather than to forward and let the
 * provider answer: a request naming no input would otherwise be routed, rate-limited and paid for
 * before anything refused it, and `[]` is not "no input", it is a request for zero vectors — which a
 * caller receiving `data: []` cannot distinguish from a provider that silently did nothing.
 */
export function parseEmbeddingRequest(body: unknown): EmbeddingRequest {
  if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
  if (typeof body.model !== 'string' || !body.model.trim()) throw invalidRequest('model is required.');

  // Narrowed here rather than re-checked in the helper: `body.model` is `unknown` until the guard
  // above runs, and a type predicate does not survive being passed to another function.
  const model = body.model.trim();
  const input = body.input;
  if (typeof input === 'string' && input.length > 0) {
    return finishEmbeddingRequest(body, model, input);
  }
  if (Array.isArray(input) && input.length > 0 && input.every((value) => typeof value === 'string' && value.length > 0)) {
    return finishEmbeddingRequest(body, model, input as readonly string[]);
  }
  throw invalidRequest('input must be a non-empty string or a non-empty array of non-empty strings.');
}

function finishEmbeddingRequest(body: Record<string, unknown>, model: string, input: string | readonly string[]): EmbeddingRequest {
  const dimensions = body.dimensions === undefined ? undefined : parseOptionalNumber(body.dimensions, 'dimensions', 1, 1_000_000);
  if (body.encoding_format !== undefined && body.encoding_format !== 'float') {
    // Base64 embeddings are a different wire format, and decoding them here would mean this gateway
    // holds a vector it cannot use. Refusing is honest; silently returning floats under a `base64`
    // request is a lie the client cannot detect.
    throw invalidRequest('encoding_format must be float; base64 embeddings are not supported.');
  }
  if (body.user !== undefined && typeof body.user !== 'string') throw invalidRequest('user must be a string.');
  return {
    model,
    input,
    ...(dimensions === undefined ? {} : { dimensions }),
    ...(body.user === undefined ? {} : { user: body.user as string }),
  };
}

/**
 * `POST /v1/responses`: the Responses API a Codex-style client speaks. It is served by the chat path, so routing,
 * failover, usage and the key gate are the same; only the request is translated in and the reply translated out.
 * Streaming is refused rather than served in a shape the client cannot read.
 */
export async function handleResponses(request: IncomingMessage, response: ServerResponse, service: GatewayService, options: GatewayServerOptions, origin: string | undefined, signal: AbortSignal) {
  const body = await readJsonBody(request, options.maxBodyBytes ?? 1_000_000);
  if (isRecord(body) && body.stream === true) throw invalidRequest('Streaming is not available on /v1/responses yet; send stream: false.');
  const chatRequest = parseChatRequest(responsesToChatBody(body));
  const explicitProviderId = getExplicitProviderId(request, body);
  const scope = service.startScope(chatRequest.model, explicitProviderId, tokenSaverEnabled(request));
  const startedAt = Date.now();
  let completion: ChatResponse;
  let attempts: GatewayFailoverAttempt[];
  try {
    ({ response: completion, attempts } = await service.chatWithFailover(chatRequest, explicitProviderId, signal, scope));
  } catch (error) {
    const details = error instanceof ProviderError ? error.details : undefined;
    const ledger: GatewayFailoverAttempt[] =
      typeof details === 'object' && details !== null && Array.isArray((details as { attempts?: unknown }).attempts)
        ? ((details as { attempts: GatewayFailoverAttempt[] }).attempts)
        : [];
    const cancelled = signal.aborted || (error instanceof ProviderError && error.code === 'CANCELLED');
    recordUsage(service, {
      model: chatRequest.model,
      providerId: ledger[ledger.length - 1]?.providerId,
      connectionId: ledger[ledger.length - 1]?.connectionId,
      outcome: cancelled ? 'cancelled' : 'failure',
      attempts: ledger.length,
      latencyMs: Date.now() - startedAt,
      ...(error instanceof ProviderError ? { errorCode: error.code } : {}),
    });
    throw attachRequestId(error, scope);
  }
  const serving = attempts.find((attempt) => attempt.ok);
  recordUsage(service, {
    model: completion.model,
    providerId: completion.providerId,
    connectionId: serving?.connectionId,
    outcome: 'success',
    attempts: attempts.length,
    latencyMs: Date.now() - startedAt,
    ...(completion.usage ? { usage: completion.usage } : {}),
  });
  const text = typeof completion.message.content === 'string' ? completion.message.content : '';
  sendJson(response, 200, chatToResponsesBody({ id: completion.id, model: completion.model, createdAt: completion.createdAt, content: text, ...(completion.usage ? { usage: completion.usage } : {}) }), origin);
}

export async function handleChat(request: IncomingMessage, response: ServerResponse, service: GatewayService, options: GatewayServerOptions, origin: string | undefined, signal: AbortSignal) {
  const body = await readJsonBody(request, options.maxBodyBytes ?? 1_000_000);
  const chatRequest = parseChatRequest(body);
  const explicitProviderId = getExplicitProviderId(request, body);

  // Created once, here, where a request has been accepted. Everywhere else it is passed down, so
  // the id is per *request* rather than per provider — which is the only way a client can quote it
  // and an operator can find it.
  const scope = service.startScope(chatRequest.model, explicitProviderId, tokenSaverEnabled(request));

  // A refusal is where the id matters most — it is the case where the user needs to quote
  // something — so the error is given the id on its way out rather than only on the success path.
  try {
    return await handleChatRequest({ response, service, origin, signal, scope, chatRequest, explicitProviderId });
  } catch (error) {
    throw attachRequestId(error, scope);
  }
}

/** The two response shapes, split out so the id can be attached to a failure from either. */
/**
 * Records one request, or explains why it was not recorded.
 *
 * **Failures here are swallowed on purpose.** Usage is a report; a gateway that cannot write its report must
 * still answer the request that produced it. An `await` on a store write inside the response path would also
 * add latency to every request for a number nobody is watching at that moment, so the write is deliberately
 * not awaited — a dropped record under a hard exit is a better outcome than a failed request.
 *
 * The three outcomes are kept distinct, and `cancelled` is neither success nor failure: see the v1.52.0 note
 * in `request-executor.ts`. A client that closed its connection did not make the provider slow.
 */
function recordUsage(
  service: GatewayService,
  input: {
    model: string;
    providerId?: string;
    connectionId?: string;
    outcome: UsageOutcome;
    attempts: number;
    latencyMs: number;
    errorCode?: string;
    usage?: { inputTokens?: number; outputTokens?: number };
    requestId?: string;
    ledger?: readonly GatewayFailoverAttempt[];
  },
): void {
  const store = service.usage;
  if (!store) return;
  // **No requirement that a provider was reached.** The first version returned early when `providerId` was
  // missing, which silently dropped every request that ended before a route was tried — a client that
  // disconnected during startup, or a request nothing could serve. Measured: 30 such requests produced **zero**
  // records, so the page's request count was lower than the number of requests made, with no way to tell.
  //
  // The alternative — refusing to record an unattributable request — was the wrong instinct. The request
  // happened and cost time; the record just says so with no provider on it.
  void Promise.resolve(
    store.record({
      at: new Date().toISOString(),
      model: input.model,
      ...(input.providerId ? { providerId: input.providerId as ProviderId } : {}),
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      outcome: input.outcome,
      attempts: input.attempts,
      latencyMs: Math.max(0, Math.round(input.latencyMs)),
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      ...(input.usage?.inputTokens !== undefined ? { inputTokens: input.usage.inputTokens } : {}),
      ...(input.usage?.outputTokens !== undefined ? { outputTokens: input.usage.outputTokens } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.ledger && input.ledger.length > 0 ? { path: input.ledger.map(toUsageAttempt) } : {}),
    }),
  ).catch(() => undefined);
}

/**
 * One executor attempt, as the usage record stores it. Every attempt in the executor's ledger was sent,
 * so `dispatched` is true; a hedge that never started is not in the ledger at all.
 */
function toUsageAttempt(attempt: GatewayFailoverAttempt): UsageAttempt {
  return {
    dispatched: true,
    outcome: attempt.ok ? 'success' : 'failure',
    ...(attempt.connectionId ? { connectionId: attempt.connectionId } : {}),
    providerId: attempt.providerId,
    ...(attempt.errorCode ? { errorCode: attempt.errorCode } : {}),
  };
}

async function handleChatRequest(input: {
  response: ServerResponse;
  service: GatewayService;
  origin: string | undefined;
  signal: AbortSignal;
  scope: RequestScope;
  chatRequest: ChatRequest;
  explicitProviderId: string | undefined;
}) {
  const { response, service, origin, signal, scope, chatRequest, explicitProviderId } = input;

  if (!chatRequest.stream) {
    const startedAt = Date.now();
    // The failure path needs its own catch: `chatWithFailover` **throws**, so the success branch below is
    // never reached for a request that failed — and a usage page that only counts successes is a page whose
    // total is wrong in the direction that hides the problem. `error.attempts` carries the ledger, because
    // `attachAttempts` puts it there precisely so a caller can read what was tried.
    let completion: ChatResponse;
    let attempts: GatewayFailoverAttempt[];
    try {
      ({ response: completion, attempts } = await service.chatWithFailover(chatRequest, explicitProviderId, signal, scope));
    } catch (error) {
      // Read from `details.attempts`, which is where `attachAttempts` puts it (1.60.0). My first version read
      // `error.attempts`, which does not exist — the error is rebuilt by `attachAttempts` and the ledger was
      // dropped. A wrong-property read here produced *no record at all* rather than a wrong one, which is a
      // better failure mode but still a silent one.
      const details = error instanceof ProviderError ? error.details : undefined;
      const ledger: GatewayFailoverAttempt[] =
        typeof details === 'object' && details !== null && Array.isArray((details as { attempts?: unknown }).attempts)
          ? ((details as { attempts: GatewayFailoverAttempt[] }).attempts)
          : [];
      const cancelled = signal.aborted || (error instanceof ProviderError && error.code === 'CANCELLED');
      recordUsage(service, {
        model: chatRequest.model,
        providerId: ledger[ledger.length - 1]?.providerId,
        connectionId: ledger[ledger.length - 1]?.connectionId,
        // The v1.52.0 rule, on usage as well as health: a cancellation is not a provider failure.
        outcome: cancelled ? 'cancelled' : 'failure',
        attempts: ledger.length,
        latencyMs: Date.now() - startedAt,
        ...(error instanceof ProviderError ? { errorCode: error.code } : {}),
        requestId: scope.id,
        ledger,
      });
      throw error;
    }
    const serving = attempts.find((attempt) => attempt.ok);
    recordUsage(service, {
      model: completion.model,
      providerId: completion.providerId,
      connectionId: serving?.connectionId,
      outcome: 'success',
      attempts: attempts.length,
      latencyMs: Date.now() - startedAt,
      usage: completion.usage,
      requestId: scope.id,
      ledger: attempts,
    });
    sendJson(response, 200, {
      ...toOpenAICompletion(completion),
      // Always present, even on a success with one attempt. A client that was refused gets it from
      // the error; a client that succeeded and wants to quote a conversation gets it from here.
      gateway: { requestId: scope.id, ...(attempts.length > 1 ? { attempts: attempts.map(toPublicAttempt) } : {}) },
    }, origin);
    return;
  }

  // The failover decision is made before any byte is written, so a stream that
  // cannot start returns a normal JSON error instead of a truncated SSE body.
  const streamStartedAt = Date.now();
  const outcome = await service.streamChatWithFailover(chatRequest, explicitProviderId, signal, scope);
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...(origin ? { 'access-control-allow-origin': origin } : {}),
  });
  response.flushHeaders();

  try {
    for await (const chunk of outcome.chunks) {
      await writeStreamData(response, `data: ${JSON.stringify(toOpenAIChunk(chunk))}\n\n`, signal);
    }
    // **The signal is checked before success is claimed** (1.60.0).
    //
    // A client that disconnects does not make the iterator throw — the generator is *disposed*, so the
    // `for await` above exits normally and this line is reached. Measured at four abort delays, every one
    // recorded:
    //
    // ```
    // abort@ 2ms -> 1 record(s): success/p
    // abort@ 4ms -> 1 record(s): success/p
    // abort@ 8ms -> 1 record(s): success/p
    // abort@20ms -> 1 record(s): success/p
    // ```
    //
    // So a tab closing mid-answer was recorded as a completed request nobody read. Health already got this
    // right in 1.52.0; usage had the same shape of bug in the same place, because the two were fixed a year
    // and eight releases apart and only one of them was looked for.
    if (signal.aborted) {
      recordUsage(service, {
        model: chatRequest.model,
        providerId: outcome.attempts.find((attempt) => attempt.ok)?.providerId,
        connectionId: outcome.attempts.find((attempt) => attempt.ok)?.connectionId,
        outcome: 'cancelled',
        attempts: outcome.attempts.length,
        latencyMs: Date.now() - streamStartedAt,
      });
      if (!response.destroyed && !response.writableEnded) response.end();
      return;
    }
    await writeStreamData(response, 'data: [DONE]\n\n', signal);
    recordUsage(service, {
      model: chatRequest.model,
      providerId: outcome.attempts.find((attempt) => attempt.ok)?.providerId,
      connectionId: outcome.attempts.find((attempt) => attempt.ok)?.connectionId,
      outcome: 'success',
      attempts: outcome.attempts.length,
      latencyMs: Date.now() - streamStartedAt,
    });
    response.end();
  } catch (error) {
    // A client disconnect is the user's decision, not a provider outcome, and the v1.52.0 rule applies to
    // usage exactly as it does to health: a cancellation is neither a success nor a failure.
    const cancelled = signal.aborted || (error instanceof ProviderError && error.code === 'CANCELLED');
    recordUsage(service, {
      model: chatRequest.model,
      providerId: outcome.attempts.find((attempt) => attempt.ok)?.providerId ?? outcome.attempts[0]?.providerId,
      connectionId: outcome.attempts.find((attempt) => attempt.ok)?.connectionId ?? outcome.attempts[0]?.connectionId,
      outcome: cancelled ? 'cancelled' : 'failure',
      attempts: outcome.attempts.length,
      latencyMs: Date.now() - streamStartedAt,
      ...(error instanceof ProviderError ? { errorCode: error.code } : {}),
    });
    if (!response.destroyed && !signal.aborted) {
      await writeStreamData(response, `event: error\ndata: ${JSON.stringify(toErrorEnvelope(error))}\n\n`, signal).catch(() => undefined);
      response.end();
    }
  }
}


export function toPublicAttempt(attempt: { providerId: string; attempt: number; ok: boolean; latencyMs: number; errorCode?: string }) {
  return { provider: attempt.providerId, attempt: attempt.attempt, ok: attempt.ok, latencyMs: attempt.latencyMs, ...(attempt.errorCode ? { error: attempt.errorCode } : {}) };
}


/**
 * Turns a Responses API request into the chat request the gateway already serves. `instructions` is the system
 * message; `input` is either a string (one user message) or a list of role/content items. Anything the chat path
 * cannot express is refused by `parseChatRequest`, so both routes share one set of rules.
 */
export function responsesToChatBody(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
  const messages: Array<Record<string, unknown>> = [];
  if (typeof body.instructions === 'string' && body.instructions.trim()) messages.push({ role: 'system', content: body.instructions });
  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!isRecord(item) || typeof item.role !== 'string') throw invalidRequest('Each input item must have a role.');
      messages.push({ role: item.role, content: item.content });
    }
  } else {
    throw invalidRequest('input must be a string or a list of messages.');
  }
  return {
    model: body.model,
    messages,
    ...(body.stream === undefined ? {} : { stream: body.stream }),
    ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
    ...(body.top_p === undefined ? {} : { top_p: body.top_p }),
    ...(body.max_output_tokens === undefined ? {} : { max_tokens: body.max_output_tokens }),
  };
}

/** The Responses shape a client reads: an output list, plus `output_text` for the common single-text case. */
export function chatToResponsesBody(chat: { id: string; model: string; createdAt: string; content: string; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }) {
  return {
    id: chat.id,
    object: 'response',
    created_at: Math.floor(Date.parse(chat.createdAt) / 1000),
    model: chat.model,
    status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: chat.content }] }],
    output_text: chat.content,
    usage: {
      input_tokens: chat.usage?.inputTokens ?? 0,
      output_tokens: chat.usage?.outputTokens ?? 0,
      total_tokens: chat.usage?.totalTokens ?? (chat.usage?.inputTokens ?? 0) + (chat.usage?.outputTokens ?? 0),
    },
  };
}

export function parseChatRequest(body: unknown): ChatRequest {
  if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
  if (typeof body.model !== 'string' || !body.model.trim()) throw invalidRequest('model is required.');
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw invalidRequest('messages must be a non-empty array.');

  const messages = body.messages.map((message) => parseMessage(message));
  const stream = parseOptionalBoolean(body.stream, 'stream');
  const temperature = parseOptionalNumber(body.temperature, 'temperature', 0, 2);
  const topP = parseOptionalNumber(body.top_p, 'top_p', 0, 1);
  const maxOutputTokens = parseMaxTokens(body);
  const stop = parseStop(body);
  const tools = parseTools(body.tools);
  const toolChoice = parseToolChoice(body.tool_choice);
  const reasoningEffort = parseReasoningEffort(body.reasoning_effort);
  const providerOptions = body.provider_options === undefined ? undefined : parseProviderOptions(body.provider_options);

  return {
    model: body.model.trim(),
    messages,
    ...(stream !== undefined ? { stream } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(stop !== undefined ? { stop } : {}),
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { toolChoice } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(providerOptions ? { providerOptions } : {}),
  };
}


export function parseMessage(value: unknown): ChatMessage {
  if (!isRecord(value) || (value.role !== 'system' && value.role !== 'user' && value.role !== 'assistant' && value.role !== 'tool')) {
    throw invalidRequest('Each message must have a valid role.');
  }

  const toolCalls = value.tool_calls === undefined ? undefined : parseToolCalls(value.tool_calls);
  if (toolCalls && value.role !== 'assistant') throw invalidRequest('Only assistant messages may contain tool calls.');
  if (value.name !== undefined && typeof value.name !== 'string') throw invalidRequest('Message name must be a string.');
  if (value.tool_call_id !== undefined && typeof value.tool_call_id !== 'string') throw invalidRequest('tool_call_id must be a string.');
  if (value.role === 'tool' && (typeof value.tool_call_id !== 'string' || !value.tool_call_id.trim())) {
    throw invalidRequest('Tool messages must include tool_call_id.');
  }
  const content = value.content === undefined && value.role === 'assistant' && toolCalls?.length
    ? null
    : parseContent(value.content);

  return {
    role: value.role,
    content,
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(typeof value.tool_call_id === 'string' ? { toolCallId: value.tool_call_id } : {}),
    ...(value.is_error === true ? { isError: true } : {}),
    ...(typeof value.reasoning_content === 'string' && value.reasoning_content.length > 0 ? { reasoning: value.reasoning_content } : {}),
    ...(toolCalls ? { toolCalls } : {}),
  };
}


export function parseContent(value: unknown): MessageContent {
  if (value === null || typeof value === 'string') return value;
  if (!Array.isArray(value)) throw invalidRequest('Message content must be a string, null, or content-part array.');
  return value.map((part) => {
    if (!isRecord(part)) throw invalidRequest('Message content parts must be objects.');
    if (part.type === 'text' && typeof part.text === 'string') return { type: 'text' as const, text: part.text };
    if (part.type === 'image_url' && isRecord(part.image_url) && typeof part.image_url.url === 'string') {
      const url = parseImageUrl(part.image_url.url);
      const detail = part.image_url.detail;
      if (detail !== undefined && detail !== 'auto' && detail !== 'low' && detail !== 'high') {
        throw invalidRequest('Image detail must be auto, low, or high.');
      }
      return { type: 'image_url' as const, imageUrl: { url, ...(detail ? { detail } : {}) } };
    }
    throw invalidRequest('Message content contains an unsupported part.');
  });
}


export function parseToolCalls(value: unknown): NonNullable<ChatMessage['toolCalls']> {
  if (!Array.isArray(value) || value.length === 0) throw invalidRequest('tool_calls must be a non-empty array.');
  return value.map((call) => {
    if (!isRecord(call) || call.type !== 'function' || typeof call.id !== 'string' || !call.id.trim() || !isRecord(call.function) || typeof call.function.name !== 'string' || !call.function.name.trim() || typeof call.function.arguments !== 'string') {
      throw invalidRequest('Each tool call must include an id, function name, and arguments.');
    }
    try {
      JSON.parse(call.function.arguments);
    } catch {
      throw invalidRequest('Tool call arguments must contain valid JSON.');
    }
    return {
      id: call.id,
      type: 'function' as const,
      function: { name: call.function.name, arguments: call.function.arguments },
    };
  });
}


export function parseTool(value: unknown): ToolDefinition {
  if (!isRecord(value) || value.type !== 'function' || !isRecord(value.function) || typeof value.function.name !== 'string' || !value.function.name.trim() || !isRecord(value.function.parameters)) {
    throw invalidRequest('Each tool must contain a function name and parameters.');
  }
  if (value.function.description !== undefined && typeof value.function.description !== 'string') {
    throw invalidRequest('Tool descriptions must be strings.');
  }
  return {
    name: value.function.name,
    ...(typeof value.function.description === 'string' ? { description: value.function.description } : {}),
    parameters: value.function.parameters,
  };
}


/** The reasoning effort a client may ask for. Anything else is refused, rather than forwarded. */
export function parseReasoningEffort(value: unknown): 'low' | 'medium' | 'high' | undefined {
  if (value === undefined) return undefined;
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  throw invalidRequest('reasoning_effort must be low, medium or high.');
}

/** The tool-use policy a client may send. Anything else is refused, rather than forwarded to a provider that may read it as a default. */
export function parseToolChoice(value: unknown): 'auto' | 'none' | 'required' | undefined {
  if (value === undefined) return undefined;
  if (value === 'auto' || value === 'none' || value === 'required') return value;
  throw invalidRequest('tool_choice must be auto, none or required.');
}

export function parseTools(value: unknown): ToolDefinition[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw invalidRequest('tools must be a non-empty array.');
  return value.map(parseTool);
}


export function parseProviderOptions(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalidRequest('provider_options must be an object.');
  return value;
}


export function parseMaxTokens(body: Record<string, unknown>) {
  const hasCompletionTokens = body.max_completion_tokens !== undefined;
  const hasLegacyTokens = body.max_tokens !== undefined;
  if (hasCompletionTokens && hasLegacyTokens) throw invalidRequest('Use only one of max_tokens or max_completion_tokens.');
  const value = hasCompletionTokens ? body.max_completion_tokens : body.max_tokens;
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw invalidRequest('max_tokens must be a positive integer.');
  return value;
}


export function parseStop(body: Record<string, unknown>) {
  if (body.stop === undefined) return undefined;
  if (typeof body.stop === 'string') {
    if (!body.stop) throw invalidRequest('stop must not be empty.');
    return [body.stop];
  }
  if (!Array.isArray(body.stop) || body.stop.length === 0 || !body.stop.every((value) => typeof value === 'string' && value.length > 0)) {
    throw invalidRequest('stop must be a string or a non-empty array of strings.');
  }
  return body.stop;
}


export function parseOptionalBoolean(value: unknown, name: string) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw invalidRequest(`${name} must be a boolean.`);
  return value;
}


export function parseOptionalNumber(value: unknown, name: string, minimum: number, maximum: number) {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw invalidRequest(`${name} must be a finite number between ${minimum} and ${maximum}.`);
  }
  return value;
}


export function parseImageUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol === 'data:') {
      if (!/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/]+={0,2}$/i.test(value)) throw new Error('Only base64 image data URLs are supported.');
      return value;
    }
    if (url.protocol !== 'https:' || url.username || url.password || isLoopbackHostname(url.hostname) || isPrivateHostname(url.hostname)) {
      throw new Error('Unsafe image URL.');
    }
    return value;
  } catch {
    throw invalidRequest('Image URLs must be HTTPS image URLs or base64 image data URLs.');
  }
}


/** On unless the client sends `x-omnihilbras-token-saver: off` for this request. Any other value leaves it on. */
export function tokenSaverEnabled(request: IncomingMessage): boolean {
  const header = request.headers['x-omnihilbras-token-saver'];
  return !(typeof header === 'string' && header.trim().toLowerCase() === 'off');
}

export function getExplicitProviderId(request: IncomingMessage, body: unknown) {
  const header = request.headers['x-omnihilbras-provider'];
  if (Array.isArray(header)) throw invalidRequest('x-omnihilbras-provider must be a single value.');
  if (typeof header === 'string' && header.trim()) return header.trim();
  if (isRecord(body) && body.provider !== undefined) {
    if (typeof body.provider !== 'string' || !body.provider.trim()) throw invalidRequest('provider must be a non-empty string.');
    return body.provider.trim();
  }
  return undefined;
}

/** A pasted secret, bounded, and rejected rather than coerced when it is absent. */

export function toOpenAICompletion(response: ChatResponse) {
  return {
    id: response.id,
    object: 'chat.completion',
    created: Math.floor(Date.parse(response.createdAt) / 1000),
    model: response.model,
    provider: response.providerId,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: response.message.content,
        ...(response.message.toolCalls?.length ? { tool_calls: response.message.toolCalls.map((toolCall) => ({ id: toolCall.id, type: 'function', function: toolCall.function })) } : {}),
      },
      finish_reason: response.finishReason,
    }],
    ...(response.usage ? { usage: { prompt_tokens: response.usage.inputTokens, completion_tokens: response.usage.outputTokens, total_tokens: response.usage.totalTokens } } : {}),
    // Kiro meters credits and publishes no token counts. Carried through as its own field
    // so a metered call is never reported as a free one, and never as zero tokens.
    ...(response.meters ? { meters: response.meters } : {}),
    ...(response.contextUsagePercent === undefined ? {} : { context_usage_percent: response.contextUsagePercent }),
  };
}


export function toOpenAIChunk(chunk: ChatChunk) {
  return {
    id: chunk.id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: chunk.model,
    provider: chunk.providerId,
    choices: [{
      index: 0,
      delta: {
        ...(chunk.delta.role ? { role: chunk.delta.role } : {}),
        ...(chunk.delta.content !== undefined ? { content: chunk.delta.content } : {}),
        ...(chunk.delta.toolCalls?.length ? { tool_calls: chunk.delta.toolCalls.map((toolCall) => ({ index: toolCall.index, ...(toolCall.id ? { id: toolCall.id } : {}), type: 'function', function: { ...(toolCall.function?.name ? { name: toolCall.function.name } : {}), arguments: toolCall.function?.arguments ?? '' } })) } : {}),
      },
      finish_reason: chunk.finishReason ?? null,
    }],
    ...(chunk.usage ? { usage: { prompt_tokens: chunk.usage.inputTokens, completion_tokens: chunk.usage.outputTokens, total_tokens: chunk.usage.totalTokens } } : {}),
  };
}


export function toOpenAIModel(model: Model) {
  return { id: model.id, object: 'model', owned_by: model.providerId, ...(model.displayName ? { display_name: model.displayName } : {}), ...(model.contextWindow ? { context_window: model.contextWindow } : {}) };
}


export async function writeStreamData(response: ServerResponse, data: string, signal: AbortSignal) {
  if (signal.aborted || response.destroyed || response.writableEnded) {
    throw new ProviderError('CANCELLED', 'The client closed the response stream.', { cause: signal.reason });
  }
  if (response.write(data)) return;

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', onDrain);
      response.off('close', onClose);
      response.off('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new ProviderError('CANCELLED', 'The client closed the response stream.'));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      reject(new ProviderError('CANCELLED', 'The response stream was cancelled.', { cause: signal.reason }));
    };
    response.once('drain', onDrain);
    response.once('close', onClose);
    response.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}


/**
 * The LLM surface: everything that can cost money or return model output, and therefore everything
 * that needs a key unless the caller is the allowlisted dashboard.
 *
 * **This function is the authentication boundary for the public surface, and a path missing from it is
 * an unauthenticated endpoint.** `handleInferenceRoute` asks it before dispatching, so a route added
 * to the dispatcher but not here is reachable with no credential at all — which is exactly the shape of
 * bug that a route test written against the handler would miss, because the handler is not where the
 * decision is made.
 *
 * So the route list and this list are the same fact stated twice, and the guard in
 * `apps/gateway/test/embeddings-route.test.js` asserts they agree in both directions. `/v1/embeddings`
 * was added here in the same commit that added the route below; that is the whole point of stating it
 * as one rule rather than two places to remember.
 */
export function isPublicLlmRoute(method: string | undefined, pathname: string) {
  return (method === 'GET' && pathname === '/v1/models')
    || (method === 'POST' && pathname === '/v1/chat/completions')
    || (method === 'POST' && pathname === '/v1/responses')
    || (method === 'POST' && pathname === '/v1/embeddings');
}

/** Accepts the same headers OpenAI, Anthropic, and Gemini clients already send. */

export function extractApiKey(request: IncomingMessage) {
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string') {
    const bearer = /^Bearer[ ]+(.+)$/i.exec(authorization.trim());
    const value = bearer?.[1]?.trim();
    return value && value.length <= maxPresentedKeyLength ? value : undefined;
  }
  for (const header of ['x-api-key', 'x-goog-api-key']) {
    const value = request.headers[header];
    if (typeof value === 'string' && value.trim() && value.trim().length <= maxPresentedKeyLength) return value.trim();
  }
  return undefined;
}

