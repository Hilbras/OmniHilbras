/**
 * Unit tests for the deepseek-web provider.
 *
 * Covers:
 *  - the credential parser (a bare token, the localStorage wrapper, the signed-out
 *    wrapper, an empty paste, a pasted request line)
 *  - the request payload builder (the flat prompt, the model flags)
 *  - the response parser (the live SSE shape, thinking fragments, the FINISHED
 *    marker, and the whitespace that must not be trimmed)
 *  - check and connect (what they report, and that a check saves nothing)
 *  - the executor (the four upstream calls, the OpenAI-shaped answer, the errors)
 *  - the proof of work (the hash against the platform, and the nonce search)
 *
 * No live network calls: the upstream is mocked at `proxyAwareFetch`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";

vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));

const {
  parseDeepSeekUserToken,
  checkWebSession,
  connectWebSession,
  deepSeekModelIds,
} = await import("open-sse/shared/webSession/deepseek-web.js");

const {
  flattenToPrompt,
  decodeDeepSeekAnswer,
  lookupDeepSeekWebModel,
  deepSeekHashV1,
  sha3_256WithRoundCount,
  findDeepSeekPowNonce,
  DeepSeekWebExecutor,
} = await import("open-sse/executors/deepseek-web.js");

const USERS_URL = "https://chat.deepseek.com/api/v0/users/current";
const SESSION_URL = "https://chat.deepseek.com/api/v0/chat_session/create";
const POW_URL = "https://chat.deepseek.com/api/v0/chat/create_pow_challenge";
const COMPLETION_URL = "https://chat.deepseek.com/api/v0/chat/completion";

const POW_SALT = "salt-1";
const POW_EXPIRE = 1700000000;
/** The digest of nonce 0, so a difficulty of 1 is solvable. */
const POW_CHALLENGE = deepSeekHashV1(`${POW_SALT}_${POW_EXPIRE}_0`);

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(frames) {
  return new Response(frames.map((frame) => `data: ${frame}\n\n`).join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** The frames of a real reply, captured from the web client rather than invented. */
const ANSWER_FRAMES = [
  JSON.stringify({ v: { response: { thinking_enabled: false, fragments: [{ type: "RESPONSE", content: "1" }] } } }),
  JSON.stringify({ p: "response/fragments/-1/content", o: "APPEND", v: "," }),
  JSON.stringify({ v: " " }),
  JSON.stringify({ v: "2" }),
  JSON.stringify({ v: "," }),
  JSON.stringify({ p: "response", o: "BATCH", v: [{ p: "accumulated_token_usage", v: 60 }] }),
  JSON.stringify({ p: "response/status", o: "SET", v: "FINISHED" }),
];

function mockUpstream({ completion } = {}) {
  const calls = [];
  proxyAwareFetch.mockImplementation(async (url, options) => {
    calls.push({ url, options });
    if (url === USERS_URL) {
      return jsonResponse({ code: 0, msg: "", data: { biz_data: { token: "access-token" } } });
    }
    if (url === SESSION_URL) {
      return jsonResponse({ code: 0, data: { biz_data: { chat_session: { id: "session-1" } } } });
    }
    if (url === POW_URL) {
      return jsonResponse({
        code: 0,
        data: {
          biz_data: {
            challenge: {
              algorithm: "DeepSeekHashV1",
              challenge: POW_CHALLENGE,
              salt: POW_SALT,
              difficulty: 1,
              signature: "sig-1",
              target_path: "/api/v0/chat/completion",
              expire_at: POW_EXPIRE,
            },
          },
        },
      });
    }
    if (url === COMPLETION_URL) {
      return completion || sseResponse(ANSWER_FRAMES);
    }
    throw new Error(`unexpected upstream call: ${url}`);
  });
  return calls;
}

describe("parseDeepSeekUserToken", () => {
  it("takes a bare token", () => {
    expect(parseDeepSeekUserToken("abc123")).toBe("abc123");
  });

  it("trims what was pasted", () => {
    expect(parseDeepSeekUserToken("  abc123 \n")).toBe("abc123");
  });

  it("unwraps the localStorage wrapper", () => {
    expect(parseDeepSeekUserToken('{"value":"abc123","__version":1}')).toBe("abc123");
  });

  it("names the signed-out wrapper instead of passing it on", () => {
    expect(() => parseDeepSeekUserToken('{"value":null}')).toThrow(/not signed in/i);
  });

  it("refuses an empty paste", () => {
    expect(() => parseDeepSeekUserToken("   ")).toThrow(/paste the userToken/i);
  });

  it("refuses a pasted request line", () => {
    expect(() => parseDeepSeekUserToken("GET /api/v0/users/current HTTP/1.1")).toThrow(/request line/i);
  });

  it("uses an object without a value key as it stands", () => {
    expect(() => parseDeepSeekUserToken('{"other":"thing"}')).not.toThrow();
  });
});

describe("checkWebSession", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.resetAllMocks());

  it("reports a good token and the models it serves", async () => {
    mockUpstream();
    const result = await checkWebSession("abc123");
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(deepSeekModelIds());
    expect(result.models.length).toBe(14);
  });

  it("asks only the one cheap endpoint, and stores nothing", async () => {
    const calls = mockUpstream();
    await checkWebSession("abc123");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(USERS_URL);
    expect(calls[0].options.headers.Authorization).toBe("Bearer abc123");
  });

  it("sends the web client's own fingerprint", async () => {
    const calls = mockUpstream();
    await checkWebSession("abc123");
    const headers = calls[0].options.headers;
    expect(headers.origin).toBe("https://chat.deepseek.com");
    expect(headers.referer).toBe("https://chat.deepseek.com/");
    expect(headers["X-Client-Bundle-Id"]).toBe("com.deepseek.chat");
    expect(headers["X-Client-Version"]).toBe("2.0.0");
  });

  it("reports a rejected token", async () => {
    proxyAwareFetch.mockResolvedValue(new Response("", { status: 401 }));
    const result = await checkWebSession("bad-token");
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/rejected that userToken/i);
  });

  it("reads a refusal out of a 200 — the status alone is not the answer", async () => {
    proxyAwareFetch.mockResolvedValue(
      jsonResponse({ code: 1001, msg: "invalid token", data: {} }),
    );
    const result = await checkWebSession("bad-token");
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/invalid token/i);
  });

  it("refuses a paste that is not a token, without asking DeepSeek", async () => {
    const result = await checkWebSession("");
    expect(result.ok).toBe(false);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });
});

describe("connectWebSession", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.resetAllMocks());

  it("stores the bare token, not the wrapper", async () => {
    mockUpstream();
    const result = await connectWebSession('{"value":"abc123","__version":1}');
    expect(result.ok).toBe(true);
    expect(result.credential).toBe("abc123");
    expect(result.models.length).toBe(14);
  });

  it("verifies before the save, so a refused token never becomes a connection", async () => {
    proxyAwareFetch.mockResolvedValue(new Response("", { status: 401 }));
    const result = await connectWebSession("bad-token");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/rejected that userToken/i);
    expect(result.credential).toBeUndefined();
  });
});

describe("flattenToPrompt", () => {
  it("labels the turns and prefixes the instructions", () => {
    const prompt = flattenToPrompt([
      { role: "system", text: "Be terse." },
      { role: "user", text: "2+2?" },
      { role: "assistant", text: "4" },
    ]);
    expect(prompt).toBe("Follow these instructions:\n- Be terse.\n\nUser: 2+2?\nAssistant: 4");
  });

  it("drops the empty turns", () => {
    expect(flattenToPrompt([{ role: "user", text: "  " }])).toBe("");
  });
});

describe("the completion payload", () => {
  const executor = new DeepSeekWebExecutor();

  it("asks for the expert model type on a Pro model", () => {
    const payload = executor.transformRequest(
      "deepseek-v4-pro",
      { messages: [{ role: "user", content: "hi" }] },
      false,
      {},
    );
    expect(payload.model_type).toBe("expert");
  });

  it("asks for the default model type on everything else", () => {
    const payload = executor.transformRequest(
      "deepseek-chat",
      { messages: [{ role: "user", content: "hi" }] },
      false,
      {},
    );
    expect(payload.model_type).toBe("default");
  });

  it("carries the thinking and search flags the model implies", () => {
    const think = executor.transformRequest(
      "deepseek-v4-pro-think-search",
      { messages: [{ role: "user", content: "hi" }] },
      false,
      {},
    );
    expect(think.thinking_enabled).toBe(true);
    expect(think.search_enabled).toBe(true);

    const plain = executor.transformRequest(
      "deepseek-chat",
      { messages: [{ role: "user", content: "hi" }] },
      false,
      {},
    );
    expect(plain.thinking_enabled).toBe(false);
    expect(plain.search_enabled).toBe(false);
  });

  it("flattens the messages into the one prompt the endpoint takes", () => {
    const payload = executor.transformRequest(
      "deepseek-chat",
      { messages: [{ role: "user", content: "hello" }] },
      false,
      {},
    );
    expect(payload.prompt).toBe("User: hello");
    expect(payload.chat_session_id).toBeNull();
  });
});

describe("decodeDeepSeekAnswer", () => {
  it("reads the whole answer out of the live frame shape", () => {
    const answer = decodeDeepSeekAnswer(ANSWER_FRAMES.map((f) => `data: ${f}`).join("\n"));
    expect(answer.content).toBe("1, 2,");
    expect(answer.finished).toBe(true);
  });

  it("does not write the status word onto the end of the answer", () => {
    const answer = decodeDeepSeekAnswer(
      ['data: {"v":"hello"}', 'data: {"p":"response/status","o":"SET","v":"FINISHED"}'].join("\n"),
    );
    expect(answer.content).toBe("hello");
  });

  it("keeps thinking and content apart", () => {
    const answer = decodeDeepSeekAnswer(
      [
        'data: {"v":{"response":{"thinking_enabled":true,"fragments":[{"type":"THINK","content":"hmm"}]}}}',
        'data: {"p":"response/fragments","o":"append","v":[{"type":"ANSWER","content":"answer"}]}',
        'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
      ].join("\n"),
    );
    expect(answer.reasoning).toBe("hmm");
    expect(answer.content).toBe("answer");
  });

  it("gives an untyped append to whichever path was stated last", () => {
    // The path is positional, and the last stated one wins: a thinking model
    // interleaves THINK and RESPONSE fragments, and a bare append belongs to
    // whichever of them was last.
    const answer = decodeDeepSeekAnswer(
      [
        'data: {"v":{"response":{"thinking_enabled":true,"fragments":[{"type":"THINK","content":"hmm"}]}}}',
        'data: {"v":"still thinking"}',
        'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
      ].join("\n"),
    );
    expect(answer.reasoning).toBe("hmmstill thinking");
    expect(answer.content).toBe("");
  });

  it("reports a body that closes without FINISHED, which was cut off", () => {
    const answer = decodeDeepSeekAnswer('data: {"v":"partial"}');
    expect(answer.finished).toBe(false);
    expect(answer.content).toBe("partial");
  });

  it("does not trim the answer", () => {
    const answer = decodeDeepSeekAnswer('data: {"v":"  indented  "}');
    expect(answer.content).toBe("  indented  ");
  });

  it("reads the token count out of the metadata batch", () => {
    const answer = decodeDeepSeekAnswer(ANSWER_FRAMES.map((f) => `data: ${f}`).join("\n"));
    expect(answer.usage).toBe(60);
  });
});

describe("the model list", () => {
  it("looks a model up whatever the case", () => {
    expect(lookupDeepSeekWebModel("DeepSeek-R1")?.id).toBe("DeepSeek-R1");
    expect(lookupDeepSeekWebModel("deepseek-r1")?.id).toBe("DeepSeek-R1");
  });

  it("does not know a model it does not serve", () => {
    expect(lookupDeepSeekWebModel("gpt-4o")).toBeNull();
  });
});

describe("the proof of work", () => {
  it("is SHA3-256 at 24 rounds, which is the check that keeps the 23-round version honest", () => {
    for (const input of ["", "abc", "x".repeat(136), "x".repeat(137), "héllo 🌍"]) {
      expect(sha3_256WithRoundCount(input, 24)).toBe(
        createHash("sha3-256").update(input).digest("hex"),
      );
    }
  });

  it("is not the platform's hash, because it is 23 rounds", () => {
    expect(deepSeekHashV1("abc")).not.toBe(createHash("sha3-256").update("abc").digest("hex"));
  });

  it("finds a planted nonce", () => {
    const prefix = "abc123_1790579999_";
    for (const nonce of [0, 1, 4242]) {
      const challenge = deepSeekHashV1(`${prefix}${nonce}`);
      expect(findDeepSeekPowNonce(prefix, challenge, 100_000)).toBe(nonce);
    }
  });

  it("says so when the answer is outside the announced range", () => {
    const prefix = "abc_1790579999_";
    expect(findDeepSeekPowNonce(prefix, deepSeekHashV1(`${prefix}99999`), 100)).toBe(-1);
  });
});

describe("DeepSeekWebExecutor.execute", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.resetAllMocks());

  const body = { messages: [{ role: "user", content: "Count from 1 to 5" }] };

  it("makes the four calls in order", async () => {
    const calls = mockUpstream();
    await new DeepSeekWebExecutor().execute({
      model: "deepseek-chat",
      body,
      stream: false,
      credentials: { apiKey: "abc123" },
    });
    expect(calls.map((call) => call.url)).toEqual([USERS_URL, SESSION_URL, POW_URL, COMPLETION_URL]);
  });

  it("exchanges the userToken before it uses anything else", async () => {
    const calls = mockUpstream();
    await new DeepSeekWebExecutor().execute({
      model: "deepseek-chat",
      body,
      stream: false,
      credentials: { apiKey: "abc123" },
    });
    expect(calls[0].options.headers.Authorization).toBe("Bearer abc123");
    expect(calls[3].options.headers.Authorization).toBe("Bearer access-token");
  });

  it("carries the proof of work in the completion call", async () => {
    const calls = mockUpstream();
    await new DeepSeekWebExecutor().execute({
      model: "deepseek-chat",
      body,
      stream: false,
      credentials: { apiKey: "abc123" },
    });
    const answer = JSON.parse(Buffer.from(calls[3].options.headers["X-Ds-Pow-Response"], "base64").toString("utf8"));
    expect(answer.algorithm).toBe("DeepSeekHashV1");
    expect(answer.challenge).toBe(POW_CHALLENGE);
    expect(answer.answer).toBe(0);
  });

  it("answers with an OpenAI chat completion", async () => {
    mockUpstream();
    const { response } = await new DeepSeekWebExecutor().execute({
      model: "deepseek-chat",
      body,
      stream: false,
      credentials: { apiKey: "abc123" },
    });
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.content).toBe("1, 2,");
    expect(json.choices[0].finish_reason).toBe("stop");
    expect(json.model).toBe("deepseek-chat");
    expect(json.usage.completion_tokens).toBe(60);
  });

  it("answers a streaming request with an OpenAI stream", async () => {
    mockUpstream();
    const { response } = await new DeepSeekWebExecutor().execute({
      model: "deepseek-chat",
      body,
      stream: true,
      credentials: { apiKey: "abc123" },
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const text = await response.text();
    const frames = text
      .split("\n\n")
      .filter((frame) => frame.startsWith("data: {"))
      .map((frame) => JSON.parse(frame.slice(6)));
    expect(frames[0].choices[0].delta.role).toBe("assistant");
    expect(frames[1].choices[0].delta.content).toBe("1, 2,");
    expect(frames[frames.length - 1].choices[0].finish_reason).toBe("stop");
    expect(text).toContain("data: [DONE]");
  });

  it("reports a refused session as an authentication failure, not an outage", async () => {
    const calls = mockUpstream();
    proxyAwareFetch.mockImplementation(async (url, options) => {
      calls.push({ url, options });
      if (url === USERS_URL) return jsonResponse({ code: 0, data: { biz_data: { token: "access-token" } } });
      if (url === SESSION_URL) return jsonResponse({ code: 0, data: { biz_data: { chat_session: { id: "session-1" } } } });
      if (url === POW_URL) return new Response("", { status: 401 });
      throw new Error("unexpected call");
    });
    const { response } = await new DeepSeekWebExecutor().execute({
      model: "deepseek-chat",
      body,
      stream: false,
      credentials: { apiKey: "abc123" },
    });
    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json.error.type).toBe("authentication_error");
    expect(json.error.message).toMatch(/refused this session/i);
  });

  it("reports an answer that was cut off", async () => {
    mockUpstream({ completion: sseResponse(['{"v":"partial"}']) });
    const { response } = await new DeepSeekWebExecutor().execute({
      model: "deepseek-chat",
      body,
      stream: false,
      credentials: { apiKey: "abc123" },
    });
    expect(response.status).toBe(502);
    const json = await response.json();
    expect(json.error.message).toMatch(/cut off/i);
  });

  it("refuses a model it does not serve", async () => {
    mockUpstream();
    const { response } = await new DeepSeekWebExecutor().execute({
      model: "gpt-4o",
      body,
      stream: false,
      credentials: { apiKey: "abc123" },
    });
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error.message).toMatch(/does not offer a model called gpt-4o/);
  });

  it("refuses a request with no messages", async () => {
    mockUpstream();
    const { response } = await new DeepSeekWebExecutor().execute({
      model: "deepseek-chat",
      body: {},
      stream: false,
      credentials: { apiKey: "abc123" },
    });
    expect(response.status).toBe(400);
  });

  it("never throws out of execute", async () => {
    proxyAwareFetch.mockRejectedValue(new Error("network down"));
    const { response } = await new DeepSeekWebExecutor().execute({
      model: "deepseek-chat",
      body,
      stream: false,
      credentials: { apiKey: "abc123" },
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    const json = await response.json();
    expect(json.error.message).toBeTruthy();
  });
});
