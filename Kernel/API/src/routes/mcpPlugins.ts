/**
 * Supervised stdio→SSE bridge for operator-registered MCP plugins.
 *
 * The reference bridge spawned a child for a plugin chosen by the browser. That is remote code
 * execution behind a gateway key unless the set of commands is an operator decision, so this one
 * reads its registry from the gateway's own state directory and spawns **only** an id named there,
 * with `shell: false` and an argv array. Nothing in a request can name a command or an argument.
 *
 * The wire in both directions is newline-delimited JSON-RPC. Child stdout is parsed per line and
 * rebroadcast on each subscriber's SSE stream; a line that is not JSON is dropped rather than
 * forwarded as an event, because a raw text frame from a plugin is not a JSON-RPC message. Tool
 * result text is bounded before it reaches a browser, and a tool named `shell` is refused by name on
 * the way in and removed from a `tools/list` answer on the way out.
 *
 * The last subscriber leaving kills the child: a plugin is not an orphan left behind by a closed tab.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { RouteContext } from './route-context.js';
import { getRequestOrigin, readJsonBody, resolveCorsOrigins, sendJson } from '../core/http.js';
import { extractApiKey } from './inference.js';

const PLUGINS_PATH = '/v1/mcp/plugins';
const STREAM_PREFIX = '/v1/mcp/plugins/stream/';
const MESSAGE_PREFIX = '/v1/mcp/plugins/message/';
const APPROVAL_PREFIX = '/v1/mcp/plugins/approvals/';
const REGISTRY_FILE = 'mcp-plugins.json';
const MAX_TEXT_CHARS = 50_000;
const TRUNCATED_SUFFIX = `\n… [truncated at ${MAX_TEXT_CHARS} characters by the gateway]`;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

type Plugin = { id: string; command: string; args: string[]; tools?: { allow?: string[]; ask?: string[] } };
type Bridge = {
  plugin: Plugin;
  child: ChildProcessWithoutNullStreams;
  buffer: string;
  sessions: Set<string>;
  closed: boolean;
};

type JsonRpc = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
};

const bridges = new Map<string, Bridge>();

/** The registry is operator state, never request data. A missing or malformed file means no plugins. */
export function registeredPlugins(directory: string | undefined): Plugin[] {
  if (!directory) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(directory, REGISTRY_FILE), 'utf8'));
  } catch {
    return [];
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { plugins?: unknown }).plugins)
      ? (parsed as { plugins: unknown[] }).plugins
      : [];
  const out: Plugin[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const command = typeof candidate.command === 'string' ? candidate.command.trim() : '';
    if (!ID_PATTERN.test(id) || !isAbsolute(command)) continue;
    const rawArgs = Array.isArray(candidate.args) ? candidate.args : [];
    if (rawArgs.length > 64 || !rawArgs.every((arg) => typeof arg === 'string' && arg.length <= 4096)) continue;
    const rawTools = candidate.tools;
    let tools: Plugin['tools'];
    if (rawTools && typeof rawTools === 'object') {
      const record = rawTools as Record<string, unknown>;
      const list = (value: unknown) => Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 200) ? value as string[] : undefined;
      const allow = list(record.allow);
      const ask = list(record.ask);
      if (allow || ask) tools = { ...(allow ? { allow } : {}), ...(ask ? { ask } : {}) };
    }
    out.push({ id, command, args: rawArgs as string[], ...(tools ? { tools } : {}) });
  }
  return out;
}

function pluginFor(ctx: RouteContext, id: string): Plugin | undefined {
  const directory = ctx.options.mcpPluginsDir ?? ctx.service.config()?.dataDir;
  return registeredPlugins(directory).find((plugin) => plugin.id === id);
}

/** No text block, however chatty the plugin, may exceed the browser-facing cap. */
function boundFrame(line: string, plugin?: Plugin): string | undefined {
  let message: JsonRpc;
  try {
    message = JSON.parse(line) as JsonRpc;
  } catch {
    return undefined;
  }
  if (!message || typeof message !== 'object') return undefined;
  if (message.result && typeof message.result === 'object') {
    const result = message.result as Record<string, unknown>;
    if (Array.isArray(result.content)) {
      for (const item of result.content) {
        if (item && typeof item === 'object' && (item as { type?: unknown }).type === 'text') {
          const block = item as { text?: unknown };
          if (typeof block.text === 'string' && block.text.length > MAX_TEXT_CHARS) {
            block.text = `${block.text.slice(0, MAX_TEXT_CHARS - TRUNCATED_SUFFIX.length)}${TRUNCATED_SUFFIX}`;
          }
        }
      }
    }
    // A shell tool is not part of this gateway's tool surface even if a plugin advertises one.
    if (Array.isArray(result.tools)) {
      result.tools = result.tools.filter((tool) => {
        const name = tool && typeof tool === 'object' ? (tool as { name?: unknown }).name : undefined;
        if (name === 'shell') return false;
        if (plugin?.tools?.allow && typeof name === 'string' && !plugin.tools.allow.includes(name)) return false;
        return true;
      });
    }
  }
  return JSON.stringify(message);
}

function refusedShell(message: JsonRpc): boolean {
  if (message.method !== 'tools/call') return false;
  const params = message.params;
  if (!params || typeof params !== 'object') return false;
  const name = (params as { name?: unknown }).name;
  return typeof name === 'string' && name.trim().toLowerCase() === 'shell';
}

function stopBridge(id: string): void {
  const bridge = bridges.get(id);
  if (!bridge || bridge.closed) return;
  bridge.closed = true;
  bridges.delete(id);
  try { bridge.child.kill(); } catch { /* already gone */ }
}

function unregister(id: string, sessionId: string): void {
  const bridge = bridges.get(id);
  if (!bridge) return;
  bridge.sessions.delete(sessionId);
  if (bridge.sessions.size === 0) stopBridge(id);
}

function getOrSpawn(plugin: Plugin): Bridge {
  const existing = bridges.get(plugin.id);
  if (existing && !existing.closed && existing.child.exitCode === null && !existing.child.killed) return existing;

  // `shell: false` is explicit: an argv array with a fixed command is the whole executable surface.
  const child = spawn(plugin.command, plugin.args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
  const bridge: Bridge = { plugin, child, buffer: '', sessions: new Set(), closed: false };
  bridges.set(plugin.id, bridge);
  child.stdout.on('data', (chunk: Buffer) => {
    bridge.buffer += chunk.toString('utf8');
    let newline = bridge.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = bridge.buffer.slice(0, newline).trim();
      bridge.buffer = bridge.buffer.slice(newline + 1);
      newline = bridge.buffer.indexOf('\n');
      if (!line) continue;
      const frame = boundFrame(line, plugin);
      if (frame === undefined) continue;
      for (const sessionId of [...bridge.sessions]) {
        const session = sessions.get(sessionId);
        try { session?.(`event: message\ndata: ${frame}\n\n`); } catch { /* the stream already left */ }
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    // Plugin diagnostics stay on the gateway's console; never forwarded to a browser as JSON-RPC.
    console.warn(`[mcp-plugin:${plugin.id}] ${chunk.toString('utf8').trim()}`);
  });
  // Check identity before reaping: a child killed by the previous subscriber can exit *after* a new
  // bridge has replaced it under the same id, and a bare `stopBridge(id)` would then kill the new one.
  child.on('exit', () => { if (bridges.get(plugin.id) === bridge) stopBridge(plugin.id); });
  return bridge;
}

/** SSE subscribers, keyed by session id. Kept separate from the child so a dead stream cannot leak. */
const sessions = new Map<string, (frame: string) => void>();

/** Test-visible count, so the reaping guarantee can be asserted without reaching into child internals. */
export function activePluginBridges(): number {
  return bridges.size;
}

/**
 * Short-lived, one-shot approvals for a tool a plugin marks `ask`.
 *
 * The token is minted by an operator call from the dashboard, bound to one plugin id, and consumed by
 * the next call for that plugin — so an approval cannot silently cover a second invocation. It is
 * held in memory: a restart forgets pending approvals, which is the safe direction.
 */
const approvals = new Map<string, Map<string, number>>();
const approvalTtlMs = 5 * 60_000;

export function mintPluginApproval(pluginId: string): { token: string; expiresAt: string } {
  const token = randomUUID();
  const expiresAt = Date.now() + approvalTtlMs;
  const perPlugin = approvals.get(pluginId) ?? new Map<string, number>();
  perPlugin.set(token, expiresAt);
  approvals.set(pluginId, perPlugin);
  return { token, expiresAt: new Date(expiresAt).toISOString() };
}

export function consumePluginApproval(pluginId: string, token: string | undefined): boolean {
  if (!token) return false;
  const perPlugin = approvals.get(pluginId);
  const expiresAt = perPlugin?.get(token);
  if (!perPlugin || expiresAt === undefined) return false;
  perPlugin.delete(token);
  if (expiresAt <= Date.now()) return false;
  return true;
}

/** The tool name a `tools/call` names, or undefined for any other message. */
function toolCallName(message: JsonRpc): string | undefined {
  if (message.method !== 'tools/call') return undefined;
  const params = message.params;
  if (!params || typeof params !== 'object') return undefined;
  const name = (params as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

export async function handleMcpPluginsRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, service, options, signal } = ctx;
  const isList = url.pathname === PLUGINS_PATH;
  const isStream = url.pathname.startsWith(STREAM_PREFIX);
  const isMessage = url.pathname.startsWith(MESSAGE_PREFIX);
  const isApproval = url.pathname.startsWith(APPROVAL_PREFIX);
  if (!isList && !isStream && !isMessage && !isApproval) return false;

  // The same two gates as /v1/mcp. An Origin from a browser must be one the gateway allows; a key
  // is required for every call that can spawn a process or read a plugin's output.
  if (!ctx.auth || ctx.auth.kind !== 'dashboard') {
    try {
      await service.authorizePublicRequest(extractApiKey(request));
    } catch {
      sendJson(response, 401, { error: { code: 'UNAUTHORIZED', message: 'A gateway key is required for MCP plugin routes.' } }, ctx.origin);
      return true;
    }
  }
  const presentedOrigin = getRequestOrigin(request);
  if (presentedOrigin && !resolveCorsOrigins(options).includes(presentedOrigin)) {
    sendJson(response, 403, { error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Origin not allowed.' } }, ctx.origin);
    return true;
  }

  if (isList) {
    if (request.method !== 'GET') {
      response.setHeader('allow', 'GET');
      sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'MCP plugin registry requires GET.' } }, ctx.origin);
      return true;
    }
    const directory = options.mcpPluginsDir ?? service.config()?.dataDir;
    sendJson(response, 200, { plugins: registeredPlugins(directory).map((plugin) => plugin.id) }, ctx.origin);
    return true;
  }

  const id = isApproval
    ? url.pathname.slice(APPROVAL_PREFIX.length).trim()
    : url.pathname.slice((isStream ? STREAM_PREFIX : MESSAGE_PREFIX).length).trim();
  if (!ID_PATTERN.test(id)) {
    sendJson(response, 400, { error: { code: 'INVALID_REQUEST', message: 'Unknown plugin id.' } }, ctx.origin);
    return true;
  }
  const directory = options.mcpPluginsDir ?? service.config()?.dataDir;
  const plugin = registeredPlugins(directory).find((entry) => entry.id === id);
  if (!plugin) {
    sendJson(response, 404, { error: { code: 'NOT_FOUND', message: `Plugin "${id}" is not registered by the operator.` } }, ctx.origin);
    return true;
  }

  if (isApproval) {
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'An approval is minted with POST.' } }, ctx.origin);
      return true;
    }
    const approval = mintPluginApproval(plugin.id);
    sendJson(response, 201, { plugin: plugin.id, ttlSeconds: approvalTtlMs / 1000, ...approval }, ctx.origin);
    return true;
  }

  if (isStream) {
    if (request.method !== 'GET') {
      response.setHeader('allow', 'GET');
      sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'MCP plugin streams require GET.' } }, ctx.origin);
      return true;
    }
    const bridge = getOrSpawn(plugin);
    const sessionId = randomUUID();
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      ...(ctx.origin ? { 'access-control-allow-origin': ctx.origin } : {}),
    });
    const send = (frame: string): void => { response.write(frame); };
    sessions.set(sessionId, send);
    bridge.sessions.add(sessionId);
    // `writeHead` alone does not put bytes on the socket, so a client waiting for response headers
    // waits forever on a silent plugin. An SSE comment is a valid frame and flushes the headers.
    response.write(': connected\n\n');
    const close = (): void => {
      sessions.delete(sessionId);
      unregister(plugin.id, sessionId);
    };
    signal.addEventListener('abort', close, { once: true });
    response.on('close', close);
    if (signal.aborted) close();
    return true;
  }

  if (request.method !== 'POST') {
    response.setHeader('allow', 'POST');
    sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'MCP plugin messages require POST.' } }, ctx.origin);
    return true;
  }
  let body: unknown;
  try {
    body = await readJsonBody(request, options.maxBodyBytes ?? 1_000_000);
  } catch {
    sendJson(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, ctx.origin);
    return true;
  }
  if (!body || typeof body !== 'object') {
    sendJson(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'A JSON-RPC object is required.' } }, ctx.origin);
    return true;
  }
  const message = body as JsonRpc;
  if (refusedShell(message)) {
    // Refused before any child is spawned: a tool name alone must never reach a plugin's stdin.
    sendJson(response, 400, {
      jsonrpc: '2.0',
      id: message.id ?? null,
      error: { code: -32601, message: 'The tool "shell" is not available through the MCP plugin bridge.' },
    }, ctx.origin);
    return true;
  }
  const toolName = toolCallName(message);
  if (toolName) {
    if (plugin.tools?.allow && !plugin.tools.allow.includes(toolName)) {
      sendJson(response, 403, { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32004, message: `The tool "${toolName}" is not allowed for this plugin.` } }, ctx.origin);
      return true;
    }
    if (plugin.tools?.ask?.includes(toolName)) {
      const presented = request.headers['x-omnihilbras-approval'];
      const token = Array.isArray(presented) ? presented[0] : presented;
      if (!consumePluginApproval(plugin.id, token)) {
        sendJson(response, 403, { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32005, message: `The tool "${toolName}" needs an approval token from POST ${APPROVAL_PREFIX}${plugin.id}.` } }, ctx.origin);
        return true;
      }
    }
  }
  const bridge = getOrSpawn(plugin);
  if (!bridge.child.stdin.writable) {
    sendJson(response, 503, { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32000, message: 'The plugin process is not running.' } }, ctx.origin);
    return true;
  }
  bridge.child.stdin.write(`${JSON.stringify(message)}\n`);
  sendJson(response, 202, { accepted: true }, ctx.origin);
  return true;
}
