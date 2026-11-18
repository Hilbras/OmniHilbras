import type { ToolCall, ToolMessage } from './types.js';

/**
 * Tool-history healing, the part of 9router's translation layer worth keeping.
 *
 * A provider that speaks Anthropic's wire requires tool ids to match `^[A-Za-z0-9_-]+$`. Clients and other providers
 * happily generate ids with spaces, dots or braces, and a malformed id on a replayed turn is a 400 that looks like a
 * provider fault three turns after the bad id was minted. This module heals ids once, at the gateway boundary, and
 * inserts empty results for calls the client left unanswered.
 *
 * Nothing here executes a tool. It only keeps the conversation structurally valid for the next provider.
 */

export const TOOL_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const sanitize = (id: unknown): string | undefined => {
  if (typeof id !== 'string') return undefined;
  const next = id.replace(/[^A-Za-z0-9_-]/g, '');
  return next.length > 0 ? next : undefined;
};

/** Deterministic fallback, like 9router's `call_msg{i}_tc{j}_{name}` rather than a timestamp. */
export function deterministicToolId(messageIndex: number, callIndex: number, name = ''): string {
  const suffix = name ? `_${name.replace(/[^A-Za-z0-9_-]/g, '')}` : '';
  return `call_msg${messageIndex}_tc${callIndex}${suffix}`;
}

function healCall(call: ToolCall, messageIndex: number, callIndex: number, seen: Set<string>): ToolCall {
  const sourceId = typeof call.id === 'string' && call.id ? call.id : undefined;
  let id = sourceId && TOOL_ID_PATTERN.test(sourceId) ? sourceId : (sourceId ? sanitize(sourceId) : undefined);
  if (!id) id = deterministicToolId(messageIndex, callIndex, call.function?.name);
  // A collision within one request is as bad as an invalid id: two tool results would point at the same call.
  if (seen.has(id)) id = deterministicToolId(messageIndex, callIndex, call.function?.name);
  seen.add(id);
  const args = typeof call.function?.arguments === 'string' ? call.function.arguments : undefined;
  return {
    ...call,
    id,
    type: 'function',
    function: {
      name: call.function?.name ?? 'tool',
      ...(args !== undefined ? { arguments: args } : { arguments: '{}' }),
    },
  };
}

/** Heal every tool id in a conversation without changing any content or tool definition. */
export function healToolIds<T extends ToolMessage>(messages: readonly T[]): T[] {
  const seen = new Set<string>();
  return messages.map((message, index) => {
    const calls = message.toolCalls;
    if (calls?.length) {
      return {
        ...message,
        toolCalls: calls.map((call, callIndex) => healCall(call, index, callIndex, seen)),
      };
    }
    if (message.role === 'tool' && message.toolCallId && !TOOL_ID_PATTERN.test(message.toolCallId)) {
      return { ...message, toolCallId: sanitize(message.toolCallId) ?? deterministicToolId(index, 0) };
    }
    return message;
  });
}

function answeredIds(message: ToolMessage | undefined): Set<string> {
  const out = new Set<string>();
  if (!message || message.role !== 'tool') return out;
  if (message.toolCallId) out.add(message.toolCallId);
  // A caller may batch results into one message; the ids are then in the content parts or a list on the message.
  const list = (message as ToolMessage & { toolCallIds?: readonly string[] }).toolCallIds;
  if (Array.isArray(list)) for (const id of list) if (typeof id === 'string') out.add(id);
  return out;
}

/**
 * Insert an empty result after every assistant tool turn that has none. An interrupted agent round otherwise leaves
 * `tool_calls` unanswered, which DeepSeek and Anthropic refuse. Existing results are kept untouched.
 */
export function fillMissingToolResponses<T extends ToolMessage>(messages: readonly T[]): T[] {
  const out: T[] = [];
  const originals = [...messages];
  for (let index = 0; index < originals.length; index += 1) {
    const message = originals[index]!;
    out.push(message);
    const calls = message.role === 'assistant' ? message.toolCalls ?? [] : [];
    if (calls.length === 0) continue;
    const answered = answeredIds(originals[index + 1]);
    for (const call of calls) {
      if (answered.has(call.id)) continue;
      out.push({ role: 'tool', content: '', toolCallId: call.id } as T);
    }
  }
  return out;
}
