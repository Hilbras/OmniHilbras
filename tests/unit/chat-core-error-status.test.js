import { describe, it, expect, vi, beforeEach } from "vitest";

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: executeMock,
  }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

function chatRequest() {
  return {
    body: { model: "zcode/glm-5.3", stream: false, messages: [{ role: "user", content: "hi" }] },
    modelInfo: { provider: "zcode", model: "glm-5.3" },
    credentials: { apiKey: "test-key", providerSpecificData: {} },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), errorLine: vi.fn() },
    connectionId: "test-conn",
    headroomEnabled: false,
    rtkEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    clientRawRequest: {
      endpoint: "/v1/messages",
      body: {},
      headers: { accept: "application/json" },
    },
  };
}

describe("handleChatCore executor error status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn(async () => {
      throw new Error("unexpected fetch");
    });
  });

  it("keeps the status an executor classified its failure with", async () => {
    executeMock.mockRejectedValue(
      Object.assign(new Error("ZCode API error 402: ZCode quota exhausted (code 1005): exceed quota limit"), { status: 402 })
    );

    const result = await handleChatCore(chatRequest());

    expect(result.status).toBe(402);
    expect(result.success).toBe(false);
    const body = await result.response.json();
    expect(body.error.type).toBe("billing_error");
    expect(body.error.message).toContain("quota exhausted");
  });

  it("falls back to 502 when the executor did not classify the failure", async () => {
    executeMock.mockRejectedValue(new Error("socket hang up"));

    const result = await handleChatCore(chatRequest());

    expect(result.status).toBe(502);
    const body = await result.response.json();
    expect(body.error.type).toBe("server_error");
  });

  it("ignores a non-HTTP status on the thrown error", async () => {
    executeMock.mockRejectedValue(
      Object.assign(new Error("weird failure"), { status: 200 })
    );

    const result = await handleChatCore(chatRequest());

    expect(result.status).toBe(502);
  });
});
