import type { ToolDefinition } from './types.js';

/**
 * Local tools the gateway can execute on a provider's behalf.
 *
 * The names deliberately do not collide with the OpenCode free-tier declaration (`read`, `glob`, `grep`). They are
 * also deliberately *not* a shell: there is no `bash`, no write, no network and no process execution. A model can
 * read a file inside an operator-approved directory; it cannot run a command. The executor lives in Kernel/API
 * because it touches the filesystem; this package owns the contract, the schemas and the prompt representation.
 */

export const LOCAL_TOOL_NAMES = ['local_read', 'local_glob', 'local_grep'] as const;
export type LocalToolName = (typeof LOCAL_TOOL_NAMES)[number];

const MAX_PATH_CHARS = 4_096;
const MAX_PATTERN_CHARS = 512;
const MAX_BYTES = 64 * 1024;

export type LocalToolCall = { name: LocalToolName; path?: string; pattern?: string; limit?: number };

export function isLocalToolName(name: string): name is LocalToolName {
  return (LOCAL_TOOL_NAMES as readonly string[]).includes(name);
}

export function localToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'local_read',
      description: 'Read a UTF-8 text file inside an operator-approved directory. Read-only; no commands are executed.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute path or path relative to an approved root' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
    {
      name: 'local_glob',
      description: 'List files inside an operator-approved directory whose path matches a simple * wildcard pattern. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory to search' },
          pattern: { type: 'string', description: 'Simple wildcard pattern, e.g. src/*.ts' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
        required: ['path', 'pattern'],
        additionalProperties: false,
      },
    },
    {
      name: 'local_grep',
      description: 'Return matching lines from files inside an operator-approved directory. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File or directory to search' },
          pattern: { type: 'string', description: 'Literal text to find (not a regular expression)' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
        required: ['path', 'pattern'],
        additionalProperties: false,
      },
    },
  ];
}

/** The instruction appended to a provider that has no native function-calling surface. */
export const LOCAL_TOOL_PROMPT = [
  'You have read-only local tools. To use one, reply with exactly one fenced block and nothing else:',
  '```local-tool',
  '{"name":"local_read","arguments":{"path":"relative/file.txt"}}',
  '```',
  'Available tools: local_read({path}), local_glob({path,pattern,limit?}), local_grep({path,pattern,limit?}).',
  'Paths are relative to the approved directories. No shell, write or network tool exists. If you do not need a',
  'tool, answer normally in prose.',
].join('\n');

/** Parse a fenced tool call from a plain-text answer. Returns `undefined` when the answer is ordinary prose. */
export function parsePromptToolCall(text: string): LocalToolCall | undefined {
  const match = /```local-tool\s*\n([\s\S]*?)```/.exec(text);
  if (!match) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(match[1]!.trim());
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as { name?: unknown; arguments?: unknown };
  if (typeof candidate.name !== 'string' || !isLocalToolName(candidate.name)) return undefined;
  const args = candidate.arguments && typeof candidate.arguments === 'object' ? candidate.arguments as Record<string, unknown> : {};
  const path = typeof args.path === 'string' && args.path.length <= MAX_PATH_CHARS ? args.path : undefined;
  const pattern = typeof args.pattern === 'string' && args.pattern.length <= MAX_PATTERN_CHARS ? args.pattern : undefined;
  const limit = typeof args.limit === 'number' && Number.isInteger(args.limit) && args.limit > 0 && args.limit <= 200 ? args.limit : undefined;
  return { name: candidate.name, ...(path ? { path } : {}), ...(pattern ? { pattern } : {}), ...(limit ? { limit } : {}) };
}

/** Validate a native tool call without touching the filesystem. */
export function parseNativeToolCall(name: string, argumentsText: string): LocalToolCall | undefined {
  if (!isLocalToolName(name)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(argumentsText);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const args = value as Record<string, unknown>;
  const path = typeof args.path === 'string' && args.path.length <= MAX_PATH_CHARS ? args.path : undefined;
  const pattern = typeof args.pattern === 'string' && args.pattern.length <= MAX_PATTERN_CHARS ? args.pattern : undefined;
  const limit = typeof args.limit === 'number' && Number.isInteger(args.limit) && args.limit > 0 && args.limit <= 200 ? args.limit : undefined;
  return { name, ...(path ? { path } : {}), ...(pattern ? { pattern } : {}), ...(limit ? { limit } : {}) };
}

export const LOCAL_TOOL_MAX_BYTES = MAX_BYTES;
