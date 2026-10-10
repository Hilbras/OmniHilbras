import type { ChatMessage } from './types.js';

/**
 * Answers every tool call that has no result, by inserting an empty `tool` message directly after the
 * assistant turn that made the call. A provider refuses a conversation with an unanswered call (DeepSeek
 * answers 400), and an agent that interrupts a parallel round produces exactly that. Existing results are
 * kept as they are, and the input is not changed.
 */
export function completeToolRounds(messages: readonly ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    out.push(message);
    const calls = message.role === 'assistant' ? message.toolCalls ?? [] : [];
    if (calls.length === 0) continue;
    const answered = new Set<string>();
    for (let next = index + 1; next < messages.length && messages[next]!.role === 'tool'; next += 1) {
      const id = messages[next]!.toolCallId;
      if (id) answered.add(id);
    }
    for (const call of calls) {
      if (!answered.has(call.id)) out.push({ role: 'tool', content: '', toolCallId: call.id });
    }
  }
  return out;
}
