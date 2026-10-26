// Web-Cookie Agent loop — the orchestrator.
//
// Drives one agent turn over a web-cookie chat model (any of the
// WEB_COOKIE_AGENT_PROVIDERS), executing the model's tool calls locally and
// feeding the results back, until the model answers in prose or the round
// cap is reached. The chat turn itself goes through the same executor
// pipeline a normal /api/v1/chat/completions request uses, so client-format
// translation, RTK compression and provider error handling all apply.
//
// The loop is *additive*: it runs the model's own tool calls (native
// tool_calls when the provider carries them, or text-bridged calls for the
// ones that don't — the web-cookie executors flatten tools into the prompt
// and read them back, so the bridge layer here is generic: any tool_call on
// the model's answer is executed and appended as a role:"tool" message).

import { AGENT_TOOLS, AGENT_MAX_TOOL_ROUNDS, AGENT_MAX_TOOL_CALLS_PER_TURN } from "./agentTools.js";
import { executeAgentTool } from "./runAgentTools.js";
// The instruction that tells the model it may call tools. Injected once at
// the top of the conversation, so the model knows the tool contract on every
// round without the caller repeating it.
const AGENT_SYSTEM = [
  "You are an autonomous agent. You can use the tools provided to answer the user.",
  "When a tool call is needed, call it; otherwise answer in plain text.",
  "Use tools to look things up (web_search, web_fetch), produce media (image_gen, tts, stt, video_gen), or compute embeddings.",
  "After each tool result, continue reasoning. Stop when the task is complete — do not loop on successful calls.",
].join("\n");

/**
 * Run one agent turn.
 *
 * @param {object} options
 * @param {object[]} options.messages   OpenAI message list (the conversation so far)
 * @param {Function} options.chatTurn   (messages) => Promise<{ message: {content?, tool_calls?}, finish_reason }>
 *                                      One model turn, already translated to
 *                                      OpenAI shape on the way out. The caller
 *                                      owns translation + provider selection;
 *                                      this loop only drives the tool cycle.
 * @param {object}  [options.log]
 * @param {string[]} [options.modelChain] - optional, informational; the loop
 *                                      does not pick models, the caller does.
 * @param {object}  [options.ctx]        forwarded to tool execution
 * @param {Function} [options.executeTool] - injectable tool executor (defaults
 *   to the real one). Tests pass a stub so the loop is exercised without
 *   network access.
 * @returns {Promise<{ messages, answer, toolCalls: number, rounds: number, finished: "answer"|"cap" }>}
 */
export async function runAgentLoop({ messages, chatTurn, log, ctx = {}, executeTool = executeAgentTool }) {
  const log_ = log || ctx.log;
  // The tool contract goes in front of the user's context, not after it —
  // the model must see it before the task.
  const convo = [
    { role: "system", content: AGENT_SYSTEM },
    ...messages,
  ];

  let rounds = 0;
  let totalToolCalls = 0;
  let lastMessage = null;

  for (;;) {
    if (rounds >= AGENT_MAX_TOOL_ROUNDS) {
      log_?.warn?.("AGENT-LOOP", `round cap (${AGENT_MAX_TOOL_ROUNDS}) reached with pending tools; returning last answer`);
      break;
    }

    const result = await chatTurn(convo);
    const message = result?.message || {};
    lastMessage = message;
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

    // No tools requested → this is the final prose answer.
    if (toolCalls.length === 0) {
      const answer = typeof message.content === "string"
        ? message.content
        : contentText(message.content);
      return {
        messages: convo,
        answer,
        toolCalls: totalToolCalls,
        rounds,
        finished: "answer",
      };
    }

    // Record the assistant's tool-calling turn verbatim.
    convo.push({
      role: "assistant",
      content: message.content || null,
      tool_calls: toolCalls.map((tc, i) => ({
        id: tc.id || `call_${i}_${totalToolCalls + i}`,
        type: "function",
        function: {
          name: tc.function?.name || tc.name || "tool",
          arguments: JSON.stringify(parseToolArgs(tc.function?.arguments)),
        },
      })),
    });

    // Execute each requested tool (bounded per round).
    const callsThisRound = toolCalls.slice(0, AGENT_MAX_TOOL_CALLS_PER_TURN);
    for (const tc of callsThisRound) {
      const name = tc.function?.name || tc.name || "tool";
      const args = parseToolArgs(tc.function?.arguments);
      log_?.info?.("AGENT-LOOP", `round ${rounds + 1}: ${name} ${JSON.stringify(args).slice(0, 120)}`);
      const { ok, result: toolResult, error } = await executeTool(name, args, { log: log_ });
      totalToolCalls += 1;
      const toolMessageId = tc.id || `call_${totalToolCalls}`;
      convo.push({
        role: "tool",
        tool_call_id: toolMessageId,
        content: ok ? toolResult : toolResult, // errors are already explanatory text
      });
      if (!ok) log_?.warn?.("AGENT-LOOP", `tool ${name} errored (${String(error).slice(0, 120)}); feeding back so the model can route around it`);
    }

    rounds += 1;
    // Any tool calls beyond the per-round cap are dropped for this round but
    // the model still saw the results of the ones that ran — it will re-plan.
  }

  // Cap reached (or a tool errored on the last round): return what we have.
  return {
    messages: convo,
    answer: typeof lastMessage?.content === "string" ? lastMessage.content : contentText(lastMessage?.content),
    toolCalls: totalToolCalls,
    rounds,
    finished: "cap",
  };
}

// OpenAI tool-call arguments arrive as a JSON string; some providers send an
// object. Normalise to an object the executor can read.
export function parseToolArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : { value: raw };
  } catch {
    return { value: raw };
  }
}

// Text out of an array-of-blocks content shape (claude-style) or a string.
function contentText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : b?.text || ""))
      .join("");
  }
  return String(content);
}

// parseToolArgs and runAgentLoop are named exports declared above; AGENT_TOOLS
// is re-exported here for convenience.
export { AGENT_TOOLS };
