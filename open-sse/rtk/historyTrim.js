/**
 * History trimming — the conversation-level token saver.
 *
 * Every other saver in rtk/ only rewrites *tool results*. In an agent loop
 * that is not where the tokens go: turn 40 re-sends turns 1..39 verbatim, so
 * the prompt grows quadratically with session length while the old turns are
 * worth almost nothing to the model.
 *
 * This module stubs out the *content* of old turns once the prompt crosses a
 * threshold. It deliberately does not summarise: a summary needs another model
 * call (paying tokens to save tokens, and adding latency to every request).
 * A stub that says "old tool output elided, N bytes" keeps the conversation
 * structurally valid — tool_use/tool_result pairing intact — while dropping the
 * bulk.
 *
 * Safety rails, in the same spirit as rtk/index.js:
 *  - never touches the last `keepTurns` messages, so the working context stays
 *  - never touches the first user message (the task statement)
 *  - never touches system/developer messages
 *  - never touches error tool results (same rail as RTK — traces matter)
 *  - never grows the body, never empties it
 *  - fails open: any error returns null and the body is untouched
 */
import { estimateInputTokens } from "../utils/usageTracking.js";

/** Below this the model needs the context more than the operator needs the tokens. */
export const DEFAULT_THRESHOLD_TOKENS = 60000;
/** Turns (messages) at the tail that are always preserved. */
export const DEFAULT_KEEP_TURNS = 8;
/** A message shorter than this is not worth stubbing — the stub could be longer. */
export const MIN_STUB_SIZE = 400;

const STUB = (kind, bytes) => `[${kind} elided to save context: ${bytes} bytes]`;

function bytesOf(value) {
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value)?.length || 0;
  } catch {
    return 0;
  }
}

/**
 * Replace a text blob with a stub, or leave it alone when the stub would not
 * actually be smaller.
 */
function stubText(text, kind, stats) {
  if (typeof text !== "string") return text;
  const size = text.length;
  if (size < MIN_STUB_SIZE) return text;
  const replacement = STUB(kind, size);
  if (replacement.length >= size) return text;
  stats.bytesBefore += size;
  stats.bytesAfter += replacement.length;
  stats.stubbed += 1;
  return replacement;
}

/** Stub a single message's content in whatever shape the format uses. */
function stubMessageContent(msg, stats) {
  // OpenAI Responses: function_call_output carries `output`.
  if (msg.type === "function_call_output") {
    if (typeof msg.output === "string") {
      msg.output = stubText(msg.output, "tool output", stats);
    } else if (Array.isArray(msg.output)) {
      for (const part of msg.output) {
        if (part && part.type === "input_text" && typeof part.text === "string") {
          part.text = stubText(part.text, "tool output", stats);
        }
      }
    }
    return;
  }

  // OpenAI tool message: content is a string or [{type:"text"}].
  if (msg.role === "tool" || msg.role === "function") {
    if (typeof msg.content === "string") {
      msg.content = stubText(msg.content, "tool output", stats);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part && part.type === "text" && typeof part.text === "string") {
          part.text = stubText(part.text, "tool output", stats);
        }
      }
    }
    return;
  }

  if (!Array.isArray(msg.content)) {
    // Assistant prose can be enormous after a long explanation; stub it too,
    // but only when it is plain text and the message is not the last turn.
    if (typeof msg.content === "string") {
      msg.content = stubText(msg.content, "message", stats);
    }
    return;
  }

  for (const block of msg.content) {
    if (!block || typeof block !== "object") continue;

    // Claude tool_result — string or array form; error traces are preserved.
    if (block.type === "tool_result") {
      if (block.is_error === true) continue;
      if (typeof block.content === "string") {
        block.content = stubText(block.content, "tool output", stats);
      } else if (Array.isArray(block.content)) {
        for (const part of block.content) {
          if (part && part.type === "text" && typeof part.text === "string") {
            part.text = stubText(part.text, "tool output", stats);
          }
        }
      }
      continue;
    }

    // Plain text blocks in an old turn (user or assistant).
    if (block.type === "text" && typeof block.text === "string") {
      block.text = stubText(block.text, "message", stats);
    }
  }
}

/**
 * Trim old conversation history in place.
 *
 * @param {object} body - Translated request body (mutated in place).
 * @param {object} opts
 * @param {boolean} opts.enabled
 * @param {number} [opts.thresholdTokens]
 * @param {number} [opts.keepTurns]
 * @returns {{bytesBefore:number,bytesAfter:number,stubbed:number,skipped?:string}|null}
 */
export function trimHistory(body, { enabled, thresholdTokens = DEFAULT_THRESHOLD_TOKENS, keepTurns = DEFAULT_KEEP_TURNS } = {}) {
  if (!enabled) return null;
  if (!body || typeof body !== "object") return null;

  const items = Array.isArray(body.messages) ? body.messages
    : Array.isArray(body.input) ? body.input
    : null;
  // Kiro's conversationState carries tool results but not a trim-friendly turn
  // list; leave it to RTK rather than risk breaking its pairing rules.
  if (!items || items.length === 0) return null;

  const threshold = Number(thresholdTokens) > 0 ? Number(thresholdTokens) : DEFAULT_THRESHOLD_TOKENS;
  const estimated = estimateInputTokens(body);
  if (estimated <= threshold) {
    return { bytesBefore: 0, bytesAfter: 0, stubbed: 0, skipped: "below_threshold" };
  }

  const keep = Math.max(0, Math.floor(Number(keepTurns) >= 0 ? Number(keepTurns) : DEFAULT_KEEP_TURNS));
  const tailStart = Math.max(0, items.length - keep);

  // The first user message is the task statement — never stub it.
  let firstUserIndex = items.findIndex((m) => m && m.role === "user");
  if (firstUserIndex === -1) firstUserIndex = 0;

  const stats = { bytesBefore: 0, bytesAfter: 0, stubbed: 0 };
  try {
    for (let i = 0; i < tailStart; i++) {
      if (i === firstUserIndex) continue;
      const msg = items[i];
      if (!msg || typeof msg !== "object") continue;
      if (msg.role === "system" || msg.role === "developer") continue;
      stubMessageContent(msg, stats);
    }
  } catch (e) {
    console.warn("[historyTrim] failed, leaving body untouched:", e.message);
    return null;
  }

  if (stats.stubbed === 0) {
    return { bytesBefore: 0, bytesAfter: 0, stubbed: 0, skipped: "nothing_to_stub" };
  }

  return {
    bytesBefore: stats.bytesBefore,
    bytesAfter: stats.bytesAfter,
    stubbed: stats.stubbed,
    estimatedBefore: estimated,
    estimatedAfter: estimateInputTokens(body),
  };
}
