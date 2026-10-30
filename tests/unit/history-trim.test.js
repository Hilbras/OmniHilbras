import { describe, it, expect } from "vitest";
import { trimHistory, DEFAULT_THRESHOLD_TOKENS, DEFAULT_KEEP_TURNS, MIN_STUB_SIZE } from "../../open-sse/rtk/historyTrim.js";

const big = (n = 3000) => "x".repeat(n);

function conversation(turns = 12, size = 3000) {
  const messages = [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "Fix the failing test." },
  ];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: "assistant", content: `step ${i}`, tool_calls: [{ id: `t${i}` }] });
    messages.push({ role: "tool", content: big(size) });
  }
  return { messages };
}

describe("history trimming", () => {
  it("does nothing when disabled", () => {
    const body = conversation();
    expect(trimHistory(body, { enabled: false })).toBeNull();
    expect(body.messages[3].content.length).toBe(3000); // first tool result
  });

  it("does nothing below the threshold", () => {
    const body = conversation(2);
    const stats = trimHistory(body, { enabled: true, thresholdTokens: 10_000_000 });
    expect(stats.skipped).toBe("below_threshold");
    expect(stats.stubbed).toBe(0);
  });

  it("stubs old tool output once the prompt crosses the threshold", () => {
    const body = conversation();
    const before = JSON.stringify(body).length;
    const stats = trimHistory(body, { enabled: true, thresholdTokens: 1000, keepTurns: 4 });

    expect(stats.stubbed).toBeGreaterThan(0);
    expect(stats.bytesBefore).toBeGreaterThan(0);
    expect(stats.bytesAfter).toBeLessThan(stats.bytesBefore);
    expect(JSON.stringify(body).length).toBeLessThan(before);
  });

  it("keeps the last N turns intact", () => {
    const body = conversation();
    const keep = 4;
    trimHistory(body, { enabled: true, thresholdTokens: 1000, keepTurns: keep });

    // The tail is untouched: the working context must stay readable.
    const tail = body.messages.slice(-keep);
    for (const msg of tail) {
      if (msg.role === "tool") expect(msg.content.length).toBe(3000);
    }
  });

  it("never touches the system prompt or the first user message", () => {
    const body = conversation();
    trimHistory(body, { enabled: true, thresholdTokens: 1000, keepTurns: 2 });
    expect(body.messages[0].content).toBe("You are a coding agent.");
    expect(body.messages[1].content).toBe("Fix the failing test.");
  });

  it("preserves error tool results", () => {
    const body = {
      messages: [
        { role: "user", content: "task" },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "a", content: big(), is_error: false },
            { type: "tool_result", tool_use_id: "b", content: big(), is_error: true },
          ],
        },
        { role: "assistant", content: "done" },
      ],
    };
    trimHistory(body, { enabled: true, thresholdTokens: 100, keepTurns: 1 });

    const blocks = body.messages[1].content;
    expect(blocks[0].content).toContain("elided");
    expect(blocks[1].content.length).toBe(3000); // error trace preserved
  });

  it("leaves small blobs alone — a stub would not be smaller", () => {
    const body = {
      messages: [
        { role: "user", content: "task" },
        { role: "tool", content: "tiny" },
        { role: "assistant", content: "ok" },
      ],
    };
    const stats = trimHistory(body, { enabled: true, thresholdTokens: 1, keepTurns: 1 });
    expect(stats.skipped).toBe("nothing_to_stub");
    expect(body.messages[1].content).toBe("tiny");
  });

  it("handles the OpenAI Responses function_call_output shape", () => {
    const body = {
      input: [
        { role: "user", content: "task" },
        { type: "function_call_output", call_id: "c1", output: big() },
        { role: "assistant", content: "ok" },
      ],
    };
    const stats = trimHistory(body, { enabled: true, thresholdTokens: 100, keepTurns: 1 });
    expect(stats.stubbed).toBe(1);
    expect(body.input[1].output).toContain("elided");
  });

  it("handles Claude array content and stubs text blocks", () => {
    const body = {
      messages: [
        { role: "user", content: [{ type: "text", text: "task" }] },
        { role: "assistant", content: [{ type: "text", text: big() }] },
        { role: "user", content: [{ type: "text", text: "now" }] },
      ],
    };
    const stats = trimHistory(body, { enabled: true, thresholdTokens: 100, keepTurns: 1 });
    expect(stats.stubbed).toBe(1);
    expect(body.messages[1].content[0].text).toContain("elided");
    // The first user message survives even though it is a text block.
    expect(body.messages[0].content[0].text).toBe("task");
  });

  it("reports the estimated token drop", () => {
    const body = conversation(10);
    const stats = trimHistory(body, { enabled: true, thresholdTokens: 1000, keepTurns: 2 });
    expect(stats.estimatedBefore).toBeGreaterThan(stats.estimatedAfter);
  });

  it("ignores bodies without a message list", () => {
    expect(trimHistory({}, { enabled: true })).toBeNull();
    expect(trimHistory(null, { enabled: true })).toBeNull();
    // Kiro's conversationState is left to RTK.
    expect(trimHistory({ conversationState: { history: [] } }, { enabled: true })).toBeNull();
  });

  it("exports sensible defaults", () => {
    expect(DEFAULT_THRESHOLD_TOKENS).toBe(60000);
    expect(DEFAULT_KEEP_TURNS).toBe(8);
    expect(MIN_STUB_SIZE).toBeGreaterThan(0);
  });
});
