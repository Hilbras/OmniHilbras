/**
 * Unit tests for the Qwen Web provider (registry entry, executor, web session).
 *
 * Covers:
 *  - The credential parser (a good paste, an empty paste, a pasted request line)
 *  - The request payload builder
 *  - The response parser (refusals carried by a 200, content, usage)
 *  - The check/connect results, and that a check saves nothing
 *
 * No live network calls: the fetch is mocked at `open-sse/utils/proxyFetch.js`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The provider entry is not in the registry index until the wiring lands, so the
// executor's `PROVIDERS` lookup is answered from the entry itself. Everything else
// in the module is the real one.
vi.mock("open-sse/config/providers.js", async (importOriginal) => {
  const actual = await importOriginal();
  const { default: entry } = await import("open-sse/providers/registry/qwen-web.js");
  return { ...actual, PROVIDERS: { ...actual.PROVIDERS, "qwen-web": entry.transport } };
});

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
  default: vi.fn(),
}));

const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");
const { default: qwenWebEntry } = await import("open-sse/providers/registry/qwen-web.js");
const {
  QwenWebExecutor,
  buildQwenRequestBody,
  toQwenMessages,
  readQwenRefusal,
  readQwenMessage,
  readQwenUsage,
  describeQwenRefusal,
  refusalStatus,
} = await import("../../open-sse/executors/qwen-web.js");
const {
  QWEN_ENDPOINTS,
  parseQwenCredential,
  readQwenModels,
  probeQwenWeb,
  checkWebSession,
  connectWebSession,
} = await import("../../open-sse/shared/webSession/qwen-web.js");

const TURN_URL = qwenWebEntry.transport.baseUrl;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(frames) {
  const text = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** Answers each Qwen endpoint by URL fragment; an unlisted URL is a test bug. */
function routeNetwork(routes) {
  proxyAwareFetch.mockImplementation(async (url) => {
    for (const [fragment, handler] of Object.entries(routes)) {
      if (url.includes(fragment)) {
        return typeof handler === "function" ? handler(url) : handler;
      }
    }
    throw new Error(`unexpected request: ${url}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("qwen-web registry entry", () => {
  it("serves the endpoint the session module probes", () => {
    expect(TURN_URL).toBe(`${QWEN_ENDPOINTS.origin}${QWEN_ENDPOINTS.turnPath}`);
  });

  it("is a web cookie session provider with the ids Qwen actually serves", () => {
    expect(qwenWebEntry.category).toBe("webCookieSession");
    expect(qwenWebEntry.authType).toBe("cookie");
    expect(qwenWebEntry.transport.format).toBe("qwen-web");
    expect(qwenWebEntry.models.map((m) => m.id)).toEqual([
      "qwen3.7-plus",
      "qwen3.8-max",
      "qwen3.8-omni-flash",
    ]);
  });
});

describe("credential parser", () => {
  it("reads a pasted cookie header", () => {
    expect(parseQwenCredential("cna=abc; isg=def")).toEqual({ cna: "abc", isg: "def" });
  });

  it("reads a lone name=value pair", () => {
    expect(parseQwenCredential("cna=abc")).toEqual({ cna: "abc" });
  });

  it("refuses an empty paste", () => {
    expect(() => parseQwenCredential("")).toThrow(/Paste the Cookie header/);
  });

  it("refuses a pasted request line", () => {
    expect(() => parseQwenCredential("GET /api/v2/auths/ HTTP/1.1")).toThrow(/request line/);
  });

  it("refuses a paste with no name=value pairs", () => {
    expect(() => parseQwenCredential("nothing here")).toThrow(/name=value/);
  });

  it("points at the auth origin, which is not the chat origin", () => {
    expect(() => parseQwenCredential("")).toThrow(/auth\.qwen\.ai/);
  });
});

describe("request payload builder", () => {
  it("builds the shape the endpoint was measured with", () => {
    const payload = buildQwenRequestBody("qwen3.7-plus", [{ role: "user", content: "hi" }], false);
    expect(payload).toEqual({
      model: "qwen3.7-plus",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
  });

  it("keeps the stream flag the client asked for", () => {
    expect(buildQwenRequestBody("qwen3.8-max", [{ role: "user", content: "hi" }], true).stream).toBe(true);
  });

  it("maps developer to system and flattens multi-part content", () => {
    const messages = toQwenMessages([
      { role: "developer", content: "Be brief" },
      { role: "user", content: [{ type: "text", text: "part1" }, { type: "text", text: "part2" }] },
    ]);
    expect(messages).toEqual([
      { role: "system", content: "Be brief" },
      { role: "user", content: "part1\npart2" },
    ]);
  });

  it("drops empty turns", () => {
    expect(toQwenMessages([{ role: "user", content: "  " }, { role: "assistant", content: "" }])).toEqual([]);
  });

  it("keeps a tool result as a plain turn, because the web chat has no tool channel", () => {
    expect(toQwenMessages([{ role: "tool", content: "42" }])).toEqual([{ role: "user", content: "42" }]);
  });
});

describe("response parser", () => {
  it("reads a refusal out of a 200 body", () => {
    const refusal = readQwenRefusal({ ret: ["FAIL_SYS_USER_VALIDATE", "RGV587_ERROR::SM::x"] });
    expect(refusal).toContain("Qwen refused the turn: FAIL_SYS_USER_VALIDATE");
  });

  it("reads a refusal out of a success:false body", () => {
    expect(readQwenRefusal({ success: false, data: { code: "Unauthorized" } })).toContain("Unauthorized");
  });

  it("reports no refusal for an answer", () => {
    expect(readQwenRefusal({ choices: [{ message: { content: "hello" } }] })).toBeUndefined();
  });

  it("explains the bot-protection challenge when the refusal carries one", () => {
    const described = describeQwenRefusal({
      ret: ["FAIL_SYS_USER_VALIDATE"],
      data: { url: "https://chat.qwen.ai/_____tmd_____/punish?token=abc" },
    });
    expect(described).toContain("bot-protection challenge");
    expect(described).toContain("_____tmd_____/punish");
  });

  it("maps a refused credential to 401 and a refused request to 403", () => {
    expect(refusalStatus("Qwen refused the turn: Unauthorized")).toBe(401);
    expect(refusalStatus("Qwen refused the turn: FAIL_SYS_USER_VALIDATE")).toBe(403);
  });

  it("reads the answer out of an OpenAI-shaped body", () => {
    expect(readQwenMessage({ choices: [{ message: { content: "hello" } }] })).toMatchObject({
      text: "hello",
    });
  });

  it("reads an increment out of a streamed chunk", () => {
    expect(readQwenMessage({ choices: [{ delta: { content: "he" } }] })).toMatchObject({
      text: "he",
      cumulative: false,
    });
  });

  it("knows when a frame carries the whole answer rather than an increment", () => {
    expect(readQwenMessage({ choices: [{ message: { content: "hello there" } }] })).toMatchObject({
      text: "hello there",
      cumulative: true,
    });
  });

  it("reads a body nested under data", () => {
    expect(readQwenMessage({ data: { choices: [{ message: { content: "nested" } }] } })).toMatchObject({
      text: "nested",
    });
  });

  it("reads token usage", () => {
    expect(readQwenUsage({ usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } })).toEqual({
      prompt_tokens: 3,
      completion_tokens: 4,
      total_tokens: 7,
    });
    expect(readQwenUsage({})).toBeNull();
  });
});

describe("model catalog", () => {
  it("reads the ids the catalog endpoint serves", () => {
    expect(readQwenModels({ data: [{ id: "qwen3.7-plus" }, { id: "qwen3.8-max" }] })).toEqual([
      "qwen3.7-plus",
      "qwen3.8-max",
    ]);
    expect(readQwenModels({ data: { data: [{ id: "qwen3.8-omni-flash" }] } })).toEqual(["qwen3.8-omni-flash"]);
    expect(readQwenModels(undefined)).toEqual([]);
  });
});

describe("check", () => {
  it("reports a served turn and the model list, and saves nothing", async () => {
    routeNetwork({
      "auth.qwen.ai/api/v2/auths": jsonResponse({ success: true, data: { user: "me" } }),
      "api/v2/models/": jsonResponse({ data: [{ id: "qwen3.7-plus" }, { id: "qwen3.8-max" }] }),
      "api/v2/chat/completions": jsonResponse({ choices: [{ message: { content: "hi" } }] }),
    });

    const result = await checkWebSession("cna=abc; isg=def");

    expect(result.ok).toBe(true);
    expect(result.detail).toContain("A turn was served");
    expect(result.models).toEqual(["qwen3.7-plus", "qwen3.8-max"]);
    expect(result.credential).toBeUndefined();
  });

  it("reports a refusal carried by a 200 as a refusal, not as a success", async () => {
    routeNetwork({
      "auth.qwen.ai/api/v2/auths": jsonResponse({ success: true, data: { user: "me" } }),
      "api/v2/models/": jsonResponse({ data: [{ id: "qwen3.7-plus" }] }),
      "api/v2/chat/completions": jsonResponse({
        ret: ["FAIL_SYS_USER_VALIDATE", "RGV587_ERROR::SM::x"],
        data: { url: "https://chat.qwen.ai/_____tmd_____/punish?token=abc" },
      }),
    });

    const result = await checkWebSession("cna=abc");

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Qwen refused the turn");
    expect(result.detail).toContain("bot-protection challenge");
    expect(result.models).toEqual(["qwen3.7-plus"]);
  });

  it("reports a guest credential as refused, reading the body rather than the status", async () => {
    routeNetwork({
      "auth.qwen.ai/api/v2/auths": jsonResponse({ success: false, data: { code: "Unauthorized" } }),
      "api/v2/models/": jsonResponse({ data: [{ id: "qwen3.7-plus" }] }),
      "api/v2/chat/completions": jsonResponse({ ret: ["FAIL_SYS_USER_VALIDATE"] }),
    });

    const result = await checkWebSession("cna=abc");

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Unauthorized");
  });

  it("refuses an empty paste without asking the provider anything", async () => {
    const result = await checkWebSession("");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Paste the Cookie header/);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });
});

describe("connect", () => {
  it("returns the normalized credential to store", async () => {
    routeNetwork({
      "auth.qwen.ai/api/v2/auths": jsonResponse({ success: true, data: { user: "me" } }),
      "api/v2/models/": jsonResponse({ data: [{ id: "qwen3.7-plus" }] }),
      "api/v2/chat/completions": jsonResponse({ choices: [{ message: { content: "hi" } }] }),
    });

    const result = await connectWebSession("cna=abc;isg=def");

    expect(result.ok).toBe(true);
    expect(result.credential).toBe("cna=abc; isg=def");
    expect(result.models).toEqual(["qwen3.7-plus"]);
    expect(result.name).toBe("Qwen Web");
  });

  it("refuses a credential the auth origin will not accept", async () => {
    routeNetwork({
      "auth.qwen.ai/api/v2/auths": jsonResponse({ success: false, data: { code: "Unauthorized" } }),
      "api/v2/models/": jsonResponse({ data: [{ id: "qwen3.7-plus" }] }),
      "api/v2/chat/completions": jsonResponse({ ret: ["FAIL_SYS_USER_VALIDATE"] }),
    });

    const result = await connectWebSession("cna=abc");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("auth.qwen.ai");
    expect(result.credential).toBeUndefined();
  });

  it("does not save a credential whose turn was refused", async () => {
    routeNetwork({
      "auth.qwen.ai/api/v2/auths": jsonResponse({ success: true, data: { user: "me" } }),
      "api/v2/models/": jsonResponse({ data: [{ id: "qwen3.7-plus" }] }),
      "api/v2/chat/completions": jsonResponse({ ret: ["FAIL_SYS_USER_VALIDATE"] }),
    });

    const result = await connectWebSession("cna=abc");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Nothing is saved until a turn is actually served");
    expect(result.credential).toBeUndefined();
  });

  it("refuses a bad paste without asking the provider anything", async () => {
    const result = await connectWebSession("GET /api/v2/auths/ HTTP/1.1");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/request line/);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });
});

describe("probe", () => {
  it("answers all three questions", async () => {
    routeNetwork({
      "auth.qwen.ai/api/v2/auths": jsonResponse({ success: true, data: { user: "me" } }),
      "api/v2/models/": jsonResponse({ data: [{ id: "qwen3.8-max" }] }),
      "api/v2/chat/completions": jsonResponse({ choices: [{ message: { content: "hi" } }] }),
    });

    const probe = await probeQwenWeb("cna=abc");

    expect(probe.authenticated).toBe(true);
    expect(probe.turnServed).toBe(true);
    expect(probe.authDetail).toBe("HTTP 200");
    expect(probe.models).toEqual(["qwen3.8-max"]);
  });

  it("turns on a catalogued model", async () => {
    routeNetwork({
      "auth.qwen.ai/api/v2/auths": jsonResponse({ success: true }),
      "api/v2/models/": jsonResponse({ data: [{ id: "qwen3.8-max" }] }),
      "api/v2/chat/completions": jsonResponse({ choices: [{ message: { content: "hi" } }] }),
    });

    await probeQwenWeb("cna=abc");

    const turnCall = proxyAwareFetch.mock.calls.find(([url]) => url.includes("chat/completions"));
    const sent = JSON.parse(turnCall[1].body);
    expect(sent.model).toBe("qwen3.8-max");
    expect(sent.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(sent.stream).toBe(false);
  });
});

describe("executor", () => {
  const credentials = { apiKey: "cna=abc; isg=def" };

  it("sends the session cookie and the browser fingerprint", async () => {
    routeNetwork({ "chat/completions": jsonResponse({ choices: [{ message: { content: "hello" } }] }) });

    const executor = new QwenWebExecutor();
    const headers = executor.buildHeaders(credentials, false);

    expect(headers.cookie).toBe("cna=abc; isg=def");
    expect(headers.origin).toBe(QWEN_ENDPOINTS.origin);
    expect(headers.referer).toBe(`${QWEN_ENDPOINTS.origin}/`);
    expect(headers["user-agent"]).toMatch(/Chrome/);
  });

  it("answers a non-streaming turn with an OpenAI chat completion", async () => {
    routeNetwork({ "chat/completions": jsonResponse({ choices: [{ message: { content: "hello" } }] }) });

    const executor = new QwenWebExecutor();
    const { response, url, transformedBody } = await executor.execute({
      model: "qwen3.7-plus",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials,
    });

    expect(url).toBe(TURN_URL);
    expect(transformedBody).toEqual({
      model: "qwen3.7-plus",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });

    const json = await response.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message).toEqual({ role: "assistant", content: "hello" });
    expect(json.choices[0].finish_reason).toBe("stop");
    expect(json.usage.total_tokens).toBeGreaterThan(0);
  });

  it("answers a streaming turn with an OpenAI chunk stream", async () => {
    routeNetwork({
      "chat/completions": sseResponse([
        { choices: [{ delta: { content: "he" } }] },
        { choices: [{ delta: { content: "llo" } }] },
      ]),
    });

    const executor = new QwenWebExecutor();
    const { response } = await executor.execute({
      model: "qwen3.7-plus",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials,
    });

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const text = await response.text();
    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text).toContain('"content":"he"');
    expect(text).toContain('"content":"llo"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("streams a plain JSON answer as one content chunk", async () => {
    routeNetwork({ "chat/completions": jsonResponse({ choices: [{ message: { content: "hello" } }] }) });

    const executor = new QwenWebExecutor();
    const { response } = await executor.execute({
      model: "qwen3.7-plus",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials,
    });

    const text = await response.text();
    expect(text).toContain('"content":"hello"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("does not repeat itself when a frame carries the whole answer so far", async () => {
    routeNetwork({
      "chat/completions": sseResponse([
        { choices: [{ message: { content: "he" } }] },
        { choices: [{ message: { content: "hello" } }] },
      ]),
    });

    const executor = new QwenWebExecutor();
    const { response } = await executor.execute({
      model: "qwen3.7-plus",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials,
    });

    const text = await response.text();
    expect(text).toContain('"content":"he"');
    expect(text).toContain('"content":"llo"');
    expect(text).not.toContain('"content":"hello"');
  });

  it("turns a refusal carried by a 200 into an error response, not a stream", async () => {
    routeNetwork({
      "chat/completions": jsonResponse({
        ret: ["FAIL_SYS_USER_VALIDATE"],
        data: { url: "https://chat.qwen.ai/_____tmd_____/punish?token=abc" },
      }),
    });

    const executor = new QwenWebExecutor();
    const { response } = await executor.execute({
      model: "qwen3.7-plus",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials,
    });

    expect(response.status).toBe(403);
    const json = await response.json();
    expect(json.error.message).toContain("Qwen refused the turn");
    expect(json.error.code).toBe("QWEN_REFUSED");
  });

  it("reports an upstream failure with the upstream status", async () => {
    routeNetwork({ "chat/completions": jsonResponse({ error: "nope" }, 401) });

    const executor = new QwenWebExecutor();
    const { response } = await executor.execute({
      model: "qwen3.7-plus",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials,
    });

    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json.error.type).toBe("upstream_error");
  });

  it("refuses a connection with no session cookie", async () => {
    const executor = new QwenWebExecutor();
    const { response } = await executor.execute({
      model: "qwen3.7-plus",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: {},
    });

    expect(response.status).toBe(401);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("refuses an empty transcript without calling the provider", async () => {
    const executor = new QwenWebExecutor();
    const { response } = await executor.execute({
      model: "qwen3.7-plus",
      body: { messages: [] },
      stream: false,
      credentials,
    });

    expect(response.status).toBe(400);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });
});
