// Web-Cookie Agent — unit tests for the tool loop, the target parser, and
// the tool-result shaping. The loop is exercised with an injected stub tool
// executor and a scripted chatTurn, so no network or bare-import chain is
// touched.
import { describe, expect, it, vi } from "vitest";
import { runAgentLoop, parseToolArgs } from "open-sse/services/agent/agentLoop.js";
import { parseAgentTarget } from "open-sse/executors/webcookie-agent.js";
import { AGENT_TOOLS, AGENT_TOOL_NAMES, AGENT_MAX_TOOL_ROUNDS } from "open-sse/services/agent/agentTools.js";

describe("webcookie-agent tool catalogue", () => {
  it("advertises a fixed set of built-in capabilities as OpenAI functions", () => {
    expect(AGENT_TOOL_NAMES).toEqual(
      expect.arrayContaining([
        "web_search", "web_fetch", "image_gen", "tts", "stt", "embeddings", "video_gen",
      ]),
    );
    for (const tool of AGENT_TOOLS) {
      expect(tool.type).toBe("function");
      expect(typeof tool.function.name).toBe("string");
      expect(tool.function.name).toBe(tool.name?.name || tool.function.name);
      expect(tool.function.parameters?.type).toBe("object");
    }
  });
});

describe("webcookie-agent target parsing", () => {
  it("treats blank and 'any' as unpinned", () => {
    expect(parseAgentTarget("")).toEqual({ provider: null, modelId: null });
    expect(parseAgentTarget("any")).toEqual({ provider: null, modelId: null });
  });
  it("splits pinned provider and model", () => {
    expect(parseAgentTarget("chatgpt-web")).toEqual({ provider: "chatgpt-web", modelId: null });
    expect(parseAgentTarget("chatgpt-web/gpt-5.6-luna")).toEqual({ provider: "chatgpt-web", modelId: "gpt-5.6-luna" });
  });
  it("strips the agent's own prefix before reading the target", () => {
    expect(parseAgentTarget("webcookie-agent/chatgpt-web")).toEqual({ provider: "chatgpt-web", modelId: null });
    expect(parseAgentTarget("wca/chatgpt-web/gpt-5.6-luna")).toEqual({ provider: "chatgpt-web", modelId: "gpt-5.6-luna" });
    expect(parseAgentTarget("webcookie-agent/any")).toEqual({ provider: null, modelId: null });
  });
});

describe("webcookie-agent parseToolArgs", () => {
  it("parses a JSON string, passes through an object, and isolates garbage", () => {
    expect(parseToolArgs('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolArgs({ a: 2 })).toEqual({ a: 2 });
    expect(parseToolArgs("not json")).toEqual({ value: "not json" });
    expect(parseToolArgs(null)).toEqual({});
  });
});

describe("webcookie-agent loop", () => {
  it("stops immediately when the model answers in prose", async () => {
    let calls = 0;
    const result = await runAgentLoop({
      messages: [{ role: "user", content: "hi" }],
      chatTurn: async () => {
        calls += 1;
        return { message: { content: "the final answer", tool_calls: undefined } };
      },
    });
    expect(calls).toBe(1);
    expect(result.finished).toBe("answer");
    expect(result.rounds).toBe(0);
    expect(result.toolCalls).toBe(0);
    expect(result.answer).toBe("the final answer");
  });

  it("executes requested tools, feeds results back, then answers", async () => {
    const script = [
      { message: { content: null, tool_calls: [{ id: "c1", function: { name: "web_search", arguments: '{"query":"a"}' } }] } },
      { message: { content: "done with tool", tool_calls: undefined } },
    ];
    let i = 0;
    const toolLog = [];
    const result = await runAgentLoop({
      messages: [{ role: "user", content: "q" }],
      chatTurn: async () => script[i++],
      executeTool: async (name, args) => {
        toolLog.push([name, args]);
        return { ok: true, result: `RESULT-${name}` };
      },
    });
    expect(result.finished).toBe("answer");
    expect(result.rounds).toBe(1);
    expect(result.toolCalls).toBe(1);
    expect(toolLog).toEqual([["web_search", { query: "a" }]]);
    // One round: the model's tool-calling turn plus its results are recorded
    // (system, user, assistant, tool), then the final prose turn is returned
    // as `answer` rather than appended, so `messages` holds the history.
    expect(result.messages.map((m) => m.role)).toEqual([
      "system", "user", "assistant", "tool",
    ]);
    expect(result.messages[3].content).toBe("RESULT-web_search");
  });

  it("respects the round cap when the model keeps calling tools", async () => {
    const result = await runAgentLoop({
      messages: [{ role: "user", content: "q" }],
      chatTurn: async () => ({
        message: {
          content: null,
          tool_calls: [{ id: "x", function: { name: "embeddings", arguments: '{"input":"hi"}' } }],
        },
      }),
      executeTool: async () => ({ ok: true, result: "ok" }),
    });
    expect(result.finished).toBe("cap");
    expect(result.rounds).toBe(AGENT_MAX_TOOL_ROUNDS);
    expect(result.toolCalls).toBe(AGENT_MAX_TOOL_ROUNDS);
  });

  it("feeds a tool error back as an explanatory tool result", async () => {
    const script = [
      { message: { content: null, tool_calls: [{ id: "c1", function: { name: "web_fetch", arguments: '{"url":"http://x"}' } }] } },
      { message: { content: "I will answer without the page.", tool_calls: undefined } },
    ];
    let i = 0;
    const result = await runAgentLoop({
      messages: [{ role: "user", content: "q" }],
      chatTurn: async () => script[i++],
      executeTool: async () => ({ ok: false, result: "[tool error] 404 not found", error: "404" }),
    });
    expect(result.finished).toBe("answer");
    expect(result.messages[3].content).toBe("[tool error] 404 not found");
  });

  it("prefixes the agent system instruction once, before the user context", async () => {
    let seen = null;
    await runAgentLoop({
      messages: [{ role: "user", content: "hi" }],
      chatTurn: async (messages) => {
        seen = messages;
        return { message: { content: "ok" } };
      },
    });
    expect(seen[0].role).toBe("system");
    expect(seen[0].content).toContain("autonomous agent");
    expect(seen[1]).toEqual({ role: "user", content: "hi" });
  });
});

describe("webcookie-agent executor registration", () => {
  it("registers a dedicated executor; wca falls back to the shared default cache", async () => {
    const { getExecutor, hasSpecializedExecutor } = await import("open-sse/executors/index.js");
    // "webcookie-agent" (the provider id) has a specialized executor. The
    // "wca" alias is not in the specialized map, so getExecutor returns a
    // DefaultExecutor for it — a distinct instance.
    expect(hasSpecializedExecutor("webcookie-agent")).toBe(true);
    expect(getExecutor("webcookie-agent").getProvider()).toBe("webcookie-agent");
    expect(getExecutor("webcookie-agent")).not.toBe(getExecutor("wca"));
    // Repeated lookups of the id return the same specialized instance.
    expect(getExecutor("webcookie-agent")).toBe(getExecutor("webcookie-agent"));
  });

  it("answers a request with no connected session as a prose note, not a 5xx", async () => {
    const { getExecutor } = await import("open-sse/executors/index.js");
    const executor = getExecutor("webcookie-agent");
    // No member provider is picked in the unit context, so the loop sees no
    // credentials and returns a friendly note.
    const result = await executor.execute({
      model: "chatgpt-web",
      body: { messages: [{ role: "user", content: "hi" }], stream: false },
      stream: false,
      credentials: null,
      memberProvider: "chatgpt-web",
      log: { warn: vi.fn() },
    });
    expect(result.response.status).toBe(200);
    const json = await result.response.json();
    expect(json.choices[0].message.content).toContain("No active session is connected");
  });
});
