import type { ChatMessage } from './types.js';

const longAfterLines = 250;
const keepHeadLines = 120;
const keepTailLines = 60;

/**
 * Shortens long plain-text tool results before they are resent, keeping the head and tail and stating how many
 * lines were dropped. Agent loops resend every result on every turn, and most of a long output is never read
 * again.
 *
 * It never touches a result marked as an error, a message that is not a tool result, or content that is not
 * text, and it returns the original messages when anything goes wrong or when the output would not be smaller.
 */
export function compressToolResults(messages: readonly ChatMessage[]): ChatMessage[] {
  try {
    return messages.map(compressOne);
  } catch {
    return messages as ChatMessage[];
  }
}

function compressOne(message: ChatMessage): ChatMessage {
  if (message.role !== 'tool' || message.isError || typeof message.content !== 'string') return message;
  const lines = message.content.split('\n');
  if (lines.length <= longAfterLines) return message;
  const omitted = lines.length - keepHeadLines - keepTailLines;
  const shortened = [
    ...lines.slice(0, keepHeadLines),
    `... ${omitted} lines omitted ...`,
    ...lines.slice(lines.length - keepTailLines),
  ].join('\n');
  if (shortened.length >= message.content.length) return message;
  return { ...message, content: shortened };
}

/** The total bytes of text in tool results, for reporting how much compression saved. */
export function toolResultBytes(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    if (message.role === 'tool' && typeof message.content === 'string') total += new TextEncoder().encode(message.content).length;
  }
  return total;
}
