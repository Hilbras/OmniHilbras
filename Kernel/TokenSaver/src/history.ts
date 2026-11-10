import { countMessageTokens, estimateTokens, retrievalMarker } from './ccr.js';
import type { CcrStore, SavableMessage } from './types.js';

export type HistoryTrimOptions = {
  /** Trim only when the estimated input exceeds this. Zero disables. */
  maxInputTokens: number;
  /** Last N messages are kept verbatim. */
  keepRecent: number;
  ccr?: CcrStore;
  reversible?: boolean;
};

export type HistoryTrimResult = {
  messages: SavableMessage[];
  trimmed: number;
  originalTokens: number;
  trimmedTokens: number;
};

function stubbed(message: SavableMessage, marker: string): SavableMessage {
  // Keep role, name, toolCallId and toolCalls: the conversation's structure is what the provider
  // validates; only the content bytes are replaced.
  return { ...message, content: marker };
}

/**
 * Threshold-based conversation trimming.
 *
 * Old tool output is the bulk of a long coding conversation. Whole old messages are replaced with a
 * retrieval marker — never a partial turn — while system prompts, the first user ask, error-bearing
 * tool results and the last N messages stay intact. The first user message is the request; losing it
 * makes the remaining context unanswerable.
 */
export function trimHistory(messages: readonly SavableMessage[], options: HistoryTrimOptions): HistoryTrimResult {
  const originalTokens = countMessageTokens(messages);
  if (!options.maxInputTokens || originalTokens <= options.maxInputTokens) {
    return { messages: [...messages], trimmed: 0, originalTokens, trimmedTokens: originalTokens };
  }
  const keep = new Set<number>();
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]!.role === 'system') keep.add(index);
  }
  const firstUser = messages.findIndex((message) => message.role === 'user');
  if (firstUser !== -1) keep.add(firstUser);
  for (let index = Math.max(0, messages.length - Math.max(1, options.keepRecent)); index < messages.length; index += 1) keep.add(index);
  for (let index = 0; index < messages.length; index += 1) {
    if ((messages[index] as { isError?: boolean }).isError === true) keep.add(index);
  }

  const output = messages.map((message, index) => {
    if (keep.has(index)) return message;
    const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
    const marker = options.ccr && options.reversible !== false
      ? retrievalMarker(options.ccr.put(text, 'text').id, text.length)
      : `[history trimmed: ${estimateTokens(text)} estimated tokens elided]`;
    return stubbed(message, marker);
  });
  const trimmedTokens = countMessageTokens(output);
  return {
    messages: output,
    trimmed: messages.length - keep.size,
    originalTokens,
    trimmedTokens,
  };
}
