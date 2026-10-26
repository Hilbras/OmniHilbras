// ZCode upstream response envelope.
//
// The gateway reports business failures with a bare JSON envelope, and that
// envelope can ride on HTTP 200 — even inside an SSE response, where it
// arrives unframed ahead of the `data: [DONE]` marker:
//
//   {"code":1005,"msg":"exceed quota limit",…}
//
// Without this recognition an exhausted account looks like a successful but
// empty answer (no text, no tool_use), which is indistinguishable from a
// broken tool bridge. The envelope is parsed before the body reaches the
// client, so the turn fails with the real reason instead.

import { extractBalancedObject } from "./toolBridge.js";

/** Parse the first JSON object in `text`, tolerating trailing SSE markers. */
export function parseZcodeEnvelope(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch { /* not a bare JSON document */ }
  const start = trimmed.indexOf("{");
  if (start === -1) return null;
  const raw = extractBalancedObject(trimmed, start);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch { /* not JSON */ }
  return null;
}

/**
 * The business code of a failure envelope, or null when the body is a normal
 * answer. A plain Anthropic message carries no `code`, so a non-zero numeric
 * code together with its message text identifies a ZCode failure.
 */
export function zcodeBusinessCode(envelope) {
  if (!envelope || typeof envelope !== "object") return null;
  const raw = envelope.code;
  const code = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(code) || code === 0) return null;
  const message = envelope.msg ?? envelope.message;
  if (typeof message !== "string" || !message.trim()) return null;
  return code;
}
