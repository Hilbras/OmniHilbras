// ZCode Start Plan client-tool bridge.
//
// The upstream gateway validates the stock ZCode request body (system prompt +
// 34-tool catalog + tool_choice), so a client's own tool schemas cannot be
// sent as Anthropic `tools`. The bridge instead:
//
//   1. serializes the client schemas into the conversation as a text contract
//      (see config/zcodeToolBridge.js) — the request template itself is never
//      touched, so the "unusual activity" rejection stays out of reach;
//   2. replays earlier tool_use / tool_result turns as marked plain text,
//      because the stock catalog cannot resolve the client's tool ids;
//   3. reads the model's JSON answer back and converts it into real Anthropic
//      `tool_use` blocks, so the rest of the engine sees a normal tool call.
//
// Approach mirrors the validated ZCodeToAPI bridge, with two additions: the
// stock catalog's own tool_use blocks never leak to the client, and a native
// tool_use that names one of the client's tools is forwarded untouched.

import { randomUUID } from "node:crypto";
import { ROLE, CLAUDE_BLOCK } from "../../translator/schema/index.js";
import { TOOL_BRIDGE } from "../../config/zcodeToolBridge.js";

const TOOL_CALL_KEYS = ["tool_calls", "toolCalls"];
const TOOL_NAME_KEYS = ["name", "tool", "function"];
const TOOL_INPUT_KEYS = ["input", "arguments", "args", "parameters"];

// ── tool schema resolution ────────────────────────────────────────────────

/** Normalize a client tool definition (Claude or OpenAI shape) to one record. */
export function resolveTool(tool) {
  if (!tool || typeof tool !== "object") return null;
  const fn = tool.function && typeof tool.function === "object" ? tool.function : null;
  const source = fn || tool;
  const name = typeof source.name === "string" ? source.name.trim() : "";
  if (!name) return null;
  const schema = source.input_schema ?? source.parameters ?? {};
  return {
    name,
    description: typeof source.description === "string" ? source.description : "",
    input_schema: schema && typeof schema === "object" && !Array.isArray(schema) ? schema : {},
  };
}

function resolveToolList(tools) {
  return (Array.isArray(tools) ? tools : []).map(resolveTool).filter(Boolean);
}

/** Keep only the schema keys the model needs; nested properties stay intact. */
function reduceSchema(schema) {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
  const reduced = { type: typeof schema.type === "string" ? schema.type : "object" };
  if (schema.properties && typeof schema.properties === "object") reduced.properties = schema.properties;
  if (schema.required) reduced.required = schema.required;
  return reduced;
}

/** Serialize the client's tools into the text contract injected upstream. */
export function buildToolContract(tools) {
  const resolved = resolveToolList(tools);
  if (!resolved.length) return "";
  const lines = [TOOL_BRIDGE.contractOpen, ...TOOL_BRIDGE.instructionLines, ""];
  resolved.forEach((tool, index) => {
    lines.push(`${TOOL_BRIDGE.toolRecordLabel} ${index + 1}:`);
    lines.push(JSON.stringify({
      name: tool.name,
      description: tool.description,
      input_schema: reduceSchema(tool.input_schema),
    }, null, 2));
    lines.push("");
  });
  lines.push(TOOL_BRIDGE.contractClose);
  return lines.join("\n");
}

// ── request-side flattening ───────────────────────────────────────────────

function toolResultText(block) {
  const inner = contentToText(block?.content);
  return `${TOOL_BRIDGE.toolResultMarker} id=${block?.tool_use_id || ""}\n${inner}`;
}

function toolUseText(block) {
  const payload = { name: block?.name || "", input: block?.input ?? {} };
  return `${TOOL_BRIDGE.previousToolUseMarker}\n${JSON.stringify(payload)}`;
}

function blockToText(block) {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  if (block.type === CLAUDE_BLOCK.TEXT) return typeof block.text === "string" ? block.text : "";
  if (block.type === CLAUDE_BLOCK.TOOL_RESULT) return toolResultText(block);
  if (block.type === CLAUDE_BLOCK.TOOL_USE) return toolUseText(block);
  return "";
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(blockToText).filter(Boolean).join("\n");
  if (content && typeof content === "object") return blockToText(content);
  return "";
}

/**
 * Turn the client's Claude-shaped turns into the plain-text turns zcode can
 * read: tool_use / tool_result become marked text, client thinking blocks are
 * dropped (their signatures are foreign to zcode, which thinks on its own).
 */
export function flattenToolBlocks(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const out = [];
  for (const message of list) {
    if (!message || typeof message !== "object") continue;
    const role = message.role || ROLE.USER;
    if (typeof message.content === "string") {
      out.push({ role, content: message.content });
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    const blocks = [];
    for (const block of message.content) {
      const type = block?.type;
      if (type === CLAUDE_BLOCK.THINKING || type === CLAUDE_BLOCK.REDACTED_THINKING) continue;
      const text = blockToText(block);
      if (!text) continue;
      blocks.push({ type: CLAUDE_BLOCK.TEXT, text });
    }
    if (!blocks.length) continue;
    out.push({ role, content: blocks });
  }
  return out;
}

// ── response-side parsing ─────────────────────────────────────────────────

function stripFences(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

/** Scan a balanced JSON object starting at `start`, ignoring braces in strings. */
export function extractBalancedObject(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Parse the first JSON object in `text`, tolerating prose around it. */
export function extractJsonObject(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
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

function firstString(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeCall(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = firstString(raw, TOOL_NAME_KEYS);
  if (!name) return null;
  let input = null;
  for (const key of TOOL_INPUT_KEYS) {
    if (raw[key] !== undefined && raw[key] !== null) { input = raw[key]; break; }
  }
  if (input === null) input = {};
  if (typeof input === "string") {
    const trimmed = input.trim();
    let parsed = null;
    if (trimmed) {
      try { parsed = JSON.parse(trimmed); } catch { parsed = null; }
    }
    input = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : { input };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) input = { value: input };
  return { name, input };
}

/** Last-resort scan for a tool call in text that is not valid JSON. */
export function looseToolCalls(text) {
  if (typeof text !== "string" || !text) return [];
  const calls = [];
  const namePattern = /"name"\s*:\s*"([^"]+)"/g;
  let match;
  while ((match = namePattern.exec(text)) !== null) {
    const name = match[1].trim();
    if (!name) continue;
    let input = {};
    const tail = text.slice(match.index + match[0].length);
    const keyIndex = tail.search(/"(?:input|arguments|args)"\s*:/);
    if (keyIndex !== -1) {
      const braceIndex = tail.indexOf("{", keyIndex);
      if (braceIndex !== -1) {
        const raw = extractBalancedObject(tail, braceIndex);
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed;
          } catch { /* keep empty input */ }
        }
      }
    }
    calls.push({ name, input });
  }
  return calls;
}

/**
 * Read the model's answer: `{tool_calls:[…]}` / `{toolCalls:[…]}` / `{final:"…"}`.
 * Falls back to the loose scan, and finally to the raw text.
 */
export function parseToolBridge(text) {
  const raw = typeof text === "string" ? text : "";
  const stripped = stripFences(raw);
  const object = extractJsonObject(stripped);
  if (object) {
    for (const key of TOOL_CALL_KEYS) {
      const list = object[key];
      if (!Array.isArray(list)) continue;
      const calls = list.map(normalizeCall).filter(Boolean);
      if (calls.length) return { finalText: null, calls };
    }
    if (object.final !== undefined && object.final !== null) {
      return { finalText: typeof object.final === "string" ? object.final : String(object.final), calls: [] };
    }
    const single = normalizeCall(object);
    if (single) return { finalText: null, calls: [single] };
  }
  const loose = looseToolCalls(stripped);
  if (loose.length) return { finalText: null, calls: loose };
  return { finalText: raw, calls: [] };
}

/** Drop every call that does not name one of the client's own tools. */
export function normalizeToolCalls(calls, tools) {
  const allowed = new Set(resolveToolList(tools).map((tool) => tool.name));
  if (!allowed.size) return [];
  return (Array.isArray(calls) ? calls : []).filter((call) => call && allowed.has(call.name));
}

// ── response rewriting ────────────────────────────────────────────────────

const TERMINAL_STOP_REASONS = new Set(["max_tokens", "stop_sequence"]);

function newToolUseId() {
  return `${TOOL_BRIDGE.toolUseIdPrefix}${randomUUID().replace(/-/g, "")}`;
}

function findClientTool(tools, name) {
  if (typeof name !== "string" || !name) return null;
  return resolveToolList(tools).find((tool) => tool.name === name) || null;
}

/**
 * Convert an upstream Anthropic message into a client-facing one: stock
 * catalog tool_use blocks are removed, a bridge JSON answer becomes real
 * `tool_use` blocks, and everything else stays as plain text.
 */
export function rewriteAnthropicMessage(message, tools) {
  const source = message && typeof message === "object" ? message : {};
  const blocks = Array.isArray(source.content) ? source.content : [];
  const kept = [];
  const nativeCalls = [];
  let rawText = "";

  for (const block of blocks) {
    const type = block?.type;
    if (type === CLAUDE_BLOCK.TOOL_USE) {
      if (findClientTool(tools, block.name)) {
        kept.push(block);
        nativeCalls.push(block);
      }
      continue;
    }
    if (type === CLAUDE_BLOCK.TEXT) {
      rawText += typeof block.text === "string" ? block.text : "";
      continue;
    }
    if (type === CLAUDE_BLOCK.THINKING || type === CLAUDE_BLOCK.REDACTED_THINKING) {
      kept.push(block);
      continue;
    }
    if (type) kept.push(block);
  }

  const content = [...kept];
  let stopReason = source.stop_reason;

  if (nativeCalls.length) {
    if (rawText) content.push({ type: CLAUDE_BLOCK.TEXT, text: rawText });
    stopReason = TERMINAL_STOP_REASONS.has(stopReason) ? stopReason : "tool_use";
  } else {
    const parsed = parseToolBridge(rawText);
    const calls = normalizeToolCalls(parsed.calls, tools);
    if (calls.length) {
      for (const call of calls) {
        content.push({
          type: CLAUDE_BLOCK.TOOL_USE,
          id: newToolUseId(),
          name: call.name,
          input: call.input,
        });
      }
      stopReason = TERMINAL_STOP_REASONS.has(stopReason) ? stopReason : "tool_use";
    } else {
      content.push({ type: CLAUDE_BLOCK.TEXT, text: parsed.finalText ?? rawText });
      stopReason = TERMINAL_STOP_REASONS.has(stopReason) ? stopReason : "end_turn";
    }
  }

  return {
    ...source,
    id: source.id || `${TOOL_BRIDGE.messageIdPrefix}${randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: ROLE.ASSISTANT,
    content,
    stop_reason: stopReason,
  };
}

// ── streaming rewrite ─────────────────────────────────────────────────────

function parseAnthropicSse(sseText) {
  const lines = String(sseText || "").split(/\r?\n/);
  let start = null;
  let stopReason = null;
  let stopSequence = null;
  let usage = null;
  const blocks = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let event;
    try { event = JSON.parse(payload); } catch { continue; }
    if (!event || typeof event !== "object") continue;

    switch (event.type) {
      case "message_start": {
        start = event.message && typeof event.message === "object" ? { ...event.message } : {};
        usage = start.usage && typeof start.usage === "object" ? { ...start.usage } : null;
        break;
      }
      case "content_block_start": {
        const block = event.content_block && typeof event.content_block === "object" ? { ...event.content_block } : {};
        block.partial = "";
        blocks.push(block);
        break;
      }
      case "content_block_delta": {
        const block = blocks[event.index];
        if (!block) break;
        const delta = event.delta && typeof event.delta === "object" ? event.delta : {};
        if (delta.type === "text_delta") block.text = (block.text || "") + (delta.text || "");
        else if (delta.type === "thinking_delta") block.thinking = (block.thinking || "") + (delta.thinking || "");
        else if (delta.type === "signature_delta") block.signature = (block.signature || "") + (delta.signature || "");
        else if (delta.type === "input_json_delta") block.partial = (block.partial || "") + (delta.partial_json || "");
        break;
      }
      case "content_block_stop": {
        const block = blocks[event.index];
        if (!block) break;
        if (block.type === CLAUDE_BLOCK.TOOL_USE) {
          let input = {};
          const raw = block.partial || "";
          if (raw.trim()) {
            try {
              const parsed = JSON.parse(raw);
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed;
            } catch { /* keep empty input */ }
          }
          block.input = input;
        }
        break;
      }
      case "message_delta": {
        const delta = event.delta && typeof event.delta === "object" ? event.delta : {};
        if (delta.stop_reason) stopReason = delta.stop_reason;
        if (delta.stop_sequence !== undefined) stopSequence = delta.stop_sequence;
        if (event.usage && typeof event.usage === "object") usage = { ...(usage || {}), ...event.usage };
        break;
      }
      default:
        break;
    }
  }

  for (const block of blocks) delete block.partial;

  return {
    id: start?.id || `${TOOL_BRIDGE.messageIdPrefix}${randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: ROLE.ASSISTANT,
    model: start?.model || "",
    content: blocks.filter((block) => block?.type),
    stop_reason: stopReason,
    stop_sequence: stopSequence,
    usage: usage || undefined,
  };
}

function sseFrame(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

function emitAnthropicSse(message) {
  const usage = message.usage && typeof message.usage === "object" ? message.usage : {};
  let out = sseFrame("message_start", {
    message: {
      id: message.id,
      type: "message",
      role: ROLE.ASSISTANT,
      model: message.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: usage.input_tokens || 0, output_tokens: 0 },
    },
  });

  let index = 0;
  for (const block of message.content) {
    if (block.type === CLAUDE_BLOCK.TEXT) {
      out += sseFrame("content_block_start", { index, content_block: { type: CLAUDE_BLOCK.TEXT, text: "" } });
      out += sseFrame("content_block_delta", { index, delta: { type: "text_delta", text: block.text || "" } });
      out += sseFrame("content_block_stop", { index });
    } else if (block.type === CLAUDE_BLOCK.THINKING) {
      out += sseFrame("content_block_start", { index, content_block: { type: CLAUDE_BLOCK.THINKING, thinking: "", signature: "" } });
      if (block.thinking) out += sseFrame("content_block_delta", { index, delta: { type: "thinking_delta", thinking: block.thinking } });
      if (block.signature) out += sseFrame("content_block_delta", { index, delta: { type: "signature_delta", signature: block.signature } });
      out += sseFrame("content_block_stop", { index });
    } else if (block.type === CLAUDE_BLOCK.REDACTED_THINKING) {
      out += sseFrame("content_block_start", { index, content_block: { type: CLAUDE_BLOCK.REDACTED_THINKING, data: block.data || "" } });
      out += sseFrame("content_block_stop", { index });
    } else if (block.type === CLAUDE_BLOCK.TOOL_USE) {
      out += sseFrame("content_block_start", {
        index,
        content_block: { type: CLAUDE_BLOCK.TOOL_USE, id: block.id, name: block.name, input: {} },
      });
      out += sseFrame("content_block_delta", {
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input || {}) },
      });
      out += sseFrame("content_block_stop", { index });
    } else {
      continue;
    }
    index++;
  }

  out += sseFrame("message_delta", {
    delta: { stop_reason: message.stop_reason || "end_turn", stop_sequence: message.stop_sequence ?? null },
    usage: { output_tokens: usage.output_tokens || 0 },
  });
  out += sseFrame("message_stop", {});
  return out;
}

/**
 * Rewrite an upstream Anthropic SSE stream into a client-facing one. The
 * stream is buffered so the turn can be classified as text or tool call before
 * anything is emitted — the text cannot be judged mid-flight.
 */
export function rewriteAnthropicStream(sseText, tools) {
  const message = parseAnthropicSse(sseText);
  const rewritten = rewriteAnthropicMessage(message, tools);
  return emitAnthropicSse(rewritten);
}
