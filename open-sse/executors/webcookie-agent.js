// Web-Cookie Agent executor — drives an agent tool loop over the web-cookie
// provider groups, so a free browser-session model can use OmniHilbras's own
// tools (web search / fetch / image / tts / stt / embeddings / video) and
// keep going until it answers in prose.
//
// It is a *router*: it has no upstream of its own. Each round it asks a
// web-cookie chat model for a turn, executes any tool calls the model
// requested locally, appends the results, and repeats. The tool executions
// go through the gateway's own /api/v1/… endpoints with the operator's
// credentials, so access control, rate limits and provider selection are
// exactly what the operator configured — nothing new is invented.
//
// Target syntax (the part after "webcookie-agent/"):
//   - "" or "any"          → round-robin across the *active* web-cookie
//                            members (the ones that have a stored session).
//   - "<provider>"         → that member's default model.
//   - "<provider>/<model>" → that exact model.
//
// The app layer picks the concrete member (it knows which providers have
// sessions) and hands the executor that provider's credentials, so the
// executor stays pure engine code: given provider + credentials + target,
// run the loop.

import { BaseExecutor } from "./base.js";
import { sseChunk } from "../utils/sse.js";
import { SSE_DONE } from "../utils/sseConstants.js";
import { AGENT_TOOLS } from "../services/agent/agentTools.js";
import { runAgentLoop } from "../services/agent/agentLoop.js";

// The router has no transport of its own; the constructor arg stays null so
// BaseExecutor keeps its shape while only the provider id is meaningful.

// One agent chat turn may be slow (a Playwright-driven provider is minutes
// scale); the loop has its own round cap, so this bounds a single turn.
const AGENT_TURN_TIMEOUT_MS = 120_000;

/**
 * Split the target into { provider, modelId }. `any`/blank means the caller
 * already picked a member; the executor uses the credential it was given.
 */
export function parseAgentTarget(model) {
  const raw = String(model || "").trim();
  // Strip the agent's own prefix ("webcookie-agent/" or "wca/") so the
  // remainder is the target: "" | "any" | "<provider>" | "<provider>/<model>".
  const rest = raw.startsWith("webcookie-agent/")
    ? raw.slice("webcookie-agent/".length)
    : raw.startsWith("wca/")
      ? raw.slice("wca/".length)
      : raw;
  if (!rest || rest === "any") return { provider: null, modelId: null };
  const [provider, ...rest2] = rest.split("/");
  return { provider, modelId: rest2.join("/") || null };
}

/**
 * Run one chat turn against a specific web-cookie provider/model, with the
 * agent's tool catalogue attached. Returns a normalized OpenAI message.
 * This is the callback the agent loop hands off — it is what makes the loop
 * *agent* rather than a plain proxy: every round re-enters the engine with
 * the accumulated tool results.
 */
async function chatTurnForProvider({ provider, modelId, messages, credentials, log }) {
  // Re-resolve the executor for the concrete provider (not the agent router).
  // Lazy import: executors/index.js instantiates this class, so a top-level
  // import here would form a load-time cycle and leave getExecutor undefined.
  const { getExecutor } = await import("./index.js");
  const executor = getExecutor(provider);

  const result = await executor.execute({
    model: modelId,
    body: { messages, model: modelId, tools: AGENT_TOOLS, stream: false },
    stream: false, // the loop needs the full message to read tool_calls
    credentials,
    signal: AbortSignal.timeout(AGENT_TURN_TIMEOUT_MS),
    log,
    proxyOptions: null,
  });

  // Read the (non-streaming) OpenAI-shaped answer. The executors all answer
  // in OpenAI shape; the translator turns that into whatever the client speaks.
  const text = await result.response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  const choice = parsed?.choices?.[0] || {};
  return {
    message: {
      role: "assistant",
      content: typeof choice.message?.content === "string" ? choice.message.content : null,
      tool_calls: Array.isArray(choice.message?.tool_calls) ? choice.message.tool_calls : undefined,
    },
    finish_reason: choice.finish_reason || "stop",
  };
}

export class WebCookieAgentExecutor extends BaseExecutor {
  constructor() {
    // No transport of its own: the router has no upstream, so the config arg
    // stays null. getProvider()/noAuth are the only fields the engine reads.
    super("webcookie-agent", null);
  }

  buildUrl() {
    // The router has no upstream; the request log shows the group label.
    return "webcookie-agent";
  }

  buildHeaders() {
    return { "Content-Type": "application/json" };
  }

  /**
   * @param {object} opts
   * @param {string} opts.model      target: "any", "<provider>", or
   *                                 "<provider>/<model>"
   * @param {object} opts.body       the client's OpenAI chat body
   * @param {boolean} [opts.stream]  stream the final answer back as SSE
   * @param {object} opts.credentials  app-layer credential for the chosen
   *   member provider (or null when no session is connected)
   * @param {string} [opts.memberProvider] the concrete web-cookie provider
   *   the app layer picked; when omitted it is read from the target.
   * @param {object} [opts.signal]   the client's abort
   * @param {object} [opts.log]
   */
  async execute({ model, body, stream, credentials, signal, log, memberProvider }) {
    const target = parseAgentTarget(model);
    const provider = memberProvider || target.provider;
    // Lazy import: provider table resolves via the built providers module,
    // which the executor index also loads — keep it out of load-time cycles.
    const { PROVIDER_MODELS } = await import("../providers/index.js");
    const modelId = target.modelId || (PROVIDER_MODELS[provider]?.[0]?.id) || "any";

    const convo = Array.isArray(body?.messages) ? body.messages : [];

    // The chatTurn the loop hands off. When the app layer has no credentials
    // for this member, the round answers with a friendly prose note instead
    // of 5xx-ing — the whole request still succeeds.
    const chatTurn = async (messages) => {
      if (!credentials) {
        return {
          message: {
            role: "assistant",
            content:
              `No active session is connected for ${provider}. Add a ${provider} ` +
              "connection in the dashboard (a signed-in browser session), then retry.",
            tool_calls: undefined,
          },
          finish_reason: "stop",
        };
      }
      try {
        return await chatTurnForProvider({
          provider,
          modelId,
          messages,
          credentials,
          log,
        });
      } catch (error) {
        // A turn failure is data for the model, not fatal to the request.
        log?.warn?.("WEBCOOKIE-AGENT", `${provider} turn failed: ${error?.message || error}`);
        return {
          message: {
            role: "assistant",
            content: `[${provider} unavailable] ${String(error?.message || error).slice(0, 200)}`,
            tool_calls: undefined,
          },
          finish_reason: "stop",
        };
      }
    };

    const agentResult = await runAgentLoop({ messages: convo, chatTurn, log, ctx: { log } });

    const content = agentResult.answer || "";
    const cid = `chatcmpl-wca-${crypto.randomUUID().slice(0, 12)}`;
    const created = Math.floor(Date.now() / 1000);
    const finishReason = agentResult.finished === "cap" ? "length" : "stop";

    // Collect the actual tool-call objects from the conversation so the UI
    // can render what the agent did (name, args, result snippets).
    const agentToolCalls = [];
    for (const msg of agentResult.messages || []) {
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          agentToolCalls.push({
            id: tc.id || `call_${agentToolCalls.length + 1}`,
            type: "function",
            function: {
              name: tc.function?.name || tc.name || "tool",
              arguments: typeof tc.function?.arguments === "string"
                ? tc.function.arguments
                : JSON.stringify(tc.function?.arguments || {}),
            },
          });
        }
      }
    }

    const finalMessage = {
      role: "assistant",
      content,
      ...(agentToolCalls.length > 0 ? { tool_calls: agentToolCalls } : {}),
    };

    const baseModel = model || "webcookie-agent";

    if (stream) {
      const encoder = new TextEncoder();
      const sseStream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseChunk({
            id: cid, object: "chat.completion.chunk", created, model: baseModel,
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null, logprobs: null }],
          })));

          // Emit the final content + tool_calls in one chunk. The agent loop
          // runs to completion before streaming starts, so all tool calls are
          // known at this point.
          const delta = { content };
          if (finalMessage.tool_calls?.length) {
            delta.tool_calls = finalMessage.tool_calls.map((tc, i) => ({
              index: i,
              id: tc.id,
              type: tc.type,
              function: tc.function,
            }));
          }
          controller.enqueue(encoder.encode(sseChunk({
            id: cid, object: "chat.completion.chunk", created, model: baseModel,
            choices: [{ index: 0, delta, finish_reason: null, logprobs: null }],
          })));

          controller.enqueue(encoder.encode(sseChunk({
            id: cid, object: "chat.completion.chunk", created, model: baseModel,
            choices: [{ index: 0, delta: {}, finish_reason: finishReason, logprobs: null }],
          })));
          controller.enqueue(encoder.encode(SSE_DONE));
          controller.close();
        },
      });
      return {
        response: new Response(sseStream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
        url: this.buildUrl(),
        headers: this.buildHeaders(),
        transformedBody: body,
        responseFormat: "openai",
      };
    }

    return {
      response: new Response(
        JSON.stringify({
          id: cid,
          object: "chat.completion",
          created,
          model: baseModel,
          choices: [{ index: 0, message: finalMessage, finish_reason: finishReason, logprobs: null }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
      url: this.buildUrl(),
      headers: this.buildHeaders(),
      transformedBody: body,
      responseFormat: "openai",
    };
  }

  errorResult(status, message, type, code) {
    return {
      response: new Response(JSON.stringify({ error: { message, type, code } }), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
      url: this.buildUrl(),
      headers: this.buildHeaders(),
    };
  }
}

export default WebCookieAgentExecutor;
