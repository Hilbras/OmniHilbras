// End-to-end: a real chat request through handleChatCore records RTK savings
// into the usage row's meta blob, and the stats endpoint aggregates them.
//
// This is the wiring test the telemetry work exists for — unit tests prove the
// collector and the aggregation separately; this proves chatCore actually
// calls them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let handleChatCore;

const noopLog = {
  debug() {}, info() {}, warn() {}, error() {}, line() {}, errorLine() {},
};

// The executor is stubbed: this test is about what the savers record on the way
// to the upstream call, not about reaching a provider. A real fetch with a fake
// token would fail before any usage row is written, and usage is written on
// completion — so the request has to actually succeed to exercise the wiring.
//
// The mock answers with SSE, not JSON: codebuddy-intl declares forceStream, so
// a JSON body would be parsed by the streaming handler and yield no usage.
vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: async () => {
      const chunks = [
        { id: "chatcmpl-test", object: "chat.completion.chunk", model: "glm-5.2", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
        { id: "chatcmpl-test", object: "chat.completion.chunk", model: "glm-5.2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { id: "chatcmpl-test", object: "chat.completion.chunk", model: "glm-5.2", choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } },
      ];
      const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
      return {
        response: new Response(text, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
        url: "https://example.invalid/v2/chat/completions",
      };
    },
  }),
}));

// Big enough for RTK's git-log filter to match (> MIN_COMPRESS_SIZE).
const gitLog = Array.from({ length: 60 }, (_, i) =>
  `commit ${String(i).padStart(40, "a")}\nAuthor: Dev <dev@example.com>\nDate:   Mon Jan 1 00:00:00 2026 +0000\n\n    commit message number ${i}\n`,
).join("\n");

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omnihilbras-telemetry-e2e-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  // chatCore pulls the whole provider registry; importing it costs more than
  // the default hook budget on a loaded machine.
  ({ handleChatCore } = await import("open-sse/handlers/chatCore.js"));
}, 180000);

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function toolBody() {
  return {
    model: "codebuddy-intl/glm-5.2",
    stream: false,
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "what changed recently?" },
      { role: "assistant", content: "Let me check.", tool_calls: [{ id: "t1", type: "function", function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "t1", content: gitLog },
      { role: "user", content: "summarise" },
    ],
  };
}

async function run(overrides = {}) {
  const result = await handleChatCore({
    body: toolBody(),
    modelInfo: { provider: "codebuddy-intl", model: "glm-5.2" },
    // The upstream call is stubbed; the savers run on the way to it, which is
    // exactly what this test needs.
    credentials: { accessToken: "invalid-for-shape-test", apiKey: "invalid-for-shape-test" },
    log: noopLog,
    clientRawRequest: { headers: {}, endpoint: "/v1/chat/completions" },
    connectionId: "test-connection",
    rtkEnabled: true,
    headroomEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    pxpipeEnabled: false,
    historyTrimEnabled: false,
    maxOutputTokensCap: 0,
    thinkingBudgetCap: 0,
    ...overrides,
  });

  // The response is a live SSE stream: usage is recorded by the stream's
  // completion callback, so the body has to be drained before the numbers exist.
  if (result?.response?.body) {
    try {
      await result.response.text();
    } catch {
      // A partially-consumed stream still records what it saw.
    }
  }
  // Let the fire-and-forget saveUsageStats → buffer path settle.
  await new Promise((resolve) => setTimeout(resolve, 50));
  return result;
}

describe("saver telemetry through the chat path", () => {
  it("records RTK savings into the usage meta blob", async () => {
    await run();
    await db.flushUsage();

    const stats = await db.getTokenSaverStats("all");
    expect(stats.requestsWithTelemetry).toBeGreaterThanOrEqual(1);

    const rtk = stats.savers.find((s) => s.id === "rtk");
    expect(rtk, "RTK must appear in the stats after a request with a large tool result").toBeDefined();
    expect(rtk.bytesBefore).toBeGreaterThan(0);
    expect(rtk.bytesSaved).toBeGreaterThan(0);
    expect(stats.totalBytesSaved).toBeGreaterThan(0);
    expect(stats.byProvider.some((p) => p.provider === "codebuddy-intl")).toBe(true);
  });

  it("does not record anything when the client opts out", async () => {
    const before = await db.getTokenSaverStats("all");
    await run({ clientRawRequest: { headers: { "x-omnihilbras-token-saver": "off" }, endpoint: "/v1/chat/completions" } });
    await db.flushUsage();

    const after = await db.getTokenSaverStats("all");
    // The request is recorded (usage still counts) but no saver telemetry.
    expect(after.requests).toBeGreaterThan(before.requests);
    expect(after.requestsWithTelemetry).toBe(before.requestsWithTelemetry);
  });

  it("records history trimming when it is enabled and the prompt is over the threshold", async () => {
    const before = await db.getTokenSaverStats("all");
    await run({
      historyTrimEnabled: true,
      historyTrimThresholdTokens: 100,
      historyTrimKeepTurns: 1,
    });
    await db.flushUsage();

    const after = await db.getTokenSaverStats("all");
    const trim = after.savers.find((s) => s.id === "historyTrim");
    expect(trim, "historyTrim must be recorded when enabled").toBeDefined();
    expect(trim.requests).toBeGreaterThan(0);
    expect(after.requestsWithTelemetry).toBeGreaterThan(before.requestsWithTelemetry);
  });
});
