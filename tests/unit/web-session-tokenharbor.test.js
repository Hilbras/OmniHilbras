/**
 * Unit tests for Token Harbor Web — the executor and the dashboard credential
 * logic.
 *
 * The service is reached with a Supabase session cookie a signed-in browser
 * already holds, so the three places a real bug would live are:
 *
 * - the **credential parser** — the session is stored in chunks, and a parser
 *   that joins them in the order it reads them reassembles a corrupt session
 *   that fails later as an unexplained refusal;
 * - the **payload builder** — a turn is two requests, and the second one is
 *   worthless without the session the first one created;
 * - the **response parser** — the answer and the reasoning arrive in their own
 *   events, and a decoder that appends every `delta` answers with the model's
 *   thinking.
 *
 * The network is mocked at `open-sse/utils/proxyFetch.js`, which is where both
 * the executor and the session module make their calls. Nothing here touches
 * the real service.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ calls: [], responses: [] }));

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: async (url, options = {}) => {
    mocks.calls.push({ url, options });
    const next = mocks.responses.shift();
    if (!next) throw new Error(`no queued response for ${url}`);
    return typeof next === "function" ? next(url, options) : next;
  },
}));

const {
  checkWebSession,
  connectWebSession,
  parseTokenHarborCookie,
  sessionValueProblem,
  sessionExpiresAt,
} = await import("open-sse/shared/webSession/tokenharbor-web.js");
const { TokenHarborWebExecutor, decodeTokenHarborStream, flattenMessages } = await import(
  "open-sse/executors/tokenharbor-web.js"
);

/* ------------------------------------------------------------------ *
 * Fixtures — transcribed from Token Harbor's own client bundle
 * ------------------------------------------------------------------ */

const b64url = (value) =>
  Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const sessionValue = (session = { access_token: "header.payload.signature", expires_at: 4102444800, refresh_token: "r" }) =>
  `base64-${b64url(JSON.stringify(session))}`;

const liveCookie = () => `sb-auth-auth-token=${sessionValue()}`;

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * A reply as named events.
 *
 * The answer arrives as several `chunk` events rather than one, and a
 * `thinking` event is included so a decoder that appends every `delta`
 * regardless of the event name is caught reading reasoning as the answer.
 */
function tokenHarborStream(parts, { done = true } = {}) {
  const blocks = [
    'event: thinking\ndata: {"delta":"considering"}',
    ...parts.map((delta) => `event: chunk\ndata: ${JSON.stringify({ delta })}`),
  ];
  if (done) blocks.push('event: done\ndata: {}');
  return blocks.join("\n\n") + "\n\n";
}

function sseResponse(body, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.responses.length = 0;
});

/* ------------------------------------------------------------------ *
 * The credential parser
 * ------------------------------------------------------------------ */

describe("parseTokenHarborCookie", () => {
  it("keeps the session and the cookies the SSR layer reads", () => {
    const cookie = parseTokenHarborCookie(`cf_clearance=abc; ${liveCookie()}; th-theme=dark`);
    expect(cookie).toContain("cf_clearance=abc");
    expect(cookie).toContain("th-theme=dark");
    expect(cookie).toContain("sb-auth-auth-token=base64-");
  });

  it("rejoins the session chunks in numeric order, not in the order they were read", () => {
    // The order here is deliberately wrong: a header that lists `.1` before
    // `.0` is what a browser emits, and a parser that joins in the order it
    // reads reassembles a corrupt session.
    const full = sessionValue();
    const half = Math.floor(full.length / 2);
    const header = `cf_clearance=abc; sb-auth-auth-token.1=${full.slice(half)}; th-theme=dark; sb-auth-auth-token.0=${full.slice(0, half)}`;

    const cookie = parseTokenHarborCookie(header);
    expect(cookie).toContain(`sb-auth-auth-token=${full}`);
    expect(cookie).toMatch(/cf_clearance=abc/);
    expect(cookie).toMatch(/th-theme=dark/);
    expect(cookie).not.toMatch(/sb-auth-auth-token\.\d/);
  });

  it("accepts the bare value the Application panel copies", () => {
    const full = sessionValue();
    expect(parseTokenHarborCookie(full)).toBe(`sb-auth-auth-token=${full}`);
    expect(parseTokenHarborCookie(`sb-auth-auth-token=${full}`)).toBe(`sb-auth-auth-token=${full}`);
  });

  it("refuses an empty paste with a message that says what to copy", () => {
    expect(() => parseTokenHarborCookie("")).toThrow(/paste the cookie header/i);
    expect(() => parseTokenHarborCookie("   ")).toThrow(/paste the cookie header/i);
  });

  it("refuses a pasted request line by name", () => {
    expect(() => parseTokenHarborCookie("GET /api/me/profile HTTP/1.1")).toThrow(/request line/i);
    expect(() => parseTokenHarborCookie("POST /api/direct-chat/stream HTTP/1.1")).toThrow(/request line/i);
  });

  it("refuses a header that carries no session cookie, and names the cookie", () => {
    expect(() => parseTokenHarborCookie("cf_clearance=abc; th-theme=dark")).toThrow(/sb-auth-auth-token/);
  });

  it("names the signed-out state instead of treating an empty cookie as a credential", () => {
    // Supabase stores an empty value when there is no session. Treating it as
    // a credential is how a refusal later looks like a provider fault instead
    // of "you are signed out".
    expect(() => parseTokenHarborCookie("sb-auth-auth-token=")).toThrow(/signed out/i);
  });

  it("refuses a truncated session here, by name, instead of sending it and reporting a dead session", () => {
    // The most likely bad paste: a session is long, and an Application-panel
    // row or a wrapped header line cuts it short.
    const full = sessionValue({ access_token: "a.b.c", expires_at: 1791404149, user: { email: "x@y.z" } });
    expect(() => parseTokenHarborCookie(`sb-auth-auth-token=${full.slice(0, Math.floor(full.length * 0.7))}`)).toThrow(
      /cut short|not valid base64/i,
    );
  });

  it("reads the expiry back out of an intact session", () => {
    const full = sessionValue({ access_token: "a.b.c", expires_at: 1791404149, refresh_token: "r" });
    const cookie = parseTokenHarborCookie(`sb-auth-auth-token=${full}`);
    expect(cookie).toMatch(/sb-auth-auth-token=base64-/);
    expect(sessionExpiresAt(cookie)).toBe(1791404149);
  });

  it("reports a value that decodes but carries no access token", () => {
    const notASession = `base64-${b64url(JSON.stringify({ hello: "world" }))}`;
    expect(sessionValueProblem(notASession)).toMatch(/no access token/i);
  });
});

/* ------------------------------------------------------------------ *
 * The payload builder
 * ------------------------------------------------------------------ */

describe("the turn payload", () => {
  it("flattens the conversation with its labels, and keeps the instruction framing", () => {
    const executor = new TokenHarborWebExecutor();
    const payload = executor.transformRequest(
      "gpt-6-luna",
      {
        messages: [
          { role: "system", content: "Be terse." },
          { role: "user", content: "2+2?" },
        ],
      },
      false,
      { apiKey: liveCookie() },
    );

    expect(payload.model).toBe("gpt-6-luna");
    expect(payload.content).toMatch(/Follow these instructions:/);
    expect(payload.content).toMatch(/User: 2\+2\?/);
    expect(payload.webSearch).toBe("auto");
    expect(payload.tz).toBeTruthy();
  });

  it("drops empty turns rather than emitting a bare label", () => {
    expect(flattenMessages([{ role: "user", content: "" }, { role: "user", content: "only" }])).toBe("User: only");
  });

  it("reads a system prompt that sits beside the messages rather than in them", () => {
    const flat = flattenMessages([{ role: "user", content: "hi" }], "Be brief.");
    expect(flat).toMatch(/Follow these instructions:/);
    expect(flat).toMatch(/- Be brief\./);
  });
});

/* ------------------------------------------------------------------ *
 * The response parser
 * ------------------------------------------------------------------ */

describe("decodeTokenHarborStream", () => {
  it("reads the answer and the reasoning from their own events", () => {
    const answer = decodeTokenHarborStream(tokenHarborStream(["Hello", ", ", "world"]));
    expect(answer.content).toBe("Hello, world");
    expect(answer.reasoning).toBe("considering");
    expect(answer.finished).toBe(true);
  });

  it("reports a stream that closes without `done` as unfinished", () => {
    // A body that ends mid-generation, handed back as a clean `stop` answer,
    // is silently missing its ending.
    const answer = decodeTokenHarborStream(tokenHarborStream(["half an ans"], { done: false }));
    expect(answer.content).toBe("half an ans");
    expect(answer.finished).toBe(false);
  });

  it("returns an `error` event with its own code rather than throwing", () => {
    const answer = decodeTokenHarborStream('event: error\ndata: {"code":"unauthorized","message":"Please sign in again."}');
    expect(answer.error?.code).toBe("unauthorized");
    expect(answer.error?.message).toBe("Please sign in again.");
  });

  it("ignores the attachment events rather than reading them as answer text", () => {
    // `image`, `file`, `citation` and `tool_use` carry payloads for a UI.
    const body = [
      'event: chunk\ndata: {"delta":"Here"}',
      'event: citation\ndata: {"url":"https://example.com"}',
      'event: image\ndata: {"url":"https://example.com/a.png"}',
      'event: chunk\ndata: {"delta":" it is."}',
      'event: done\ndata: {}',
    ].join("\n\n");

    const answer = decodeTokenHarborStream(body);
    expect(answer.content).toBe("Here it is.");
    expect(answer.content).not.toMatch(/example\.com/);
  });
});

/* ------------------------------------------------------------------ *
 * Check and connect
 * ------------------------------------------------------------------ */

describe("checkWebSession", () => {
  it("reports a working session and the catalog, and stores nothing", async () => {
    mocks.responses.push(jsonResponse(200, { ok: true, user: { email: "sailor@example.com" } }));

    const result = await checkWebSession(liveCookie());
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/accepted/i);
    expect(result.models).toContain("th-rudder:free");
    expect(mocks.calls).toHaveLength(1);
    expect(mocks.calls[0].url).toContain("/api/me/profile");
    expect(mocks.calls[0].options.headers.Cookie).toContain("sb-auth-auth-token=base64-");
  });

  it("reports a bad paste without asking the service anything", async () => {
    const result = await checkWebSession("GET /api/me/profile HTTP/1.1");
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/request line/i);
    expect(mocks.calls).toHaveLength(0);
  });

  it("reports a refused session, with the refusal the service gave", async () => {
    mocks.responses.push(jsonResponse(401, { ok: false }));
    const result = await checkWebSession(liveCookie());
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/refused this session/i);
  });

  it("reads a refusal out of a 200 body rather than trusting the status", async () => {
    // One of these services signals a refusal in the body and never in the
    // status code, so a check that trusted the status would report a guest
    // cookie as a working credential.
    mocks.responses.push(jsonResponse(200, { ok: false }));
    const result = await checkWebSession(liveCookie());
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/refused this session|did not accept/i);
  });

  it("reports an unreachable service instead of throwing", async () => {
    mocks.responses.push(() => {
      throw new Error("ECONNRESET");
    });
    const result = await checkWebSession(liveCookie());
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/could not be reached/i);
  });
});

describe("connectWebSession", () => {
  it("returns the normalized credential to store, verified before the save", async () => {
    mocks.responses.push(jsonResponse(200, { ok: true, email: "sailor@example.com" }));

    const result = await connectWebSession(`cf_clearance=abc; ${liveCookie()}`);
    expect(result.ok).toBe(true);
    expect(result.credential).toContain("cf_clearance=abc");
    expect(result.credential).toContain("sb-auth-auth-token=base64-");
    expect(result.name).toBe("Token Harbor Web");
    expect(result.email).toBe("sailor@example.com");
    expect(result.models.length).toBeGreaterThan(0);
  });

  it("stores nothing when the service refuses the credential", async () => {
    mocks.responses.push(jsonResponse(403, { ok: false }));
    const result = await connectWebSession(liveCookie());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/refused this session/i);
    expect(result.credential).toBeUndefined();
  });

  it("refuses a bad paste without a round trip", async () => {
    const result = await connectWebSession("");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/paste the cookie header/i);
    expect(mocks.calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * The executor
 * ------------------------------------------------------------------ */

describe("TokenHarborWebExecutor.execute", () => {
  it("starts a temporary session and then sends the turn, with the cookie on the request", async () => {
    mocks.responses.push(jsonResponse(200, { session: { id: "session-from-fixture" } }));
    mocks.responses.push(sseResponse(tokenHarborStream(["Hello", ", ", "world"])));

    const executor = new TokenHarborWebExecutor();
    const result = await executor.execute({
      model: "gpt-6-luna",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: liveCookie() },
    });

    expect(mocks.calls).toHaveLength(2);
    expect(mocks.calls[0].url).toContain("/api/direct-chat/sessions");
    expect(mocks.calls[1].url).toContain("/api/direct-chat/stream");

    const sessionBody = JSON.parse(mocks.calls[0].options.body);
    expect(sessionBody.temporary).toBe(true);
    expect(sessionBody.model).toBe("gpt-6-luna");

    const turnBody = JSON.parse(mocks.calls[1].options.body);
    expect(turnBody.sessionId).toBe("session-from-fixture");
    expect(turnBody.content).toMatch(/User: hi/);
    expect(mocks.calls[1].options.headers.Cookie).toContain("sb-auth-auth-token=base64-");

    const json = await result.response.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.content).toBe("Hello, world");
    expect(json.choices[0].message.reasoning_content).toBe("considering");
    expect(json.choices[0].finish_reason).toBe("stop");
  });

  it("answers a streaming request with an OpenAI chat-completions stream", async () => {
    mocks.responses.push(jsonResponse(200, { session: { id: "session-from-fixture" } }));
    mocks.responses.push(sseResponse(tokenHarborStream(["Hello", " world"])));

    const executor = new TokenHarborWebExecutor();
    const result = await executor.execute({
      model: "gpt-6-luna",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: liveCookie() },
    });

    expect(result.response.headers.get("content-type")).toContain("text/event-stream");
    const text = await result.response.text();
    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text).toContain("Hello world");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("surfaces a refused session with the upstream status", async () => {
    mocks.responses.push(jsonResponse(401, { ok: false }));

    const executor = new TokenHarborWebExecutor();
    const result = await executor.execute({
      model: "gpt-6-luna",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: liveCookie() },
    });

    expect(result.response.status).toBe(401);
    const json = await result.response.json();
    expect(json.error.message).toMatch(/refused this session/i);
    expect(json.error.code).toBe("AUTHENTICATION_FAILED");
  });

  it("reports a stream that was cut off instead of answering with half of it", async () => {
    mocks.responses.push(jsonResponse(200, { session: { id: "session-from-fixture" } }));
    mocks.responses.push(sseResponse(tokenHarborStream(["half an ans"], { done: false })));

    const executor = new TokenHarborWebExecutor();
    const result = await executor.execute({
      model: "gpt-6-luna",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: liveCookie() },
    });

    expect(result.response.status).toBe(502);
    const json = await result.response.json();
    expect(json.error.message).toMatch(/ended before it finished/i);
  });

  it("reports a refusal the service sent inside the stream", async () => {
    mocks.responses.push(jsonResponse(200, { session: { id: "session-from-fixture" } }));
    mocks.responses.push(sseResponse('event: error\ndata: {"code":"unauthorized","message":"Please sign in again."}\n\n'));

    const executor = new TokenHarborWebExecutor();
    const result = await executor.execute({
      model: "gpt-6-luna",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: liveCookie() },
    });

    expect(result.response.status).toBe(401);
    const json = await result.response.json();
    expect(json.error.message).toMatch(/refused the turn/i);
  });

  it("refuses a model the catalog does not list", async () => {
    const executor = new TokenHarborWebExecutor();
    const result = await executor.execute({
      model: "not-a-model",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: liveCookie() },
    });

    expect(result.response.status).toBe(400);
    const json = await result.response.json();
    expect(json.error.message).toMatch(/does not offer a model called not-a-model/);
    expect(mocks.calls).toHaveLength(0);
  });

  it("answers a request that names no model with the free default", async () => {
    mocks.responses.push(jsonResponse(200, { session: { id: "session-from-fixture" } }));
    mocks.responses.push(sseResponse(tokenHarborStream(["ok"])));

    const executor = new TokenHarborWebExecutor();
    await executor.execute({
      model: "",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: liveCookie() },
    });

    expect(JSON.parse(mocks.calls[0].options.body).model).toBe("th-rudder:free");
  });

  it("refuses a request with no messages, and one with no credential", async () => {
    const executor = new TokenHarborWebExecutor();

    const empty = await executor.execute({
      model: "gpt-6-luna",
      body: {},
      stream: false,
      credentials: { apiKey: liveCookie() },
    });
    expect(empty.response.status).toBe(400);

    const noCredential = await executor.execute({
      model: "gpt-6-luna",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: {},
    });
    expect(noCredential.response.status).toBe(401);
    expect(mocks.calls).toHaveLength(0);
  });

  it("never throws out of execute — a dead network becomes a 502, not an exception", async () => {
    // An executor that throws turns the provider's own message into "every
    // provider route failed", which throws away the one thing the user can
    // act on.
    mocks.responses.push(() => {
      throw new Error("ECONNRESET");
    });

    const executor = new TokenHarborWebExecutor();
    const result = await executor.execute({
      model: "gpt-6-luna",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: liveCookie() },
    });

    expect(result.response.status).toBe(502);
    const json = await result.response.json();
    expect(json.error.message).toMatch(/connection failed/i);
  });
});
