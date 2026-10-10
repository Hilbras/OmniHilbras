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
    const toolNames = toolNamesByCallId(messages);
    return messages.map((message) => compressOne(message, message.toolCallId ? toolNames.get(message.toolCallId) : undefined));
  } catch {
    return messages as ChatMessage[];
  }
}

/** Each tool call's id mapped to the tool's name, read from the assistant turn that made the call. */
function toolNamesByCallId(messages: readonly ChatMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) names.set(call.id, call.function.name);
  }
  return names;
}

function compressOne(message: ChatMessage, toolName: string | undefined): ChatMessage {
  if (message.role !== 'tool' || message.isError || typeof message.content !== 'string') return message;
  const lines = message.content.split('\n');
  if (lines.length <= longAfterLines) return message;
  const shortened = (toolName === 'grep' ? keepGrepMatches(lines) : undefined) ?? keepHeadAndTail(lines);
  if (shortened.length >= message.content.length) return message;
  return { ...message, content: shortened };
}

function keepHeadAndTail(lines: string[]): string {
  const omitted = lines.length - keepHeadLines - keepTailLines;
  return [
    ...lines.slice(0, keepHeadLines),
    `... ${omitted} lines omitted ...`,
    ...lines.slice(lines.length - keepTailLines),
  ].join('\n');
}

/** A grep line is `path:line: text`. Each match is kept with its context, and the gaps are counted. */
const grepLine = /^[^\s:][^:]*:\d+:/;
const grepContext = 2;

function keepGrepMatches(lines: string[]): string | undefined {
  const matches = lines.map((line, index) => (grepLine.test(line) ? index : -1)).filter((index) => index >= 0);
  if (matches.length === 0) return undefined;
  const keep = new Set<number>();
  for (const index of matches) {
    for (let offset = -grepContext; offset <= grepContext; offset += 1) {
      const at = index + offset;
      if (at >= 0 && at < lines.length) keep.add(at);
    }
  }
  const out: string[] = [];
  let omitted = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (keep.has(index)) {
      if (omitted > 0) out.push(`... ${omitted} lines omitted ...`);
      omitted = 0;
      out.push(lines[index]!);
    } else {
      omitted += 1;
    }
  }
  if (omitted > 0) out.push(`... ${omitted} lines omitted ...`);
  return out.join('\n');
}

/** The total bytes of text in tool results, for reporting how much compression saved. */
export function toolResultBytes(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    if (message.role === 'tool' && typeof message.content === 'string') total += new TextEncoder().encode(message.content).length;
  }
  return total;
}
