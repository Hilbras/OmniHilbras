/**
 * Model Context Protocol (MCP) endpoint — JSON-RPC 2.0 over Streamable HTTP.
 *
 * Exposes a small set of gateway operations as MCP tools so any MCP client (Claude Desktop, Cursor,
 * etc.) can inspect and drive the local gateway. Authenticated like the LLM surface: a presented
 * gateway API key is required unless the request comes from the trusted dashboard origin.
 *
 * The transport follows MCP's current Streamable HTTP rules: `Accept: application/json,
 * text/event-stream`, a 202 for a notification with no id, an explicit 405 for GET (this gateway has
 * no server-initiated messages to stream), an Origin check, and an MCP-Protocol-Version check.
 * `2025-11-25` is the version this build negotiates; `2024-11-05` is accepted for older clients and
 * is the fallback when a client asks for a version this build does not implement. The three
 * introspection tools are unchanged.
 */

import type { RouteContext } from './route-context.js';
import { getRequestOrigin, resolveCorsOrigins, sendJson, readJsonBody } from '../core/http.js';
import { extractApiKey } from './inference.js';
import { gatewayBuild } from '../core/build-info.js';

const MCP_PATH = '/v1/mcp';
const PROTOCOL_VERSION = '2025-11-25';
const FALLBACK_PROTOCOL_VERSION = '2024-11-05';
const SUPPORTED_VERSIONS = new Set([PROTOCOL_VERSION, FALLBACK_PROTOCOL_VERSION]);

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

function rpcResult(id: unknown, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

const TOOLS = [
  { name: 'list_connections', description: 'List saved provider connections.', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_models', description: 'List models available across connections.', inputSchema: { type: 'object', properties: {} } },
  { name: 'gateway_status', description: 'Gateway health and build info.', inputSchema: { type: 'object', properties: {} } },
];

async function callTool(ctx: RouteContext, name: string): Promise<unknown> {
  const { service, signal } = ctx;
  if (name === 'list_connections') {
    const connections = await service.listConnections();
    return { connections: connections.map((c) => ({ id: c.id, providerId: c.providerId, name: c.name, enabled: c.enabled })) };
  }
  if (name === 'list_models') {
    const result = await service.listAllModels(signal);
    return { models: result.models.map((m) => ({ id: m.id, ownedBy: m.ownedBy })) };
  }
  if (name === 'gateway_status') {
    return { service: 'omnihilbras-gateway', health: await service.health(signal) };
  }
  throw new Error(`Unknown tool: ${name}`);
}

export async function handleMcpRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, service, origin, options } = ctx;

  if (url.pathname !== MCP_PATH) return false;

  if (request.method === 'OPTIONS') {
    response.writeHead(204, { allow: 'POST, OPTIONS' });
    response.end();
    return true;
  }

  // Auth gate, same as the LLM surface — the origin check below is about *which* browser may call,
  // not about whether a caller has a key. Neither replaces the other.
  if (!ctx.auth || ctx.auth.kind !== 'dashboard') {
    try {
      await service.authorizePublicRequest(extractApiKey(request));
    } catch {
      sendJson(response, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }, origin);
      return true;
    }
  }

  // An Origin from a browser must be one this gateway allows. A non-browser MCP client sends none,
  // which is expected and is not a reason to refuse it.
  const presentedOrigin = getRequestOrigin(request);
  if (presentedOrigin && !resolveCorsOrigins(options).includes(presentedOrigin)) {
    sendJson(response, 403, { jsonrpc: '2.0', id: null, error: { code: -32003, message: 'Origin not allowed.' } }, origin);
    return true;
  }

  // Streamable HTTP clients advertise both response modes. Accepting a request that only tolerates
  // JSON would let a server-initiated SSE message break that client later.
  const accept = request.headers.accept ?? '';
  if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
    response.setHeader('accept', 'application/json, text/event-stream');
    sendJson(response, 406, rpcError(null, -32000, 'Accept must include application/json and text/event-stream.'), origin);
    return true;
  }

  // A client that has initialized declares the version on every later request. An absent header is
  // accepted for the first request and for older clients; an unknown one is refused by name.
  const presentedVersion = request.headers['mcp-protocol-version'];
  if (typeof presentedVersion === 'string' && !SUPPORTED_VERSIONS.has(presentedVersion)) {
    sendJson(response, 400, rpcError(null, -32600, `Unsupported MCP-Protocol-Version: ${presentedVersion}`), origin);
    return true;
  }

  if (request.method === 'GET') {
    // No server-initiated messages exist in this gateway. Refuse the stream explicitly rather than
    // holding a connection open and emitting an event that carries no real state change.
    response.setHeader('allow', 'POST, OPTIONS');
    sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'MCP GET streams are not served by this gateway; use POST.' } }, origin);
    return true;
  }
  if (request.method !== 'POST') {
    response.setHeader('allow', 'POST, OPTIONS');
    sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'MCP requires POST.' } }, origin);
    return true;
  }

  let body: unknown;
  try {
    body = await readJsonBody(request, options.maxBodyBytes ?? 1_000_000);
  } catch {
    sendJson(response, 400, rpcError(null, -32700, 'Parse error'), origin);
    return true;
  }

  const req = (body && typeof body === 'object' ? body : {}) as JsonRpcRequest;
  // A notification (no id) is acknowledged with 202 and no body. Answering it with a JSON-RPC result
  // invites a client to treat the ack as a response to a call it never made.
  const isNotification = req.id === undefined;
  const ack = (): boolean => {
    response.writeHead(202);
    response.end();
    return true;
  };
  const id = req.id ?? null;
  const method = typeof req.method === 'string' ? req.method : '';

  if (method === 'initialize') {
    const requested = req.params && typeof req.params === 'object' ? (req.params as { protocolVersion?: unknown }).protocolVersion : undefined;
    const negotiated = typeof requested === 'string' && SUPPORTED_VERSIONS.has(requested) ? requested : PROTOCOL_VERSION;
    response.setHeader('mcp-protocol-version', negotiated);
    if (isNotification) return ack();
    sendJson(response, 200, rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: 'omnihilbras-gateway', version: gatewayBuild().version },
    }), origin);
    return true;
  }
  if (presentedVersion) response.setHeader('mcp-protocol-version', presentedVersion);

  if (method === 'tools/list') {
    if (isNotification) return ack();
    sendJson(response, 200, rpcResult(id, { tools: TOOLS }), origin);
    return true;
  }

  if (method === 'tools/call') {
    const params = (req.params && typeof req.params === 'object' ? req.params : {}) as { name?: string };
    if (isNotification) {
      // Run the call, but do not answer it: the caller declared it did not want a result.
      try { await callTool(ctx, typeof params.name === 'string' ? params.name : ''); } catch { /* no response channel for a notification */ }
      return ack();
    }
    try {
      const result = await callTool(ctx, typeof params.name === 'string' ? params.name : '');
      sendJson(response, 200, rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result) }] }), origin);
    } catch (error) {
      sendJson(response, 200, rpcResult(id, { content: [{ type: 'text', text: String(error) }], isError: true }), origin);
    }
    return true;
  }

  if (isNotification) return ack();
  sendJson(response, 200, rpcError(id, -32601, `Method not found: ${method}`), origin);
  return true;
}
