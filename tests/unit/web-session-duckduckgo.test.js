/**
 * Duck.ai — the credential logic, the payload, the answer, and the two dashboard entry points.
 *
 * ## Why the network is not used here
 *
 * The endpoint is rate limited **per address**, and the failures worth testing — a `418 ERR_CHALLENGE`, an
 * `ERR_BN_LIMIT` — are the ones the live service only sends when it feels like it. Provoking them deliberately
 * costs the anonymous-chat quota that the real turns need, so every branch is exercised here against a scripted
 * response instead.
 *
 * ## What is actually asserted
 *
 * The three things that must not regress: the **delta is read from `message`** (the field every other provider
 * here sends never appears, so a reader that looked only at `content` would return a 200 with an empty answer),
 * the **raw challenge is never sent** (an unsolved value is answered with 418 and still costs a request), and a
 * **page without the version attributes refuses the turn** rather than falling back to a stale version — which is
 * the defect the source implementation shipped for its entire life.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The transport stub.
 *
 * `proxyAwareFetch` captures the native fetch at import time, so stubbing `globalThis.fetch` cannot intercept it.
 * The module is mocked instead, and every request is recorded so a test can assert *what was sent* — the raw
 * challenge never is.
 */
const CATALOG = {
  models: [
    { id: "gpt-5.4-mini", modelName: "GPT-5.4", accessTier: ["free", "plus", "pro"], reasoningEffortAccess: [{ accessTier: ["free", "plus", "pro"] }] },
    { id: "claude-haiku-4-5", modelName: "Claude", accessTier: ["free", "plus"], reasoningEffortAccess: [{ accessTier: ["free", "plus"] }] },
    { id: "tinfoil/gpt-oss-120b", modelName: "gpt-oss", accessTier: ["free"], reasoningEffortAccess: [{ accessTier: ["free"] }] },
    { id: "gpt-6-luna", modelName: "GPT-6", accessTier: ["free", "plus"], reasoningEffortAccess: [] },
    { id: "mistral-small-2603", modelName: "Mistral", accessTier: ["free"], reasoningEffortAccess: [] },
    { id: "tinfoil/gemma4-31b", modelName: "Gemma 4", accessTier: ["free"], reasoningEffortAccess: [] },
    { id: "gpt-5.6-terra", modelName: "GPT-5.6", accessTier: ["plus", "pro", "internal"], reasoningEffortAccess: [{ accessTier: ["plus", "pro"] }] },
    { id: "claude-opus-4-8", modelName: "Claude", accessTier: ["pro"], reasoningEffortAccess: [{ accessTier: ["pro"] }] },
  ],
};

const stub = vi.hoisted(() => ({
  calls: [],
  home: '<html lang="en-US" data-version-tag="serp_20261016_162040_ET" data-version-sha="69b477470b6e1e9a59d7b38f6a2ba83ab3fdd747" class="react">',
  catalog: { models: [] },
  /** A challenge the solver can actually run: the real one is opaque, but its *contract* is three fields. */
  challenge: Buffer.from(
    `(async function(){ return { client_hashes: ['probe-hash-one'], server_hashes: [], meta: { v: 'fixture' } }; })()`,
    "utf8",
  ).toString("base64"),
  statusStatus: 200,
  statusBody: '{"status":"0"}',
  catalogStatus: 200,
  chatStatus: 200,
  chatBody: "",
}));

vi.mock("open-sse/utils/proxyFetch.js", () => {
  const respond = async (url, options = {}) => {
    const parsed = new URL(String(url));
    stub.calls.push({
      path: parsed.pathname,
      method: options.method || "GET",
      headers: options.headers || {},
      body: options.body,
    });

    if (parsed.pathname === "/") {
      return new Response(stub.home, { status: 200, headers: { "content-type": "text/html" } });
    }
    if (parsed.pathname === "/duckchat/v1/status") {
      return new Response(stub.statusBody, {
        status: stub.statusStatus,
        headers: {
          "content-type": "application/json",
          ...(stub.challenge ? { "x-vqd-hash-1": stub.challenge } : {}),
        },
      });
    }
    if (parsed.pathname === "/duckchat/v1/models") {
      return new Response(JSON.stringify(stub.catalog), {
        status: stub.catalogStatus,
        headers: { "content-type": "application/json" },
      });
    }
    if (parsed.pathname === "/duckchat/v1/chat") {
      return new Response(stub.chatBody, {
        status: stub.chatStatus,
        headers: { "content-type": "text/event-stream" },
      });
    }
    throw new Error(`the provider asked for an unexpected path: ${parsed.pathname}`);
  };

  return { proxyAwareFetch: respond, default: respond };
});

const {
  DUCKDUCKGO_WEB,
  buildDuckDuckGoWebPayload,
  checkWebSession,
  connectWebSession,
  duckDuckGoFeVersion,
  duckDuckGoWebContent,
  duckDuckGoWebCookieHeader,
  duckDuckGoWebModelIds,
  freeDuckDuckGoWebModels,
  normalizeDuckDuckGoWebCookie,
  parseDuckDuckGoWebDataLine,
  solveDuckDuckGoChallenge,
} = await import("open-sse/shared/webSession/duckduckgo-web.js");

const { DuckDuckGoWebExecutor } = await import("open-sse/executors/duckduckgo-web.js");

/** The stream as it really arrives: a title pseudo-event first, then `message` frames. */
const REAL_STREAM = [
  "data: [CHAT_TITLE:probe]",
  "",
  'data: {"action":"success","message":"por"}',
  "",
  'data: {"message":"t-ok"}',
  "",
  "data: [DONE]",
  "",
].join("\n");

const request = (over = {}) => ({ model: "gpt-5.4-mini", messages: [{ role: "user", content: "Reply with exactly: port-ok" }], ...over });

beforeEach(() => {
  stub.calls = [];
  stub.home = '<html lang="en-US" data-version-tag="serp_20261016_162040_ET" data-version-sha="69b477470b6e1e9a59d7b38f6a2ba83ab3fdd747" class="react">';
  stub.catalog = CATALOG;
  stub.catalogStatus = 200;
  stub.statusStatus = 200;
  stub.statusBody = '{"status":"0"}';
  stub.chatStatus = 200;
  stub.chatBody = REAL_STREAM;
  stub.challenge = Buffer.from(
    `(async function(){ return { client_hashes: ['probe-hash-one'], server_hashes: [], meta: { v: 'fixture' } }; })()`,
    "utf8",
  ).toString("base64");
});

/* ------------------------------------------------------------------ *
 * The credential parser
 * ------------------------------------------------------------------ */

describe("the credential parser", () => {
  it("accepts a cookie in all three shapes a browser hands over", () => {
    expect(normalizeDuckDuckGoWebCookie("dcs=1; dcm=3; isRecentChatOn=1")).toBe("dcs=1; dcm=3; isRecentChatOn=1");
    expect(normalizeDuckDuckGoWebCookie("Cookie: dcs=1; dcm=3")).toBe("dcs=1; dcm=3");
    // The devtools JSON export, both the bare array and the `{ cookies: [...] }` wrapper.
    expect(
      normalizeDuckDuckGoWebCookie(JSON.stringify([{ name: "dcs", value: "1" }, { name: "dcm", value: "3" }])),
    ).toBe("dcs=1; dcm=3");
    expect(normalizeDuckDuckGoWebCookie(JSON.stringify({ cookies: [{ name: "dcs", value: "1" }] }))).toBe("dcs=1");
  });

  it("reads an empty paste as 'no cookie', which is this provider's normal case", () => {
    // The difference matters: no cookie is normal here, junk is a mistake worth reporting.
    expect(normalizeDuckDuckGoWebCookie("")).toBeUndefined();
    expect(normalizeDuckDuckGoWebCookie("   ")).toBeUndefined();
  });

  it("refuses a pasted request line, and says what to copy", () => {
    expect(() => normalizeDuckDuckGoWebCookie("GET /duckchat/v1/chat HTTP/1.1")).toThrow(/request line/i);
  });

  it("refuses a paste that carries text but reads as no cookie", () => {
    expect(() => normalizeDuckDuckGoWebCookie("not a cookie at all")).toThrow();
    expect(() => normalizeDuckDuckGoWebCookie("{}")).toThrow();
  });

  it("sends a cookie when there is one, and nothing when there is not", () => {
    expect(duckDuckGoWebCookieHeader({ apiKey: "dcs=1; dcm=3" })).toBe("dcs=1; dcm=3");
    expect(duckDuckGoWebCookieHeader({})).toBeUndefined();
    expect(duckDuckGoWebCookieHeader({ apiKey: "" })).toBeUndefined();
    // Fail-open: this service needs no cookie, so an unreadable one must not cost a turn.
    expect(duckDuckGoWebCookieHeader({ apiKey: "not a cookie" })).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * The payload
 * ------------------------------------------------------------------ */

describe("the request payload", () => {
  it("carries what the service requires, and the key it is handed", () => {
    const publicKey = { kty: "RSA", n: "modulus", e: "AQAB", alg: "RSA-OAEP-256", ext: true, key_ops: ["encrypt"], use: "enc" };
    const payload = buildDuckDuckGoWebPayload({
      model: "gpt-5.4-mini",
      messages: [{ role: "user", content: "hi" }],
      publicKey,
      conversationId: "c-1",
      messageId: "m-1",
    });

    expect(payload.model).toBe("gpt-5.4-mini");
    // Required on every request by the working implementation's measurement (a 400 without it).
    expect(payload.reasoningEffort).toBe(DUCKDUCKGO_WEB.defaultReasoningEffort);
    // Every tool off: a search tool firing on its own is a request the caller did not ask for.
    expect(payload.metadata).toEqual({
      toolChoice: { NewsSearch: false, VideosSearch: false, LocalSearch: false, WeatherForecast: false },
    });
    expect(payload.messages).toEqual([{ role: "user", content: "hi" }]);
    // The key is passed through as a **value** — it is generated by the caller, not here.
    expect(payload.durableStream.publicKey).toEqual(publicKey);
    expect(payload.durableStream.messageId).toBe("m-1");
    expect(payload.durableStream.conversationId).toBe("c-1");
  });
});

/* ------------------------------------------------------------------ *
 * The answer
 * ------------------------------------------------------------------ */

describe("the response parser", () => {
  it("reads the answer from `message`, which is where this service puts it", () => {
    // THE TRAP. The live stream sends `{"action":"success","message":"…"}` and then `{"message":"…"}` frames;
    // `content` — the field every other provider here uses — never appears. A reader that looked only for
    // `content` returns HTTP 200 with an empty answer, and the spike's own first attempt did exactly that.
    expect(duckDuckGoWebContent(parseDuckDuckGoWebDataLine('data: {"action":"success","message":"hel"}'))).toBe("hel");
    expect(duckDuckGoWebContent(parseDuckDuckGoWebDataLine('data: {"message":"lo"}'))).toBe("lo");
    // And `content` still wins where it appears, so the reader is not narrowed to one shape.
    expect(duckDuckGoWebContent(parseDuckDuckGoWebDataLine('data: {"content":"direct"}'))).toBe("direct");
  });

  it("drops the pseudo-events around the answer rather than throwing on them", () => {
    // The stream opens with `data: [CHAT_TITLE:…]` and ends with `[DONE]`. A parser that threw on the first
    // would fail every turn at its first byte; both are normal.
    expect(parseDuckDuckGoWebDataLine("data: [CHAT_TITLE:probe]")).toBeUndefined();
    expect(parseDuckDuckGoWebDataLine("data: [DONE]")).toBeUndefined();
    expect(parseDuckDuckGoWebDataLine("event: ping")).toBeUndefined();
    expect(parseDuckDuckGoWebDataLine("")).toBeUndefined();
    expect(duckDuckGoWebContent(undefined)).toBe("");
  });

  it("reads the free lineup from the model, not from its reasoning tiers", () => {
    // THE OTHER TRAP. Both numbers are real, measured against the live catalog: six models carry `free` on the
    // model itself, and only three mention it inside `reasoningEffortAccess`. The nested field describes which
    // effort levels an account tier may pick, not whether the model is served.
    const free = freeDuckDuckGoWebModels(stub.catalog);
    expect(free.length).toBe(6);

    const byNestedField = stub.catalog.models.filter((model) =>
      (model.reasoningEffortAccess ?? []).some((entry) => (entry.accessTier ?? []).includes("free")),
    );
    expect(byNestedField.length).toBe(3);

    for (const model of ["gpt-6-luna", "mistral-small-2603", "tinfoil/gemma4-31b"]) {
      expect(free.some((entry) => entry.id === model)).toBe(true);
    }
    expect(free.some((entry) => entry.id === "claude-opus-4-8")).toBe(false);
  });

  it("yields nothing from a catalog that is not a catalog, rather than throwing", () => {
    // The catalog is read on every connect, and a proxy or an error page returns HTML with a 200.
    for (const value of [undefined, null, "", {}, { models: "nope" }, { models: [null, 5] }]) {
      expect(freeDuckDuckGoWebModels(value)).toEqual([]);
      expect(duckDuckGoWebModelIds(value)).toEqual([]);
    }
  });
});

/* ------------------------------------------------------------------ *
 * The version token
 * ------------------------------------------------------------------ */

describe("the request version", () => {
  it("is assembled from the two attributes, and its absence refuses the turn", () => {
    expect(duckDuckGoFeVersion(stub.home)).toBe(
      "serp_20261016_162040_ET-69b477470b6e1e9a59d7b38f6a2ba83ab3fdd747",
    );
    // A page without either attribute is "cannot say". A stale version looks like a measurement, which is
    // exactly what the source implementation shipped: it never matched, and sent an old hardcoded value on
    // every single request.
    expect(duckDuckGoFeVersion('<html class="react">')).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * Check and connect
 * ------------------------------------------------------------------ */

describe("check", () => {
  it("reports the free lineup and says no cookie was needed, when nothing was pasted", async () => {
    const result = await checkWebSession("");
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/no cookie was needed/i);
    expect(result.models).toEqual([
      "gpt-5.4-mini",
      "claude-haiku-4-5",
      "tinfoil/gpt-oss-120b",
      "gpt-6-luna",
      "mistral-small-2603",
      "tinfoil/gemma4-31b",
    ]);
  });

  it("does not claim a pasted cookie is valid — this service does not read one", async () => {
    const result = await checkWebSession("Cookie: dcs=1; dcm=3");
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/does not prove the cookie is valid/i);
  });

  it("refuses a paste that is not a cookie, and stores nothing", async () => {
    const result = await checkWebSession("GET /duckchat/v1/chat HTTP/1.1");
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/request line/i);
  });

  it("reports a status that served no challenge as a turn that cannot be proven", async () => {
    stub.challenge = null;
    const result = await checkWebSession("");
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/challenge/i);
  });

  it("reports a refusal that arrived in the body of a 200", async () => {
    // The service signals a refusal in the body and not in the status code, so a check that trusted the status
    // would report a broken credential as a working one.
    stub.statusBody = JSON.stringify({ success: false, data: { code: "ERR_CHALLENGE", details: "no proof" } });
    const result = await checkWebSession("");
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/ERR_CHALLENGE/);
  });

  it("does not fail the check when the catalog cannot be read", async () => {
    // A listing problem is not an endpoint problem, and blaming the request for it would be wrong.
    stub.catalog = { models: "nope" };
    const result = await checkWebSession("");
    expect(result.ok).toBe(true);
    expect(result.models).toEqual([]);
  });
});

describe("connect", () => {
  it("returns the normalized credential and the lineup", async () => {
    const result = await connectWebSession("Cookie: dcs=1; dcm=3");
    expect(result.ok).toBe(true);
    expect(result.credential).toBe("dcs=1; dcm=3");
    expect(result.name).toBe("Duck.ai");
    expect(result.models).toContain("gpt-5.4-mini");
  });

  it("connects with nothing pasted, because no cookie is required", async () => {
    const result = await connectWebSession("");
    expect(result.ok).toBe(true);
    expect(result.credential).toBe("");
  });

  it("refuses a paste that is not a cookie", async () => {
    const result = await connectWebSession("nonsense");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("refuses to save when the endpoint did not answer with a solvable challenge", async () => {
    stub.challenge = null;
    const result = await connectWebSession("");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/challenge/i);
  });
});

/* ------------------------------------------------------------------ *
 * The executor
 * ------------------------------------------------------------------ */

describe("the executor", () => {
  it("assembles the answer from `message` frames and drops the pseudo-events", async () => {
    const exec = new DuckDuckGoWebExecutor();
    const { response, url } = await exec.execute({
      model: "gpt-5.4-mini",
      body: request(),
      stream: false,
      credentials: {},
    });

    const json = await response.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.content).toBe("port-ok");
    expect(json.choices[0].message.role).toBe("assistant");
    expect(url).toBe(DUCKDUCKGO_WEB.baseUrl);
    // Catalog (to know what is free), homepage, status, chat — in that order, and nothing else.
    expect(stub.calls.map((call) => call.path)).toEqual([
      "/duckchat/v1/models",
      "/",
      "/duckchat/v1/status",
      "/duckchat/v1/chat",
    ]);
  });

  it("streams an OpenAI chat-completion stream when the client asked for one", async () => {
    const exec = new DuckDuckGoWebExecutor();
    const { response } = await exec.execute({
      model: "gpt-5.4-mini",
      body: request({ stream: true }),
      stream: true,
      credentials: {},
    });

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    const frames = text
      .split("\n")
      .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
      .map((line) => JSON.parse(line.slice(6)));

    expect(frames[0].choices[0].delta.role).toBe("assistant");
    const content = frames.map((frame) => frame.choices[0].delta.content || "").join("");
    expect(content).toBe("port-ok");
    expect(frames[frames.length - 1].choices[0].finish_reason).toBe("stop");
    expect(text).toContain("data: [DONE]");
  });

  it("sends the solved challenge and never the raw one", async () => {
    const exec = new DuckDuckGoWebExecutor();
    await exec.execute({ model: "gpt-5.4-mini", body: request(), stream: false, credentials: {} });

    const chat = stub.calls.find((call) => call.path === "/duckchat/v1/chat");
    const sent = chat.headers["x-vqd-hash-1"];
    expect(sent).toBeTruthy();
    expect(sent).not.toBe(stub.challenge);

    // And what was sent is the solved payload: the three fields the service checks, with hashes it did not give.
    const decoded = JSON.parse(Buffer.from(sent, "base64").toString("utf8"));
    expect(decoded.client_hashes.length).toBe(1);
    expect(decoded.client_hashes[0]).not.toBe("probe-hash-one");
    expect(decoded.meta.origin).toBe(DUCKDUCKGO_WEB.origin);
    expect(decoded.meta.stack.length).toBeGreaterThan(0);
  });

  it("sends the version token it assembled, and a body with a real RSA key", async () => {
    const exec = new DuckDuckGoWebExecutor();
    await exec.execute({ model: "gpt-5.4-mini", body: request(), stream: false, credentials: {} });

    const chat = stub.calls.find((call) => call.path === "/duckchat/v1/chat");
    expect(chat.headers["x-fe-version"]).toBe(
      "serp_20261016_162040_ET-69b477470b6e1e9a59d7b38f6a2ba83ab3fdd747",
    );

    const body = JSON.parse(chat.body);
    expect(body.model).toBe("gpt-5.4-mini");
    expect(body.reasoningEffort).toBe("none");
    expect(body.metadata.toolChoice).toEqual({
      NewsSearch: false,
      VideosSearch: false,
      LocalSearch: false,
      WeatherForecast: false,
    });
    expect(body.durableStream.publicKey.kty).toBe("RSA");
    expect(body.durableStream.publicKey.alg).toBe("RSA-OAEP-256");
    expect(body.durableStream.publicKey.n.length).toBeGreaterThan(100);
    expect(body.durableStream.messageId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("sends the pasted cookie, and no cookie header when there is none", async () => {
    const exec = new DuckDuckGoWebExecutor();
    await exec.execute({
      model: "gpt-5.4-mini",
      body: request(),
      stream: false,
      credentials: { apiKey: "my_session=abc123" },
    });

    const chat = stub.calls.find((call) => call.path === "/duckchat/v1/chat");
    expect(chat.headers.Cookie).toMatch(/my_session=abc123/);
  });

  it("refuses the turn when the homepage carries no version attributes", async () => {
    stub.home = '<html class="react">';
    const exec = new DuckDuckGoWebExecutor();
    const { response } = await exec.execute({
      model: "gpt-5.4-mini",
      body: request(),
      stream: false,
      credentials: {},
    });

    expect(response.status).toBe(502);
    const json = await response.json();
    expect(json.error.message).toMatch(/data-version-tag/);
  });

  it("classifies each refusal by its type field, not by its prose", async () => {
    // `ERR_CHALLENGE` and `ERR_BN_LIMIT` share a user-facing message token in the service's own client, so a
    // regex over the body would conflate an expired challenge with an address-level refusal. Only one of those
    // is worth waiting out.
    const cases = [
      [418, { action: "error", status: 418, type: "ERR_CHALLENGE", overrideCode: "d78d" }, 418, "PROVIDER_UNAVAILABLE"],
      [418, { action: "error", status: 418, type: "ERR_BN_LIMIT" }, 418, "PROVIDER_UNAVAILABLE"],
      [429, { action: "error", type: "ERR_RATE_LIMIT" }, 429, "PROVIDER_REQUEST_FAILED"],
      [400, { action: "error", type: "ERR_BAD_REQUEST" }, 400, "INVALID_REQUEST"],
    ];
    for (const [status, body, expectedStatus, expectedCode] of cases) {
      stub.chatStatus = status;
      stub.chatBody = JSON.stringify(body);
      const exec = new DuckDuckGoWebExecutor();
      const { response } = await exec.execute({
        model: "gpt-5.4-mini",
        body: request(),
        stream: false,
        credentials: {},
      });

      expect(response.status).toBe(expectedStatus);
      const json = await response.json();
      expect(json.error.code).toBe(expectedCode);
      expect(json.error.message).toBeTruthy();
    }
  });

  it("reports a 200 with no text in it as a failure, not as an empty answer", async () => {
    stub.chatBody = 'data: {"action":"success"}\n\ndata: [DONE]\n';
    const exec = new DuckDuckGoWebExecutor();
    const { response } = await exec.execute({
      model: "gpt-5.4-mini",
      body: request(),
      stream: false,
      credentials: {},
    });

    expect(response.status).toBe(502);
    const json = await response.json();
    expect(json.error.message).toMatch(/no text/i);
  });

  it("answers a request with no messages with a 400 rather than calling the service", async () => {
    const exec = new DuckDuckGoWebExecutor();
    const { response } = await exec.execute({ model: "gpt-5.4-mini", body: {}, stream: false, credentials: {} });

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error.type).toBe("invalid_request");
    expect(stub.calls.length).toBe(0);
  });

  it("refuses a model that is not on the free tier by name, without spending the request", async () => {
    // The service answers a model it does not serve with a 400 or a 429, and each attempt costs the address's
    // anonymous-chat quota — so a request that was going to be refused costs the same quota as one that was
    // going to work.
    const exec = new DuckDuckGoWebExecutor();
    const { response } = await exec.execute({
      model: "claude-opus-4-8",
      body: request({ model: "claude-opus-4-8" }),
      stream: false,
      credentials: {},
    });

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error.code).toBe("NOT_SUPPORTED");
    expect(json.error.message).toMatch(/free tier/);
    // The message names what is free instead.
    expect(json.error.message).toMatch(/gpt-5\.4-mini/);
    // The point of the refusal: the chat endpoint is never touched.
    expect(stub.calls.some((call) => call.path === "/duckchat/v1/chat")).toBe(false);
  });

  it("does not refuse the turn when the catalog cannot be read", async () => {
    // A catalog read that fails is a fact about this gateway, not about the request. Refusing here would be a
    // named error about the wrong thing, and the service is one request away from answering.
    stub.catalogStatus = 500;
    const exec = new DuckDuckGoWebExecutor();
    const { response } = await exec.execute({
      model: "gpt-5.4-mini",
      body: request(),
      stream: false,
      credentials: {},
    });

    const json = await response.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.content).toBe("port-ok");
  });

  it("refuses a forced tool call, because prose cannot honour it", async () => {
    const exec = new DuckDuckGoWebExecutor();
    const { response } = await exec.execute({
      model: "gpt-5.4-mini",
      body: request({ tool_choice: "required" }),
      stream: false,
      credentials: {},
    });

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error.message).toMatch(/force a tool call/);
    expect(stub.calls.some((call) => call.path === "/duckchat/v1/chat")).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * The challenge solver
 * ------------------------------------------------------------------ */

describe("the challenge solver", () => {
  it("refuses a challenge that is not base64, by name", async () => {
    // A malformed challenge used to sail into the vm and come back as `SyntaxError: Invalid or unexpected
    // token` — an unnamed failure on a path where discovering it costs anonymous-chat quota.
    await expect(solveDuckDuckGoChallenge("not base64!!", "ua")).rejects.toThrow(/not base64/i);
  });

  it("solves a challenge into a header the service can check", async () => {
    const solved = await solveDuckDuckGoChallenge(stub.challenge, "ua", { origin: DUCKDUCKGO_WEB.origin });
    const decoded = JSON.parse(Buffer.from(solved.header, "base64").toString("utf8"));
    expect(decoded.client_hashes.length).toBe(1);
    expect(decoded.meta.origin).toBe(DUCKDUCKGO_WEB.origin);
    expect(decoded.meta.stack[0].startsWith(DUCKDUCKGO_WEB.origin)).toBe(true);
  });
});
