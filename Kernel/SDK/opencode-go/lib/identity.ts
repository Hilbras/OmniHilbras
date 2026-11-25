import type { ChatRequest } from '@omnihilbras/sdk-shared/types';
import { zenSessionId, zenUserAgent } from './zen-free-tier.js';

/**
 * The conversation a Go session id is derived from, and why it is the **first** user turn.
 *
 * `zenConversationSeed` hashes every message, so the id changes as soon as the conversation grows — which is fine
 * for a per-request value and wrong for a session. Go routes by session, so a turn-by-turn changing id would give
 * every turn a new session, which is the same as sending none. The first user message plus the model is stable for
 * the life of the conversation and different between conversations.
 */
function conversationKey(request: Pick<ChatRequest, 'model' | 'messages'>): string {
  const firstUser = request.messages.find((message) => message.role === 'user');
  const text = typeof firstUser?.content === 'string' ? firstUser.content : '';
  return `${request.model} ${text}`;
}

/**
 * The CLI identity OpenCode Go expects on *every* provider-bound request, not only on gated ones.
 *
 * The lane's own refusal names the missing piece:
 *
 * ```
 * Request is missing x-opencode-session and cannot be routed efficiently.
 * https://opencode.ai/v2/docs/console/go/#where-can-i-use-it
 * ```
 *
 * Go is documented as "where can I use it" — inside OpenCode — so the upstream routes by session. The gated
 * free-tier path already sent this set (`zenFreeTierHeaders`), which is why only paid Go models failed: they go
 * through the plain chat lane, which knew nothing about the contract.
 */
export function opencodeGoHeaders(request: ChatRequest): Record<string, string> {
  return {
    'user-agent': zenUserAgent(),
    'x-opencode-client': 'desktop',
    'x-opencode-project': 'global',
    'x-opencode-session': zenSessionId(conversationKey(request)),
    'x-opencode-request': zenSessionId(),
  };
}

/** Exported for the test that pins conversation affinity. */
export { conversationKey as opencodeGoConversationKey };
