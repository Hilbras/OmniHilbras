/**
 * Unit tests for the ChatGPT Web session provider.
 *
 * Covers:
 *  - the credential parser (a good paste, an empty paste, a pasted request
 *    line, a chunked session token, the CLI auth export, a storage state)
 *  - the payload builder (the conversation body and the prompt flattening)
 *  - the response parser (the JSON-patch conversation stream)
 *  - the check and connect results
 *
 * No live network calls: the browser is a stub, and the asset fetch goes
 * through the mocked proxy fetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(async () => new Response("", { status: 200 })),
}));

vi.mock("open-sse/shared/webSession/common.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadPlaywright: vi.fn(async () => undefined) };
});

// The browser profile directory is created on the way into a page, and a unit
// test has no business writing into the user's config directory.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, mkdir: vi.fn(async () => undefined) };
});

import { loadPlaywright, MISSING_BROWSER_MESSAGE } from "open-sse/shared/webSession/common.js";
import {
  CHATGPT_WEB,
  CHATGPT_WEB_SESSION_COOKIE,
  chatGptWebCookieHeader,
  chatGptWebCredential,
  chatGptWebModels,
  chatGptWebSessionFromCredential,
  checkWebSession,
  connectWebSession,
  normalizeChatGptWebModel,
  parseChatGptStorageState,
  resolveChatGptWebSelection,
  chatGptWebDirectModel,
} from "open-sse/shared/webSession/chatgpt-web.js";
import {
  ChatGptWebExecutor,
  buildConversationBody,
  extractAssistantText,
  flattenMessages,
  refusalFromBody,
} from "open-sse/executors/chatgpt-web.js";
import registryEntry from "open-sse/providers/registry/chatgpt-web.js";

const SESSION_COOKIE = `${CHATGPT_WEB_SESSION_COOKIE}=session-value`;
const COOKIE_HEADER = `${SESSION_COOKIE}; oai-did=device-id; cf_clearance=clearance`;

/** A storage state in the shape Playwright writes. */
const storageState = (cookies) => JSON.stringify({ cookies, origins: [] });

/** The CLI/Codex auth export — the shape people actually paste. */
const authExport = (overrides = {}) =>
  JSON.stringify({
    accessToken: "eyJhbGciOi.header.payload",
    sessionToken: "session-token-value",
    expires: "2099-12-26T17:00:52.429Z",
    authProvider: "openai",
    account: { planType: "free", structure: "personal" },
    user: { email: "someone@example.com" },
    ...overrides,
  });

/**
 * A browser that says the session is signed in.
 *
 * The check opens chatgpt.com, so the page is stubbed rather than launched:
 * the plan badge is the only thing the check reads, and the DOM markers are
 * all identical between a signed-in page and a signed-out one.
 */
function fakeBrowser({ plan = "Plus", signedOut = false, title = "" } = {}) {
  const page = {
    goto: vi.fn(async () => null),
    waitForTimeout: vi.fn(async () => undefined),
    title: vi.fn(async () => title),
    locator: vi.fn(() => ({ count: vi.fn(async () => (signedOut ? 1 : 0)) })),
    evaluate: vi.fn(async () => plan),
  };
  const context = {
    addCookies: vi.fn(async () => undefined),
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  };
  return { chromium: { launchPersistentContext: vi.fn(async () => context) }, page, context };
}

/** The credential the connection stores: the whole state, not just the cookies. */
function storedCredential() {
  return chatGptWebCredential({
    cookies: [
      { name: CHATGPT_WEB_SESSION_COOKIE, value: "session-value", domain: ".chatgpt.com", path: "/", expires: -1 },
    ],
  });
}

describe("the credential parser", () => {
  it("accepts a pasted Cookie header and keeps the session cookie", () => {
    const state = parseChatGptStorageState(COOKIE_HEADER);
    const names = state.cookies.map((cookie) => cookie.name);
    expect(names).toContain(CHATGPT_WEB_SESSION_COOKIE);
    const session = state.cookies.find((cookie) => cookie.name === CHATGPT_WEB_SESSION_COOKIE);
    expect(session.value).toBe("session-value");
    expect(session.domain).toBe(".chatgpt.com");
  });

  it("drops the cookies it did not ask for", () => {
    // An allowlist rather than a denylist: a pasted header is still
    // user-supplied input, and only ChatGPT's own cookies are sent.
    const state = parseChatGptStorageState(`${COOKIE_HEADER}; tracking_pixel=abc`);
    expect(state.cookies.map((cookie) => cookie.name)).not.toContain("tracking_pixel");
  });

  it("refuses an empty paste by name", () => {
    expect(() => parseChatGptStorageState("")).toThrow(/storage-state JSON/);
    expect(() => parseChatGptStorageState("   ")).toThrow(/storage-state JSON/);
  });

  it("refuses a pasted request line, and says what to copy instead", () => {
    expect(() => parseChatGptStorageState("GET /backend-api/sentinel/chat-requirements HTTP/1.1")).toThrow(
      /request line/i,
    );
  });

  it("refuses a header with no session cookie, and says the browser is signed out", () => {
    expect(() => parseChatGptStorageState("some_other_cookie=abc123")).toThrow(
      new RegExp(`no ${CHATGPT_WEB_SESSION_COOKIE.replace(/\./g, "\\.")} in it`),
    );
  });

  it("tells a signed-in browser apart from a signed-out one", () => {
    // The session cookie is HttpOnly, so a console one-liner cannot read it —
    // but a signed-in browser still leaks a sibling NextAuth cookie. Seeing
    // that sibling means "copied from the wrong place", not "sign in again".
    expect(() => parseChatGptStorageState("__Secure-next-auth.callback-url=https%3A%2F%2Fchatgpt.com")).toThrow(
      /HttpOnly/,
    );
  });

  it("rejoins a session token the browser split into numbered chunks", () => {
    const header = [
      `${CHATGPT_WEB_SESSION_COOKIE}.0=first-half`,
      `${CHATGPT_WEB_SESSION_COOKIE}.1=second-half`,
    ].join("; ");
    const state = parseChatGptStorageState(header);
    expect(state.cookies).toHaveLength(1);
    expect(state.cookies[0].value).toBe("first-halfsecond-half");
  });

  it("refuses a token that was cut short", () => {
    // A single chunk means the header was truncated, not that the token is
    // short — and a partial token reads as a refusal when it is sent.
    expect(() => parseChatGptStorageState(`${CHATGPT_WEB_SESSION_COOKIE}.0=only-half`)).toThrow(/cut short/);
  });

  it("reads the CLI auth export, which has no cookies array at all", () => {
    const state = parseChatGptStorageState(authExport());
    expect(state.cookies).toHaveLength(1);
    expect(state.cookies[0].name).toBe(CHATGPT_WEB_SESSION_COOKIE);
    expect(state.cookies[0].value).toBe("session-token-value");
    expect(state.planType).toBe("free");
    expect(state.expiresAt).toBe("2099-12-26T17:00:52.429Z");
  });

  it("reads a storage state and drops cookies for other sites", () => {
    const state = parseChatGptStorageState(
      storageState([
        { name: CHATGPT_WEB_SESSION_COOKIE, value: "v", domain: ".chatgpt.com" },
        { name: "other", value: "v", domain: ".attacker.example" },
      ]),
    );
    expect(state.cookies.map((cookie) => cookie.name)).toEqual([CHATGPT_WEB_SESSION_COOKIE]);
  });

  it("refuses a storage state with no chatgpt cookies in it", () => {
    expect(() => parseChatGptStorageState(storageState([{ name: "other", value: "v", domain: ".attacker.example" }]))).toThrow(
      /no usable chatgpt\.com cookies/,
    );
  });

  it("round-trips a credential through the stored form", () => {
    const state = parseChatGptStorageState(COOKIE_HEADER);
    const stored = chatGptWebCredential(state);
    const read = chatGptWebSessionFromCredential(stored);
    expect(read.cookies.map((cookie) => cookie.name)).toContain(CHATGPT_WEB_SESSION_COOKIE);
    expect(chatGptWebCookieHeader(read.cookies)).toContain("session-value");
  });

  it("reads a credential that is still the raw paste", () => {
    // A connection saved before the session was normalized holds the paste
    // itself, and the paste is unambiguous.
    const read = chatGptWebSessionFromCredential(COOKIE_HEADER);
    expect(read.cookies.map((cookie) => cookie.name)).toContain(CHATGPT_WEB_SESSION_COOKIE);
  });

  it("refuses a credential that is neither a session nor a paste", () => {
    expect(() => chatGptWebSessionFromCredential("nonsense")).toThrow();
    expect(() => chatGptWebSessionFromCredential("")).toThrow(/No ChatGPT Web session is stored/);
  });
});

describe("the payload builder", () => {
  it("builds the conversation body the page would build for itself", () => {
    const body = buildConversationBody({
      prompt: "hi",
      model: "auto",
      reason: false,
      messageId: "message-id",
      createTime: 1_700_000_000,
      timezoneOffset: 60,
      timezone: "Europe/London",
    });
    expect(body.action).toBe("next");
    expect(body.model).toBe("auto");
    expect(body.parent_message_id).toBe("client-created-root");
    expect(body.conversation_mode).toEqual({ kind: "primary_assistant" });
    expect(body.timezone).toBe("Europe/London");
    expect(body.timezone_offset_min).toBe(60);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].author).toEqual({ role: "user" });
    expect(body.messages[0].content).toEqual({ content_type: "text", parts: ["hi"] });
    expect(body.messages[0].id).toBe("message-id");
  });

  it("asks for thinking with a system hint rather than a different model", () => {
    const body = buildConversationBody({ prompt: "hi", model: "gpt-5-6", reason: true, messageId: "m", createTime: 1 });
    expect(body.system_hints).toEqual(["reason"]);
    expect(body.messages[0].metadata.system_hints).toEqual(["reason"]);
  });

  it("sends no hint when thinking is off", () => {
    const body = buildConversationBody({ prompt: "hi", model: "gpt-5-6", reason: false, messageId: "m", createTime: 1 });
    expect(body.system_hints).toEqual([]);
    expect(body.messages[0].metadata.system_hints).toBeUndefined();
  });

  it("folds the system turn into the one prompt a browser turn carries", () => {
    const { prompt, history } = flattenMessages([
      { role: "system", content: "be brief" },
      { role: "user", content: "first" },
      { role: "assistant", content: "answered" },
      { role: "user", content: "second" },
    ]);
    expect(prompt).toMatch(/be brief/);
    expect(prompt).toMatch(/second/);
    // The page gets a prompt, not a message list it has nowhere to put.
    expect(history).toHaveLength(2);
  });

  it("reads multi-part content", () => {
    const { prompt } = flattenMessages([{ role: "user", content: [{ type: "text", text: "part1" }, { type: "text", text: "part2" }] }]);
    expect(prompt).toBe("part1part2");
  });
});

describe("the model selection", () => {
  it("maps a card onto the model the page is driven with", () => {
    expect(chatGptWebDirectModel(resolveChatGptWebSelection("gpt-5.6-sol-pro"))).toEqual({
      model: "gpt-5-6-pro",
      reason: false,
    });
    expect(chatGptWebDirectModel(resolveChatGptWebSelection("gpt-5.6-sol-high"))).toEqual({
      model: "gpt-5-6",
      reason: true,
    });
    expect(chatGptWebDirectModel(resolveChatGptWebSelection("gpt-5.6-luna-free"))).toEqual({
      model: "auto",
      reason: false,
    });
    expect(chatGptWebDirectModel(resolveChatGptWebSelection("gpt-5.5-pro-extended"))).toEqual({
      model: "gpt-5-5-pro",
      reason: false,
    });
  });

  it("never asks a Pro turn to think", () => {
    // `reason` is a system hint the page does not honour on a Pro request, so
    // deriving it as "effort > 0" sends a flag the reference withholds.
    const pro = resolveChatGptWebSelection("gpt-5.6-sol-pro");
    expect(pro.effortIndex).toBe(4);
    expect(chatGptWebDirectModel(pro).reason).toBe(false);
  });

  it("refuses a model the page does not offer, rather than guessing", () => {
    expect(resolveChatGptWebSelection("gpt-4-imaginary")).toBeUndefined();
  });

  it("treats dots and hyphens as the same model, and ignores the provider prefix", () => {
    expect(normalizeChatGptWebModel("chatgpt-web/GPT-5.6-Luna-Free")).toBe("gpt-5-6-luna-free");
    expect(normalizeChatGptWebModel("gpt-5.6-luna-free")).toBe("gpt-5-6-luna-free");
    expect(resolveChatGptWebSelection("gpt-5-6")).toEqual(resolveChatGptWebSelection("chatgpt-web/gpt-5-6"));
  });

  it("serves the whole ladder to every account", () => {
    const models = chatGptWebModels("free");
    expect(models).toHaveLength(13);
    expect(models.map((model) => model.id)).toContain("gpt-5.6-sol-pro");
  });
});

describe("the registry entry", () => {
  it("registers the same models the catalog serves", () => {
    // The card the resolver refuses is a visible bug: the provider page
    // offers it, a client sends it, and the request comes back unsupported.
    // The two lists are one table, and this is what keeps them one table.
    expect(registryEntry.models.map((model) => model.id)).toEqual(chatGptWebModels().map((model) => model.id));
  });

  it("is a web cookie session, reached with a cookie", () => {
    expect(registryEntry.category).toBe("webCookieSession");
    expect(registryEntry.authType).toBe("cookie");
    expect(registryEntry.transport.format).toBe("chatgpt-web");
    expect(registryEntry.transport.baseUrl).toBe(CHATGPT_WEB.origin);
  });
});

describe("the response parser", () => {
  const assistantMessage = (text) => ({
    v: { message: { id: "m1", author: { role: "assistant" }, content: { content_type: "text", parts: [text] } } },
  });

  it("reads the assistant's text out of the conversation stream", () => {
    const body = [`data: ${JSON.stringify(assistantMessage("Hello from the page."))}`, "data: [DONE]", ""].join("\n");
    expect(extractAssistantText(body)).toBe("Hello from the page.");
  });

  it("concatenates an appended part rather than replacing it", () => {
    // `append` on a string means concatenate. Treating it as a replace keeps
    // only the final fragment, which reads as a truncated answer.
    const body = [
      `data: ${JSON.stringify(assistantMessage("Hello"))}`,
      `data: ${JSON.stringify({ p: "/message/content/parts/0", o: "append", v: " world" })}`,
      "data: [DONE]",
      "",
    ].join("\n");
    expect(extractAssistantText(body)).toBe("Hello world");
  });

  it("takes the last assistant turn, not the first", () => {
    const body = [
      `data: ${JSON.stringify(assistantMessage("the answer to turn one"))}`,
      `data: ${JSON.stringify(assistantMessage("the answer to turn two"))}`,
      "data: [DONE]",
      "",
    ].join("\n");
    expect(extractAssistantText(body)).toBe("the answer to turn two");
  });

  it("ignores a reasoning recap and the user's own turn", () => {
    const body = [
      `data: ${JSON.stringify({ v: { message: { author: { role: "user" }, content: { content_type: "text", parts: ["hi"] } } } })}`,
      `data: ${JSON.stringify({ v: { message: { author: { role: "assistant" }, content: { content_type: "reasoning", parts: ["thinking"] } } } })}`,
      `data: ${JSON.stringify(assistantMessage("the answer"))}`,
      "data: [DONE]",
      "",
    ].join("\n");
    expect(extractAssistantText(body)).toBe("the answer");
  });

  it("applies a batched patch", () => {
    const body = [
      `data: ${JSON.stringify(assistantMessage("Hello"))}`,
      `data: ${JSON.stringify({ p: "", o: "patch", v: [{ p: "/message/content/parts/0", o: "append", v: "!" }] })}`,
      "data: [DONE]",
      "",
    ].join("\n");
    expect(extractAssistantText(body)).toBe("Hello!");
  });

  it("returns nothing for a stream that carried no answer", () => {
    expect(extractAssistantText("data: [DONE]\n\n")).toBe("");
  });

  it("reads a refusal out of a body, because the status is not the whole answer", () => {
    // A refusal can arrive with HTTP 200 and a body, so a check that trusted
    // the status would report a refused turn as an empty answer.
    expect(refusalFromBody(JSON.stringify({ success: false, data: { code: "policy", details: "not allowed" } }))).toBe(
      "policy — not allowed",
    );
    expect(refusalFromBody(JSON.stringify({ ret: ["blocked", "slow_down"] }))).toBe("refused: blocked, slow_down");
    expect(refusalFromBody("data: [DONE]\n\n")).toBeUndefined();
  });
});

describe("check and connect", () => {
  beforeEach(() => {
    vi.mocked(loadPlaywright).mockReset();
    vi.mocked(loadPlaywright).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.mocked(loadPlaywright).mockReset();
  });

  it("a check on a bad paste fails, and explains why", async () => {
    const result = await checkWebSession("GET / HTTP/1.1");
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/request line/i);
  });

  it("a check stores nothing — it never returns a credential to save", async () => {
    const result = await checkWebSession(COOKIE_HEADER);
    expect(result.ok).toBe(false);
    expect(result.credential).toBeUndefined();
  });

  it("a check without a browser says so, and names the fix", async () => {
    const result = await checkWebSession(COOKIE_HEADER);
    expect(result.ok).toBe(false);
    expect(result.detail).toBe(MISSING_BROWSER_MESSAGE);
  });

  it("a check that reaches the page reports the plan and the models", async () => {
    vi.mocked(loadPlaywright).mockResolvedValue(fakeBrowser({ plan: "Plus" }));
    const result = await checkWebSession(COOKIE_HEADER);
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/Plus/);
    expect(result.models).toHaveLength(13);
    expect(result.models).toContain("gpt-5.6-sol-pro");
  });

  it("a check of a session the page refuses says the session is the problem", async () => {
    vi.mocked(loadPlaywright).mockResolvedValue(fakeBrowser({ signedOut: true }));
    const result = await checkWebSession(COOKIE_HEADER);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/sign-in wall/);
  });

  it("a connect normalizes the paste into the credential that is stored", async () => {
    const result = await connectWebSession(COOKIE_HEADER);
    expect(result.ok).toBe(true);
    expect(result.name).toBe("ChatGPT Web");
    expect(result.models).toHaveLength(13);
    const stored = JSON.parse(result.credential);
    expect(stored.cookies.map((cookie) => cookie.name)).toContain(CHATGPT_WEB_SESSION_COOKIE);
  });

  it("a connect of the CLI export keeps the plan and the expiry", async () => {
    const result = await connectWebSession(authExport());
    expect(result.ok).toBe(true);
    expect(result.email).toBe("someone@example.com");
    const stored = JSON.parse(result.credential);
    expect(stored.planType).toBe("free");
    expect(stored.expiresAt).toBe("2099-12-26T17:00:52.429Z");
  });

  it("a connect of a bad paste fails without storing anything", async () => {
    const result = await connectWebSession("not a session");
    expect(result.ok).toBe(false);
    expect(result.credential).toBeUndefined();
  });
});

describe("the executor", () => {
  beforeEach(() => {
    vi.mocked(loadPlaywright).mockReset();
    vi.mocked(loadPlaywright).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.mocked(loadPlaywright).mockReset();
  });

  it("refuses a model the page does not offer, before a browser is launched", async () => {
    const executor = new ChatGptWebExecutor();
    const { response } = await executor.execute({
      model: "gpt-4-imaginary",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: storedCredential() },
    });
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.message).toMatch(/does not offer a model called/);
  });

  it("refuses a request with no messages", async () => {
    const executor = new ChatGptWebExecutor();
    const { response } = await executor.execute({
      model: "gpt-5.6-luna-free",
      body: {},
      stream: false,
      credentials: { apiKey: storedCredential() },
    });
    expect(response.status).toBe(400);
  });

  it("never throws out of execute — a missing browser is a response", async () => {
    const executor = new ChatGptWebExecutor();
    const { response, url, headers } = await executor.execute({
      model: "gpt-5.6-luna-free",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: storedCredential() },
    });
    expect(response.status).toBe(503);
    const payload = await response.json();
    expect(payload.error.message).toBe(MISSING_BROWSER_MESSAGE);
    expect(payload.error.type).toBe("provider_unavailable");
    expect(url).toBe(CHATGPT_WEB.origin);
    // The credential is injected into the browser's cookie jar, not into a
    // header this process sends — the request log is written to disk with its
    // headers unmasked.
    expect(headers.Cookie).toBeUndefined();
    expect(headers["user-agent"]).toContain("Chrome");
  });

  it("answers in OpenAI's shape, so the translator can pivot on it", async () => {
    const executor = new ChatGptWebExecutor();
    const { responseFormat } = await executor.execute({
      model: "gpt-5.6-luna-free",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: storedCredential() },
    });
    expect(responseFormat).toBe("openai");
  });

  it("builds the request the page is driven with", () => {
    const executor = new ChatGptWebExecutor();
    const transformed = executor.transformRequest(
      "gpt-5.6-sol-high",
      { messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }] },
      false,
      { apiKey: storedCredential() },
    );
    expect(transformed.model).toBe("gpt-5-6");
    expect(transformed.reason).toBe(true);
    expect(transformed.prompt).toMatch(/be brief/);
  });
});
