import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ProviderError, type ChatChunk, type ChatMessage, type ChatRequest, type ChatResponse, type MessageContent, type Model, type ToolDefinition } from '@omnihilbras/sdk';
import { createGatewayService, loadGatewayConfig, type GatewayConfig } from './config.js';
import type { GatewayService } from './service.js';

export type GatewayServerOptions = {
  corsOrigin?: string;
  maxBodyBytes?: number;
};

export function createGatewayServer(service: GatewayService, options: GatewayServerOptions = {}) {
  return createServer((request, response) => {
    void handleRequest(request, response, service, options).catch((error) => {
      sendError(response, error, options.corsOrigin ?? '*');
    });
  });
}

export async function startGatewayServer(options: {
  config?: GatewayConfig;
  env?: Readonly<Record<string, string | undefined>>;
  corsOrigin?: string;
} = {}) {
  const config = options.config ?? loadGatewayConfig(options.env);
  const service = createGatewayService(config, options.env);
  const server = createGatewayServer(service, { corsOrigin: options.corsOrigin });

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

async function handleRequest(request: IncomingMessage, response: ServerResponse, service: GatewayService, options: GatewayServerOptions) {
  const origin = options.corsOrigin ?? '*';
  setCors(response, origin);
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, { service: 'omnihilbras-gateway', ...(await service.health()) }, origin);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/models') {
    const result = await service.listAllModels();
    sendJson(response, 200, {
      object: 'list',
      data: result.models.map(toOpenAIModel),
      unavailable: result.unavailable,
    }, origin);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await handleChat(request, response, service, options, origin);
    return;
  }

  sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Route not found.' } }, origin);
}

async function handleChat(request: IncomingMessage, response: ServerResponse, service: GatewayService, options: GatewayServerOptions, origin: string) {
  const body = await readJsonBody(request, options.maxBodyBytes ?? 1_000_000);
  const chatRequest = parseChatRequest(body);
  const providerId = getProviderId(request, body);
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.once('aborted', abort);
  request.once('close', () => {
    if (!response.writableEnded) controller.abort();
  });

  if (!chatRequest.stream) {
    const result = await service.chat(providerId, chatRequest, controller.signal);
    sendJson(response, 200, toOpenAICompletion(result), origin);
    return;
  }

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'access-control-allow-origin': origin,
  });
  response.flushHeaders();

  try {
    for await (const chunk of service.streamChat(providerId, chatRequest, controller.signal)) {
      response.write(`data: ${JSON.stringify(toOpenAIChunk(chunk))}\n\n`);
    }
    response.write('data: [DONE]\n\n');
    response.end();
  } catch (error) {
    response.write(`event: error\ndata: ${JSON.stringify(toErrorEnvelope(error))}\n\n`);
    response.end();
  }
}

function parseChatRequest(body: unknown): ChatRequest {
  if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
  if (typeof body.model !== 'string' || !body.model.trim()) throw invalidRequest('model is required.');
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw invalidRequest('messages must be a non-empty array.');

  const messages = body.messages.map((message) => parseMessage(message));
  const request: ChatRequest = {
    model: body.model,
    messages,
    ...(typeof body.stream === 'boolean' ? { stream: body.stream } : {}),
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === 'number' ? { topP: body.top_p } : {}),
    ...(parseMaxTokens(body) !== undefined ? { maxOutputTokens: parseMaxTokens(body) } : {}),
    ...(parseStop(body) !== undefined ? { stop: parseStop(body) } : {}),
    ...(Array.isArray(body.tools) ? { tools: body.tools.map(parseTool) } : {}),
    ...(isRecord(body.provider_options) ? { providerOptions: body.provider_options } : {}),
  };
  return request;
}

function parseMessage(value: unknown): ChatMessage {
  if (!isRecord(value) || (value.role !== 'system' && value.role !== 'user' && value.role !== 'assistant' && value.role !== 'tool')) {
    throw invalidRequest('Each message must have a valid role.');
  }
  const content = parseContent(value.content);
  return {
    role: value.role,
    content,
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(typeof value.tool_call_id === 'string' ? { toolCallId: value.tool_call_id } : {}),
  };
}

function parseContent(value: unknown): MessageContent {
  if (value === null || typeof value === 'string') return value;
  if (!Array.isArray(value)) throw invalidRequest('Message content must be a string, null, or content-part array.');
  return value.map((part) => {
    if (!isRecord(part)) throw invalidRequest('Message content parts must be objects.');
    if (part.type === 'text' && typeof part.text === 'string') return { type: 'text' as const, text: part.text };
    if (part.type === 'image_url' && isRecord(part.image_url) && typeof part.image_url.url === 'string') {
      return { type: 'image_url' as const, imageUrl: { url: part.image_url.url, ...(part.image_url.detail === 'low' || part.image_url.detail === 'high' ? { detail: part.image_url.detail } : {}) } };
    }
    throw invalidRequest('Message content contains an unsupported part.');
  });
}

function parseTool(value: unknown): ToolDefinition {
  if (!isRecord(value) || !isRecord(value.function) || typeof value.function.name !== 'string' || !isRecord(value.function.parameters)) {
    throw invalidRequest('Each tool must contain a function name and parameters.');
  }
  return {
    name: value.function.name,
    ...(typeof value.function.description === 'string' ? { description: value.function.description } : {}),
    parameters: value.function.parameters,
  };
}

function parseMaxTokens(body: Record<string, unknown>) {
  const value = body.max_completion_tokens ?? body.max_tokens;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function parseStop(body: Record<string, unknown>) {
  if (typeof body.stop === 'string') return [body.stop];
  if (Array.isArray(body.stop) && body.stop.every((value) => typeof value === 'string')) return body.stop;
  return undefined;
}

function getProviderId(request: IncomingMessage, body: unknown) {
  const header = request.headers['x-omnihilbras-provider'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  if (isRecord(body) && typeof body.provider === 'string' && body.provider.trim()) return body.provider.trim();
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

function setCors(response: ServerResponse, origin: string) {
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('access-control-allow-headers', 'content-type, x-omnihilbras-provider');
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
}

function sendJson(response: ServerResponse, status: number, body: unknown, origin: string) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload), 'access-control-allow-origin': origin });
  response.end(payload);
}

function sendError(response: ServerResponse, error: unknown, origin: string) {
  if (response.headersSent) {
    response.end();
    return;
  }
  const envelope = toErrorEnvelope(error);
  sendJson(response, statusForError(error), envelope, origin);
}

function toErrorEnvelope(error: unknown) {
  if (error instanceof ProviderError) {
    return { error: { code: error.code, message: error.message, ...(error.providerId ? { provider: error.providerId } : {}) } };
  }
  return { error: { code: 'INTERNAL_ERROR', message: 'The gateway encountered an unexpected error.' } };
}

function statusForError(error: unknown) {
  if (!(error instanceof ProviderError)) return 500;
  if (error.code === 'INVALID_REQUEST') return 400;
  if (error.code === 'AUTHENTICATION_FAILED') return 401;
  if (error.code === 'NOT_SUPPORTED') return 501;
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
