import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ProviderError, type ChatChunk, type ChatMessage, type ChatRequest, type ChatResponse, type MessageContent, type Model, type ToolDefinition } from '@omnihilbras/sdk';
import { assertLoopbackHost, createGatewayService, loadGatewayConfig, type GatewayConfig } from './config.js';
import type { GatewayService } from './service.js';

export type GatewayServerOptions = {
  /** Backwards-compatible single-origin option for tests and embedders. */
  corsOrigin?: string;
  /** Exact browser origins allowed to call the local gateway. */
  corsOrigins?: string[];
  maxBodyBytes?: number;
};

const defaultCorsOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173'];

export function createGatewayServer(service: GatewayService, options: GatewayServerOptions = {}) {
  const corsOrigins = resolveCorsOrigins(options);
  return createServer((request, response) => {
    const requestOrigin = getRequestOrigin(request);
    if (requestOrigin && !corsOrigins.includes(requestOrigin)) {
      sendJson(response, 403, { error: { code: 'CORS_ORIGIN_DENIED', message: 'This browser origin is not allowed.' } });
      return;
    }

    const responseOrigin = requestOrigin && corsOrigins.includes(requestOrigin) ? requestOrigin : undefined;
    setCors(response, responseOrigin);
    void handleRequest(request, response, service, options, responseOrigin).catch((error) => {
      sendError(response, error);
    });
  });
}

export async function startGatewayServer(options: {
  config?: GatewayConfig;
  env?: Readonly<Record<string, string | undefined>>;
  corsOrigin?: string;
  corsOrigins?: string[];
} = {}) {
  const config = options.config ?? loadGatewayConfig(options.env);
  assertLoopbackHost(config.host);
  const service = createGatewayService(config, options.env);
  const server = createGatewayServer(service, {
    ...(options.corsOrigin ? { corsOrigin: options.corsOrigin } : {}),
    ...(options.corsOrigins ? { corsOrigins: options.corsOrigins } : options.corsOrigin ? {} : { corsOrigins: config.corsOrigins }),
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(config.port, config.host);
  });

  return { config, server, service };
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, service: GatewayService, options: GatewayServerOptions, origin: string | undefined) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const onResponseClose = () => {
    if (!response.writableEnded) controller.abort();
  };
  request.once('aborted', abort);
  response.once('close', onResponseClose);

  try {
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { service: 'omnihilbras-gateway', ...(await service.health(controller.signal)) }, origin);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/models') {
      const result = await service.listAllModels(controller.signal);
      sendJson(response, 200, {
        object: 'list',
        data: result.models.map(toOpenAIModel),
        unavailable: result.unavailable,
      }, origin);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
      await handleChat(request, response, service, options, origin, controller.signal);
      return;
    }

    sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Route not found.' } }, origin);
  } finally {
    request.off('aborted', abort);
    response.off('close', onResponseClose);
  }
}

async function handleChat(request: IncomingMessage, response: ServerResponse, service: GatewayService, options: GatewayServerOptions, origin: string | undefined, signal: AbortSignal) {
  const body = await readJsonBody(request, options.maxBodyBytes ?? 1_000_000);
  const chatRequest = parseChatRequest(body);
  const providerId = getProviderId(request, body);

  if (!chatRequest.stream) {
    const result = await service.chat(providerId, chatRequest, signal);
    sendJson(response, 200, toOpenAICompletion(result), origin);
    return;
  }

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...(origin ? { 'access-control-allow-origin': origin } : {}),
  });
  response.flushHeaders();

  try {
    for await (const chunk of service.streamChat(providerId, chatRequest, signal)) {
      await writeStreamData(response, `data: ${JSON.stringify(toOpenAIChunk(chunk))}\n\n`, signal);
    }
    await writeStreamData(response, 'data: [DONE]\n\n', signal);
    response.end();
  } catch (error) {
    if (!response.destroyed && !signal.aborted) {
      await writeStreamData(response, `event: error\ndata: ${JSON.stringify(toErrorEnvelope(error))}\n\n`, signal).catch(() => undefined);
      response.end();
    }
  }
}

function parseChatRequest(body: unknown): ChatRequest {
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
    ...(providerOptions ? { providerOptions } : {}),
  };
}

function parseMessage(value: unknown): ChatMessage {
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
    ...(toolCalls ? { toolCalls } : {}),
  };
}

function parseContent(value: unknown): MessageContent {
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

function parseToolCalls(value: unknown): NonNullable<ChatMessage['toolCalls']> {
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

function parseTool(value: unknown): ToolDefinition {
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

function parseTools(value: unknown): ToolDefinition[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw invalidRequest('tools must be a non-empty array.');
  return value.map(parseTool);
}

function parseProviderOptions(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalidRequest('provider_options must be an object.');
  return value;
}

function parseMaxTokens(body: Record<string, unknown>) {
  const hasCompletionTokens = body.max_completion_tokens !== undefined;
  const hasLegacyTokens = body.max_tokens !== undefined;
  if (hasCompletionTokens && hasLegacyTokens) throw invalidRequest('Use only one of max_tokens or max_completion_tokens.');
  const value = hasCompletionTokens ? body.max_completion_tokens : body.max_tokens;
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw invalidRequest('max_tokens must be a positive integer.');
  return value;
}

function parseStop(body: Record<string, unknown>) {
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

function parseOptionalBoolean(value: unknown, name: string) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw invalidRequest(`${name} must be a boolean.`);
  return value;
}

function parseOptionalNumber(value: unknown, name: string, minimum: number, maximum: number) {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw invalidRequest(`${name} must be a finite number between ${minimum} and ${maximum}.`);
  }
  return value;
}

function parseImageUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol === 'data:') {
      if (!value.startsWith('data:image/')) throw new Error('Only image data URLs are supported.');
    } else if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('Unsupported image URL protocol.');
    }
    return value;
  } catch (error) {
    throw invalidRequest('Image URLs must be valid http(s) or image data URLs.');
  }
}

function getProviderId(request: IncomingMessage, body: unknown) {
  const header = request.headers['x-omnihilbras-provider'];
  if (Array.isArray(header)) throw invalidRequest('x-omnihilbras-provider must be a single value.');
  if (typeof header === 'string' && header.trim()) return header.trim();
  if (isRecord(body) && body.provider !== undefined) {
    if (typeof body.provider !== 'string' || !body.provider.trim()) throw invalidRequest('provider must be a non-empty string.');
    return body.provider.trim();
  }
  return 'openai';
}

async function readJsonBody(request: IncomingMessage, maxBytes: number) {
  const contentLength = Number(request.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw invalidRequest('Request body is too large.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw invalidRequest('Request body is too large.');
    chunks.push(buffer);
  }
  if (size === 0) throw invalidRequest('Request body is required.');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw invalidRequest('Request body must contain valid JSON.');
  }
}

function toOpenAICompletion(response: ChatResponse) {
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
  };
}

function toOpenAIChunk(chunk: ChatChunk) {
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

function toOpenAIModel(model: Model) {
  return { id: model.id, object: 'model', owned_by: model.providerId, ...(model.displayName ? { display_name: model.displayName } : {}), ...(model.contextWindow ? { context_window: model.contextWindow } : {}) };
}

async function writeStreamData(response: ServerResponse, data: string, signal: AbortSignal) {
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

function resolveCorsOrigins(options: GatewayServerOptions) {
  const configured = options.corsOrigins ?? (options.corsOrigin ? [options.corsOrigin] : defaultCorsOrigins);
  const origins = [...new Set(configured.map((origin) => origin.trim()).filter(Boolean))];
  if (origins.includes('*')) throw new Error('Wildcard CORS is not allowed for the local gateway.');
  return origins;
}

function getRequestOrigin(request: IncomingMessage) {
  const origin = request.headers.origin;
  return typeof origin === 'string' ? origin : undefined;
}

function setCors(response: ServerResponse, origin: string | undefined) {
  if (origin) response.setHeader('access-control-allow-origin', origin);
  response.setHeader('access-control-allow-headers', 'content-type, x-omnihilbras-provider');
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  response.setHeader('vary', 'Origin');
}

function sendJson(response: ServerResponse, status: number, body: unknown, origin?: string) {
  const payload = JSON.stringify(body);
  if (origin) response.setHeader('access-control-allow-origin', origin);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function sendError(response: ServerResponse, error: unknown) {
  if (response.destroyed) return;
  if (response.headersSent) {
    response.end();
    return;
  }
  const envelope = toErrorEnvelope(error);
  sendJson(response, statusForError(error), envelope);
}

function toErrorEnvelope(error: unknown) {
  if (error instanceof ProviderError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.providerId ? { provider: error.providerId } : {}),
        ...(error.statusCode ? { status: error.statusCode } : {}),
        ...(error.retryable ? { retryable: true } : {}),
      },
    };
  }
  return { error: { code: 'INTERNAL_ERROR', message: 'The gateway encountered an unexpected error.' } };
}

function statusForError(error: unknown) {
  if (!(error instanceof ProviderError)) return 500;
  if (error.code === 'INVALID_REQUEST') return 400;
  if (error.code === 'AUTHENTICATION_FAILED') return 401;
  if (error.code === 'NOT_SUPPORTED') return 501;
  if (error.code === 'NOT_FOUND') return 404;
  if (error.code === 'RATE_LIMITED') return 429;
  if (error.code === 'PROVIDER_TIMEOUT') return 504;
  if (error.code === 'CANCELLED') return 499;
  if (error.code === 'PROVIDER_UNAVAILABLE' || error.code === 'PROVIDER_REQUEST_FAILED' || error.code === 'INVALID_RESPONSE') return 502;
  return 500;
}

function invalidRequest(message: string) {
  return new ProviderError('INVALID_REQUEST', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type GatewayServer = Server;
