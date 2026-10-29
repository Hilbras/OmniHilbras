import { describe, it, expect, vi, beforeEach } from "vitest";

const CONVERSATION_HEADERS = [
  "X-Conversation-ID",
  "X-Conversation-Request-ID",
  "X-Conversation-Message-ID",
];

const captured = [];

// The executors reach the network through proxyAwareFetch — mock it so the
// test asserts on the request headers without touching the gateway.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(async (url, options) => {
    captured.push({ url, headers: options.headers });
    return new Response("data: {}\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }),
  default: vi.fn(),
}));

async function runRequest(Executor) {
  const executor = new Executor();
  const result = await executor.execute({
    model: "glm-5.2",
    body: { model: "glm-5.2", messages: [{ role: "user", content: "hi" }] },
    stream: true,
    credentials: { accessToken: "test-token", apiKey: "test-token" },
  });
  return result.headers;
}

describe("CodeBuddy channel verification headers", () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it("sends the CLI conversation headers on codebuddy-intl chat requests", async () => {
    const { default: CodeBuddyIntlExecutor } = await import("../../open-sse/executors/codebuddy-intl.js");

    const headers = await runRequest(CodeBuddyIntlExecutor);

    expect(captured).toHaveLength(1);
    for (const name of CONVERSATION_HEADERS) {
      expect(headers[name], `${name} must be present`).toBeTruthy();
      expect(String(headers[name]).length).toBeGreaterThan(0);
    }
    // The CLI reuses the message id as the request id.
    expect(headers["X-Request-ID"]).toBe(headers["X-Conversation-Message-ID"]);
  });

  it("sends the CLI conversation headers on codebuddy-cn chat requests", async () => {
    const { default: CodeBuddyExecutor } = await import("../../open-sse/executors/codebuddy-cn.js");

    const headers = await runRequest(CodeBuddyExecutor);

    expect(captured).toHaveLength(1);
    for (const name of CONVERSATION_HEADERS) {
      expect(headers[name], `${name} must be present`).toBeTruthy();
      expect(String(headers[name]).length).toBeGreaterThan(0);
    }
    expect(headers["X-Request-ID"]).toBe(headers["X-Conversation-Message-ID"]);
  });

  it("uses fresh conversation ids for every request", async () => {
    const { default: CodeBuddyIntlExecutor } = await import("../../open-sse/executors/codebuddy-intl.js");

    const first = await runRequest(CodeBuddyIntlExecutor);
    const second = await runRequest(CodeBuddyIntlExecutor);

    expect(first["X-Conversation-ID"]).not.toBe(second["X-Conversation-ID"]);
    expect(first["X-Conversation-Message-ID"]).not.toBe(second["X-Conversation-Message-ID"]);
  });
});
