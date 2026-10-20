import { OPENAI_BLOCK } from "../schema/index.js";

// Collapse an OpenAI content-part array into what a plain-string `content`
// field would carry.
//
// A content array is only kept as an array when it holds something a plain
// string cannot express — an image, a file, a tool block. When every part is
// text, the parts are joined with "\n" (the same separator Anthropic uses
// between text blocks) and returned as a string.
//
// This matters for strict OpenAI-compatible endpoints (Ollama, gpt-oss,
// vLLM): they reject an array content for a text-only message, and the
// previous "single text part only" rule left multi-part text messages as an
// array — which those endpoints then rejected.
export function collapseTextParts(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return parts;
  if (parts.every(isPlainTextPart)) {
    return parts.map((p) => p.text ?? "").join("\n");
  }
  return parts;
}

// A block can be flattened into a plain string only when it carries nothing
// that needs the block shape: `cache_control` (prompt caching) lives on the
// block, so an array holding it has to stay an array.
export function isPlainTextPart(part) {
  return part?.type === OPENAI_BLOCK.TEXT && part.cache_control === undefined;
}
