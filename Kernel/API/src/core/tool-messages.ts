import { fillMissingToolResponses, healToolIds } from '@omnihilbras/tools';
import type { ChatMessage } from './types.js';

/**
 * The gateway's tool-history boundary.
 *
 * The pure decisions live in Kernel/Tools (9router-style id healing and missing-result insertion). This file keeps
 * the name the request path already used and applies the two passes in the order that matters: heal the ids first,
 * then fill a result against the healed id. Doing it the other way round writes an empty result under a malformed id
 * that the next provider would reject.
 */
export function completeToolRounds(messages: readonly ChatMessage[]): ChatMessage[] {
  return fillMissingToolResponses(healToolIds(messages));
}
