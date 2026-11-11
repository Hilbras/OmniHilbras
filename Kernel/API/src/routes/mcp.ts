/**
 * Model Context Protocol (MCP) endpoint — JSON-RPC 2.0 over HTTP.
 *
 * Exposes a small set of gateway operations as MCP tools so any MCP client (Claude Desktop, Cursor,
 * etc.) can inspect and drive the local gateway. Authenticated like the LLM surface: a presented
 * gateway API key is required unless the request comes from the trusted dashboard origin.
 */

import type { RouteContext } from './route-context.js';
import { sendJson, readJsonBody, invalidRequest } from '../core/http.js';
import { extractApiKey } from './inference.js';

const MCP_PATH = '/v1/mcp';

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

  const isMcpPath = url.pathname === MCP_PATH;
  if (!isMcpPath) return false;

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return true;
  }

  // Auth gate, same as the LLM surface.
  if (!ctx.auth || ctx.auth.kind !== 'dashboard') {
    try {
      await service.authorizePublicRequest(extractApiKey(request));
    } catch (error) {
      // Fall through to a 401 response below.
      sendJson(response, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }, origin);
      return true;
    }
  }

  if (request.method !== 'POST') {
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
  const id = req.id ?? null;
  const method = typeof req.method === 'string' ? req.method : '';

  if (method === 'initialize') {
    sendJson(response, 200, rpcResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'omnihilbras-gateway', version: '3.12.1' },
    }), origin);
    return true;
  }

  if (method === 'tools/list') {
    sendJson(response, 200, rpcResult(id, { tools: TOOLS }), origin);
    return true;
  }

  if (method === 'tools/call') {
    const params = (req.params && typeof req.params === 'object' ? req.params : {}) as { name?: string };
    const toolName = typeof params.name === 'string' ? params.name : '';
    try {
      const result = await callTool(ctx, toolName);
      sendJson(response, 200, rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result) }] }), origin);
    } catch (error) {
      sendJson(response, 200, rpcResult(id, { content: [{ type: 'text', text: String(error) }], isError: true }), origin);
    }
    return true;
  }

  sendJson(response, 200, rpcError(id, -32601, `Method not found: ${method}`), origin);
  return true;
}
