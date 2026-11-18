import { repairArguments } from './args.js';
import { toolCaps } from './caps.js';
import type { NormalizedToolRequest, ToolCall, ToolDefinition, ToolRequest, ToolRequestNotes } from './types.js';

/**
 * One place where a provider's tool contract is applied.
 *
 * Everything here is a *decision*, not plumbing: whether this provider serves tools at all, whether it can be told to
 * force a call, which definitions are safe to forward, and whether the call that came back is one the client can run.
 * The gateway calls these and reports the result; it does not re-decide any of it, which is the property that keeps
 * `service.ts` provider-neutral.
 */

export type ToolContractCode = 'TOOLS_UNSUPPORTED' | 'TOOL_CHOICE_UNSUPPORTED' | 'TOOL_CALL_INVALID';

export class ToolContractError extends Error {
  constructor(
    readonly code: ToolContractCode,
    readonly providerId: string,
    message: string,
    /** The sentence a user can act on. The message above is for a log. */
    readonly publicMessage: string,
  ) {
    super(message);
    this.name = 'ToolContractError';
  }
}

/** A tool name a provider will accept, and that cannot smuggle a delimiter into a prompt. */
const SAFE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_DESCRIPTION_CHARS = 2_000;
/** Total bytes the definitions may occupy. A schema is paid for on every turn of a conversation. */
export const MAX_SCHEMA_BYTES = 32 * 1024;

const utf8 = (text: string): number => new TextEncoder().encode(text).length;

function sanitizeDefinitions(tools: readonly ToolDefinition[]): { tools: ToolDefinition[]; dropped: { name: string; reason: string }[] } {
  const kept: ToolDefinition[] = [];
  const dropped: { name: string; reason: string }[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const tool of tools) {
    const name = typeof tool?.name === 'string' ? tool.name.trim() : '';
    if (!SAFE_NAME.test(name)) {
      dropped.push({ name: name || '(unnamed)', reason: 'the name is not 1-64 letters, digits, _ or -' });
      continue;
    }
    if (seen.has(name)) {
      dropped.push({ name, reason: 'the same name was declared twice' });
      continue;
    }
    if (!tool.parameters || typeof tool.parameters !== 'object' || Array.isArray(tool.parameters)) {
      dropped.push({ name, reason: 'parameters is not a JSON schema object' });
      continue;
    }
    const description = typeof tool.description === 'string' ? tool.description.slice(0, MAX_DESCRIPTION_CHARS) : undefined;
    const sanitized: ToolDefinition = { name, parameters: tool.parameters, ...(description ? { description } : {}) };
    const size = utf8(JSON.stringify(sanitized));
    if (bytes + size > MAX_SCHEMA_BYTES) {
      dropped.push({ name, reason: `the schema would exceed ${MAX_SCHEMA_BYTES} bytes` });
      continue;
    }
    bytes += size;
    seen.add(name);
    kept.push(sanitized);
  }
  return { tools: kept, dropped };
}

/** A forced call with nothing to call is not a request we can honour, however the provider would parse it. */
function forcedWithoutDefinitions(providerId: string): ToolContractError {
  return new ToolContractError(
    'TOOL_CHOICE_UNSUPPORTED',
    providerId,
    `${providerId} was asked to force a call with no tool definitions`,
    'tool_choice: "required" needs at least one valid tool definition. Send one, or omit tool_choice.',
  );
}

function emptyNotes(providerId: string): ToolRequestNotes {
  return { stripped: false, enforcedNone: false, assumed: false, providerId, dropped: [] };
}

/**
 * The request as this provider must receive it.
 *
 * Four outcomes, each deliberate:
 *
 * - no tools and no choice — returned untouched, and the whole path costs a map lookup;
 * - `tool_choice: 'none'` — the definitions are removed, whatever the adapter would have done with them;
 * - tools on a provider that does not serve them — removed, and the notes say so, so the response can too;
 * - `tool_choice: 'required'` on a provider that cannot force — refused by name. It used to be forwarded and ignored,
 *   which told the client its constraint had been honoured when it had not.
 *
 * Sanitising is not optional: a name and description are client input that becomes instructions on the provider's
 * side, and a duplicate or oversized schema is a refusal from the provider that reads as our bug.
 */
export function normalizeToolsRequest<T extends ToolRequest>(request: T, providerId: string): NormalizedToolRequest<T> {
  const caps = toolCaps(providerId);
  const notes = { ...emptyNotes(providerId), assumed: caps.assumed === true };
  const hasTools = Array.isArray(request.tools) && request.tools.length > 0;
  const choice = request.toolChoice;
  if (!hasTools && choice === undefined) return { request, notes };

  if (!caps.tools) {
    notes.stripped = hasTools;
    const { tools: _tools, toolChoice: _choice, ...rest } = request;
    return { request: rest as T, notes };
  }

  if (choice === 'none') {
    notes.enforcedNone = hasTools;
    const { tools: _tools, ...rest } = request;
    return { request: { ...rest, toolChoice: 'none' } as T, notes };
  }

  if (choice === 'required' && !caps.toolChoice.includes('required')) {
    throw new ToolContractError(
      'TOOL_CHOICE_UNSUPPORTED',
      providerId,
      `${providerId} cannot honour tool_choice: "required"`,
      `${providerId} cannot be told to force a tool call. Supported values: ${caps.toolChoice.join(', ')}. Send "auto" or omit tool_choice.`,
    );
  }

  if (choice === 'required' && !hasTools) throw forcedWithoutDefinitions(providerId);
  if (!hasTools) return { request, notes };
  const { tools, dropped } = sanitizeDefinitions(request.tools ?? []);
  notes.dropped = dropped;
  if (choice === 'required' && tools.length === 0) throw forcedWithoutDefinitions(providerId);
  // Every definition rejected is not "no tools declared": the caller asked for tools and none survived.
  return { request: { ...request, tools } as T, notes };
}

export type CallIssue = { index: number; name: string; reason: string };

/**
 * The calls a client may run, and the ones it may not.
 *
 * A call is returned only when it names a tool the client declared and its arguments are a JSON object after the
 * bounded repair. Anything else is listed as an issue rather than forwarded: a wrong `bash` with a plausible command
 * runs, and the agent that runs it has no way to tell it came from a malformed payload.
 */
export function validateToolCalls(
  calls: readonly ToolCall[],
  declared: readonly string[],
): { calls: ToolCall[]; issues: CallIssue[]; repaired: { index: number; repairs: readonly string[] }[] } {
  const valid: ToolCall[] = [];
  const issues: CallIssue[] = [];
  const repaired: { index: number; repairs: readonly string[] }[] = [];
  const allowed = new Set(declared);
  calls.forEach((call, index) => {
    const name = typeof call?.function?.name === 'string' ? call.function.name.trim() : '';
    if (!name) {
      issues.push({ index, name: '(empty)', reason: 'the call has no function name' });
      return;
    }
    if (allowed.size > 0 && !allowed.has(name)) {
      issues.push({ index, name, reason: 'the call names a tool the client did not declare' });
      return;
    }
    const argumentsText = typeof call.function.arguments === 'string' ? call.function.arguments : '';
    const repair = repairArguments(argumentsText);
    if (!repair.ok) {
      issues.push({ index, name, reason: repair.reason });
      return;
    }
    if (repair.result.repairs.length > 0) repaired.push({ index, repairs: repair.result.repairs });
    valid.push({ id: call.id || `call_${index}`, type: 'function', function: { name, arguments: repair.result.text } });
  });
  return { calls: valid, issues, repaired };
}
