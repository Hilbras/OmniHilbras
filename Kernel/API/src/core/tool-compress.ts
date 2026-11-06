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
  const shortened = (toolName === 'grep' ? keepGrepMatches(lines) : toolName === 'git_diff' ? keepDiffChanges(lines) : toolName === 'ls' ? keepListingStructure(lines) : undefined) ?? keepHeadAndTail(lines);
  if (shortened.length >= message.content.length) return message;
  return { ...message, content: shortened };
}

/**
 * A diff is read for what changed. Every hunk header and every changed line is kept, along with up to `grepContext`
 * unchanged lines on each side, and the gaps are counted. The `---` and `+++` file headers are changed-looking text
 * but describe the files, so they are kept as headers.
 */
function keepDiffChanges(lines: string[]): string | undefined {
  const isChange = (line: string) => (line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---');
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.startsWith('@@') || line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || isChange(line)) {
      keep.add(index);
      if (isChange(line)) {
        for (let offset = -grepContext; offset <= grepContext; offset += 1) {
          const at = index + offset;
          if (at >= 0 && at < lines.length) keep.add(at);
        }
      }
    }
  });
  if (keep.size === 0) return undefined;
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

/**
 * A recursive listing is read for its structure. Every directory heading (`path:`) and its `total` line is kept, and
 * within each directory the first and last few entries are kept, with the middle counted.
 */
const listingHeading = /^[^ ].*:$/;
const listingEdge = 3;

function keepListingStructure(lines: string[]): string | undefined {
  const keep = new Set<number>();
  let blockStart = 0;
  const closeBlock = (end: number) => {
    for (let index = blockStart; index < end; index += 1) {
      if (index - blockStart < listingEdge || end - index <= listingEdge) keep.add(index);
    }
  };
  lines.forEach((line, index) => {
    if (listingHeading.test(line) || line.startsWith('total ')) {
      keep.add(index);
      closeBlock(index);
      blockStart = index + 1;
    }
  });
  closeBlock(lines.length);
  if (keep.size === 0) return undefined;
  const out: string[] = [];
  let omitted = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (keep.has(index)) {
      if (omitted > 0) out.push(`... ${omitted} entries omitted ...`);
      omitted = 0;
      out.push(lines[index]!);
    } else {
      omitted += 1;
    }
  }
  if (omitted > 0) out.push(`... ${omitted} entries omitted ...`);
  return out.join('\n');
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
