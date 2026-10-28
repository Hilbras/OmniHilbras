import { randomUUID } from "node:crypto";

/**
 * CodeBuddy gateway channel-verification headers.
 *
 * Both the CN (copilot.tencent.com) and Intl (www.codebuddy.ai) chat gateways
 * run a channel check on every /v2/chat/completions request. A request that
 * does not carry the conversation headers the official CodeBuddy CLI sends is
 * rejected with HTTP 400 and code 11128 ("request illegal" — "this call failed
 * channel verification, possibly because it was not sent from an official
 * client").
 *
 * Verified against the live gateway: all three headers must be present with a
 * non-empty value; the gateway matches names case-insensitively and treats the
 * values as opaque ids. Nothing else in the CLI header set is load-bearing —
 * the User-Agent, the IDE/product headers and gzip encoding all pass without
 * them (the CLI sends gzip, the gateway accepts both).
 */
export const CODEBUDDY_CONVERSATION_HEADERS = {
  conversationId: "X-Conversation-ID",
  conversationRequestId: "X-Conversation-Request-ID",
  conversationMessageId: "X-Conversation-Message-ID",
  requestId: "X-Request-ID",
};

/**
 * Fresh conversation headers for one upstream request.
 *
 * The CLI reuses the message id as the request id, so we do the same.
 */
export function buildCodeBuddyConversationHeaders() {
  const messageId = randomUUID().replace(/-/g, "");
  return {
    [CODEBUDDY_CONVERSATION_HEADERS.conversationId]: randomUUID(),
    [CODEBUDDY_CONVERSATION_HEADERS.conversationRequestId]: randomUUID(),
    [CODEBUDDY_CONVERSATION_HEADERS.conversationMessageId]: messageId,
    [CODEBUDDY_CONVERSATION_HEADERS.requestId]: messageId,
  };
}
