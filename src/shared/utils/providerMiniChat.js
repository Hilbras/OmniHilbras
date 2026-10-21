/**
 * Pure helpers for the provider mini chat panel.
 *
 * The frame parser lives here rather than inside the component so it can be
 * unit tested: the dashboard's test runner transforms plain `.js` files with
 * esbuild's JS loader, which cannot parse JSX.
 */

const DONE_MARKER = "[DONE]";

function asText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(asText).join("");
  return "";
}

/**
 * The provider's own words, when the frame carries a refusal instead of an
 * answer. A provider that refuses usually answers HTTP 200 and puts the
 * refusal in the body, so the body has to be read for it.
 */
function extractFrameError(parsed) {
  const error = parsed.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object") {
    const message = error.message || error.msg || error.error;
    if (typeof message === "string" && message.trim()) return message.trim();
  }

  // Envelopes like { status: 429, msg: "rate limited" } — a status other than
  // 200 means the provider is reporting a failure.
  const status = parsed.status;
  if (status !== undefined && status !== null) {
    const code = String(status);
    if (code !== "200" && code !== "0") {
      const message = parsed.msg || parsed.message;
      if (typeof message === "string" && message.trim()) return message.trim();
    }
  }

  return "";
}

/**
 * Parse one SSE `data:` payload.
 *
 * @param {string} frame the raw payload of a `data:` line (no `data:` prefix)
 * @returns {{ text: string, error: string, done: boolean }} the streamed text
 *   piece, the provider's refusal (if the frame carries one), and whether the
 *   frame closed the stream.
 */
export function extractDelta(frame) {
  const payload = typeof frame === "string" ? frame.trim() : "";
  if (!payload) return { text: "", error: "", done: false };
  if (payload === DONE_MARKER) return { text: "", error: "", done: true };

  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    // A malformed frame is not worth breaking the stream over.
    return { text: "", error: "", done: false };
  }
  if (!parsed || typeof parsed !== "object") return { text: "", error: "", done: false };

  const error = extractFrameError(parsed);
  if (error) return { text: "", error, done: false };

  const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : null;
  const delta = choice?.delta || {};
  const text = asText(delta.content) || asText(choice?.message?.content);
  return { text, error: "", done: false };
}

/**
 * The history that may be replayed to the model.
 *
 * A turn that failed carries the provider's own words. That text is the
 * provider's report about the failure, not something the model said, so it
 * never goes back to the model. The user's own message stays in: the model
 * never answered it, and dropping it would lose the question.
 *
 * @param {Array<{ role?: string, content?: string, status?: string }>} messages
 * @returns {Array<{ role: string, content: string }>}
 */
export function buildReplayHistory(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((message) => message && message.status !== "error")
    .filter((message) => (message.role === "user" || message.role === "assistant")
      && typeof message.content === "string" && message.content.length > 0)
    .map((message) => ({ role: message.role, content: message.content }));
}
