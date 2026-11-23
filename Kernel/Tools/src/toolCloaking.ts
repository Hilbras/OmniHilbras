import type { ToolChoice, ToolDefinition, ToolMessage, ToolRequest } from './types.js';

/**
 * Deterministic tool-name cloaking for Claude connections.
 *
 * This is **only** the name/rename half of the Claude Code tool surface: client definitions are sent with a
 * stable suffix, unavailable decoy definitions are appended, and every name that comes back is restored to the
 * one the client declared before the gateway's tool guard sees it. It deliberately does **not** carry over the
 * reference implementation's forged billing header, synthetic user id, or browser/TLS impersonation — those are a
 * different (and forbidden) stack. A decoy is a declaration, never an executable tool: it carries an empty input
 * schema, an "unavailable" description, and its name is put on the *blocked* side of the restore map so a call to
 * one can never be mistaken for a client call of the same name.
 *
 * The rename is a pure function of the declaration list, so a retry with the same request produces the same wire
 * names and the same restore map. There is no random state.
 */

/** The suffix the Claude Code client's own tool names carry on the wire. */
export const CLAUDE_TOOL_SUFFIX = '_ide';

/** Provider ids whose connection uses the Claude tool surface. */
export const CLAUDE_TOOL_PROVIDERS: ReadonlySet<string> = new Set(['anthropic', 'claude-code']);

/** A name no client can declare and no validator can allow; decoy calls are renamed to it before validation. */
export const DECOY_CALL_NAME = '\u0000decoy-call';

/** Claude Code tool names used as unavailable decoys. Shell and write tools are deliberately absent. */
export const CLAUDE_DECOY_TOOL_NAMES = [
  'Task', 'TaskOutput', 'TaskStop', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList',
  'Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch', 'AskUserQuestion', 'Skill',
  'EnterPlanMode', 'ExitPlanMode',
] as const;

const UNAVAILABLE = 'This tool is currently unavailable and must not be used.';

const DECOY_TOOLS: readonly ToolDefinition[] = CLAUDE_DECOY_TOOL_NAMES.map((name) => ({
  name,
  description: UNAVAILABLE,
  parameters: { type: 'object', properties: {}, additionalProperties: false },
}));

/** A connection can name a Claude provider directly or carry it in its shared-provider list. */
export function shouldCloakTools(providerId: string, connection?: { providerId?: string; providers?: readonly string[] }): boolean {
  if (CLAUDE_TOOL_PROVIDERS.has(providerId)) return true;
  if (!connection) return false;
  if (connection.providerId && CLAUDE_TOOL_PROVIDERS.has(connection.providerId)) return true;
  return (connection.providers ?? []).some((id) => CLAUDE_TOOL_PROVIDERS.has(id));
}

/** Restore a wire name to the caller's own name, or block a decoy call. */
export function restoreClaudeToolName(
  wire: string | undefined,
  renames: ReadonlyMap<string, string>,
  declared: ReadonlySet<string>,
): string | undefined {
  if (!wire) return undefined;
  const mapped = renames.get(wire);
  if (mapped !== undefined) return mapped;
  // Last-resort fallback for a retry whose map was lost. Only a name whose base the client actually
  // declared is stripped, so a genuinely declared `foo_ide` is not silently rewritten to `foo`.
  if (wire.endsWith(CLAUDE_TOOL_SUFFIX)) {
    const base = wire.slice(0, -CLAUDE_TOOL_SUFFIX.length);
    if (base && declared.has(base)) return base;
  }
  return wire;
}

export type CloakedTools<T extends ToolRequest> = {
  request: T;
  /** Wire name → the caller's name. Decoy names map to `DECOY_CALL_NAME`, which no allow list contains. */
  renames: Map<string, string>;
};

/**
 * Rename client definitions, append unavailable decoys, and carry the restore map.
 *
 * A request without tools is returned untouched: adding decoys to a turn that declared none would put tool
 * definitions on the wire the client never asked for. Tools that carry a `type` are left alone by the reference
 * implementation because they are server-side built-ins with reserved names; the gateway's neutral shape has no
 * such field, so every definition here is a client definition.
 */
export function cloakClaudeTools<T extends ToolRequest>(request: T): CloakedTools<T> {
  const tools = request.tools;
  if (!tools || tools.length === 0) return { request, renames: new Map() };

  const originals = new Set(tools.map((tool) => tool.name));
  const renames = new Map<string, string>();
  const toWire = new Map<string, string>();
  const cloaked: ToolDefinition[] = [];
  for (const tool of tools) {
    const wire = tool.name.endsWith(CLAUDE_TOOL_SUFFIX) ? tool.name : `${tool.name}${CLAUDE_TOOL_SUFFIX}`;
    toWire.set(tool.name, wire);
    if (wire !== tool.name) renames.set(wire, tool.name);
    cloaked.push({ ...tool, name: wire });
  }

  // Skip a decoy whose name (cloaked or plain) the client itself declared. Without this, a call to the
  // decoy would restore to a name on the allow list and a decoy call would reach the client.
  for (const decoy of DECOY_TOOLS) {
    if (originals.has(decoy.name) || originals.has(`${decoy.name}${CLAUDE_TOOL_SUFFIX}`)) continue;
    cloaked.push(decoy);
    renames.set(decoy.name, DECOY_CALL_NAME);
  }

  const messages = request.messages?.map((message: ToolMessage) => {
    if (!message.toolCalls?.length) return message;
    return {
      ...message,
      toolCalls: message.toolCalls.map((call) => {
        const wire = toWire.get(call.function.name);
        return wire && wire !== call.function.name
          ? { ...call, function: { ...call.function, name: wire } }
          : call;
      }),
    };
  });

  // The neutral `ToolChoice` is a string, but an Anthropic client can send
  // `{"type":"tool","name":"..."}`. The Messages translator reduces that to `required`; a direct caller
  // can still pass the object, so rewrite its name when it targets a tool we actually renamed.
  const rawChoice = request.toolChoice as unknown;
  let toolChoice = request.toolChoice;
  if (rawChoice && typeof rawChoice === 'object' && (rawChoice as { type?: unknown }).type === 'tool') {
    const name = (rawChoice as { name?: unknown }).name;
    if (typeof name === 'string') {
      const wire = toWire.get(name);
      if (wire) toolChoice = { ...(rawChoice as Record<string, unknown>), name: wire } as unknown as ToolChoice;
    }
  }

  return {
    request: {
      ...request,
      tools: cloaked,
      ...(messages === undefined ? {} : { messages }),
      ...(toolChoice === request.toolChoice ? {} : { toolChoice }),
    } as T,
    renames,
  };
}
