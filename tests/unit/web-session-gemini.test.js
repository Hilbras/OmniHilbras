/**
 * Gemini Web — the credential, the prompt, the parser, and the check.
 *
 * The provider drives `gemini.google.com` in a real browser, so the browser is
 * faked here and the checks are about everything around it: what a pasted
 * cookie is, what the `StreamGenerate` body means, which models the UI can be
 * driven to, and what the dashboard is told when it checks or connects. The
 * refusals matter most — one that happens after launching Chromium has already
 * spent the expensive part.
 *
 * No network and no browser: `loadPlaywright` is mocked, and the only thing
 * that reaches "Google" is the fake page.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The browser the driver will find.
 *
 * `null` means "Playwright is not installed", which is its own failure with
 * its own fix — a command, not a re-paste.
 */
let fakeBrowser = null;

vi.mock("open-sse/shared/webSession/common.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadPlaywright: async () => fakeBrowser,
  };
});

import {
  GEMINI_WEB,
  GEMINI_WEB_MODELS,
  buildGeminiWebPrompt,
  checkWebSession,
  connectWebSession,
  createGeminiWebDriver,
  geminiWebCookiePresent,
  mergeRotatedGeminiWebCookies,
  normalizeGeminiWebCookie,
  parseGeminiWebCookieHeader,
  parseGeminiWebStreamResponse,
  resolveGeminiWebModel,
} from "open-sse/shared/webSession/gemini-web.js";
import { GeminiWebExecutor } from "open-sse/executors/gemini-web.js";
import { initState, translateResponse } from "open-sse/translator/index.js";

const COOKIE = "__Secure-1PSID=psid-value; __Secure-1PSIDTS=psidts-value";

/** A `StreamGenerate` body, in the framing the page sends it in. */
function streamBody(text) {
  const payload = JSON.stringify([["wrb.fr", null, JSON.stringify([null, null, null, null, [[null, [text]]]])]]);
  return `)]}'\n\n30\n${payload}\n`;
}

/**
 * A page that answers.
 *
 * The driver only uses a handful of Playwright calls, so the fake implements
 * those and nothing else. `signedOut` puts the sign-in wall on the page, which
 * is the state a revoked session lands in.
 */
function fakePage({ signedOut = false, composerVisible = true, modeLabel = "Flash", answer = "Hello there" } = {}) {
  const handlers = [];
  const typed = { text: "", pressed: [] };

  const locator = (selector) => {
    const isSignIn = selector === GEMINI_WEB.signedOutLink;
    const isComposer = selector === GEMINI_WEB.composer;
    const isIndicator = selector.includes("bard-mode-menu-button");
    const node = {
      count: async () => (isSignIn ? (signedOut ? 1 : 0) : isComposer ? (composerVisible ? 1 : 0) : 1),
      first: () => node,
      click: async () => {},
      textContent: async () => (isIndicator ? modeLabel : null),
      innerText: async () => (isIndicator ? modeLabel : ""),
      isVisible: async () => (isComposer ? composerVisible : true),
    };
    return node;
  };

  return {
    typed,
    handlers,
    goto: async () => {},
    waitForTimeout: async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    locator,
    keyboard: {
      insertText: async (text) => {
        typed.text += text;
      },
      press: async (key) => {
        typed.pressed.push(key);
        // The page answers with its own request; the driver observes it.
        for (const handler of handlers) {
          handler({
            url: () => "https://gemini.google.com/BardChatUi/data/StreamGenerate?rpcids=abc",
            text: async () => streamBody(answer),
          });
        }
        // Let the driver's read of the body settle before the race with the
        // answer timeout is decided.
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    },
    on: (event, handler) => {
      if (event === "response") handlers.push(handler);
    },
  };
}

/** A browser whose page is the one given. */
function fakeChromium(page) {
  const added = [];
  const context = {
    added,
    addCookies: async (cookies) => {
      added.push(...cookies);
    },
    cookies: async () => added.map(({ name, value }) => ({ name, value })),
    newPage: async () => page,
    close: async () => {},
  };
  return {
    chromium: {
      launchPersistentContext: async () => context,
    },
    context,
  };
}

beforeEach(() => {
  fakeBrowser = null;
});

describe("the credential parser", () => {
  it("gives a bare value the primary cookie name, and leaves a header alone", () => {
    // The whole reason this is not a split on `=`: `abc` is a value and `abc=def` is a header, and only one
    // of them parses as a cookie. Prefixing the wrong one sends a cookie named after the value.
    expect(normalizeGeminiWebCookie("abc123")).toBe("__Secure-1PSID=abc123");
    expect(normalizeGeminiWebCookie("  abc123  ")).toBe("__Secure-1PSID=abc123");
    expect(normalizeGeminiWebCookie("a=1; b=2")).toBe("a=1; b=2");
    expect(normalizeGeminiWebCookie("")).toBe("");
  });

  it("reads a JSON export, and treats anything that is not one as a value", () => {
    expect(normalizeGeminiWebCookie('{"__Secure-1PSID":"x","__Secure-1PSIDTS":"y"}')).toBe(
      "__Secure-1PSID=x; __Secure-1PSIDTS=y",
    );
    // The `{cookies: {...}}` envelope an extension's export uses.
    expect(normalizeGeminiWebCookie('{"cookies":{"__Secure-1PSID":"x"}}')).toBe("__Secure-1PSID=x");
    // Not JSON, so it is a value — and it contains no `=`, so it gets the name. A malformed export must not throw.
    expect(normalizeGeminiWebCookie("{not json")).toBe("__Secure-1PSID={not json");
  });

  it("drops cookie attributes, because they are not cookies", () => {
    // A copied header carries `path`, `domain`, `expires`. Sending those as cookies is at best ignored and at
    // worst a malformed request.
    expect(
      parseGeminiWebCookieHeader(
        "__Secure-1PSID=x; Path=/; Domain=.google.com; Secure; SameSite=None; __Secure-1PSIDTS=y",
      ),
    ).toEqual([
      { name: "__Secure-1PSID", value: "x" },
      { name: "__Secure-1PSIDTS", value: "y" },
    ]);
  });

  it("refuses a pasted request line, and says what to copy instead", () => {
    // The commonest mistake, and it reads as a nonsense credential if it is not refused.
    expect(() => normalizeGeminiWebCookie("GET /app HTTP/1.1")).toThrow(/request line/i);
    expect(() => normalizeGeminiWebCookie("GET /app HTTP/1.1")).toThrow(/Cookie header/);
  });

  it("is present when it holds a usable cookie, and not when it is empty", () => {
    expect(geminiWebCookiePresent(COOKIE)).toBe(true);
    expect(geminiWebCookiePresent("__Secure-1PSID=")).toBe(false);
    expect(geminiWebCookiePresent("   ")).toBe(false);
  });

  it("merges the rotated cookies and leaves everything else alone", () => {
    const merged = mergeRotatedGeminiWebCookies("__Secure-1PSID=old; __Secure-1PSIDTS=old; SID=keep", [
      { name: "__Secure-1PSIDTS", value: "new" },
      { name: "__Secure-1PSIDCC", value: "minted" },
      { name: "SID", value: "should-not-apply" },
    ]);
    // 1PSID stays as pasted (the jar did not report it), 1PSIDTS is refreshed, 1PSIDCC is appended, and a
    // non-rotatable cookie the jar happens to hold does not overwrite what the user pasted.
    expect(merged).toBe("__Secure-1PSID=old; __Secure-1PSIDTS=new; SID=keep; __Secure-1PSIDCC=minted");
  });
});

describe("the prompt the page is driven with", () => {
  it("types a single user turn verbatim", () => {
    expect(buildGeminiWebPrompt([{ role: "user", text: "hi" }])).toBe("hi");
  });

  it("flattens a system message and the earlier turns into the one turn the composer takes", () => {
    const withSystem = buildGeminiWebPrompt([
      { role: "system", text: "Be brief." },
      { role: "user", text: "hi" },
    ]);
    expect(withSystem).toMatch(/System:\nBe brief\./);
    // The last user message is byte-for-byte what was typed, because that is what the model answers.
    expect(withSystem).toMatch(/Current user message:\nhi$/);

    const multi = buildGeminiWebPrompt([
      { role: "system", text: "Be brief." },
      { role: "user", text: "first" },
      { role: "assistant", text: "ok" },
      { role: "user", text: "second" },
    ]);
    expect(multi).toMatch(/Previous conversation:[\s\S]*User: first[\s\S]*Assistant: ok/);
    expect(multi).toMatch(/Current user message:\nsecond$/);
  });
});

describe("the response parser", () => {
  it("reads the answer out of the wrb.fr envelope", () => {
    expect(parseGeminiWebStreamResponse(streamBody("Hello there"))).toBe("Hello there");
  });

  it("keeps only the last frame, because the frames are snapshots and not increments", () => {
    // **The rule that matters.** Gemini's frames are snapshots of the same answer, not increments. This test
    // fails with `HellHello there` the moment someone "fixes" the parser to concatenate.
    const body = [streamBody("Hello"), streamBody("Hello there")].join("\n");
    expect(parseGeminiWebStreamResponse(body)).toBe("Hello there");
  });

  it("skips a malformed line, and yields empty rather than throwing", () => {
    // A page that changes its framing must produce "no answer" — which the executor reports as a refusal —
    // not an exception the caller has to interpret.
    const good = JSON.stringify([["wrb.fr", null, JSON.stringify([null, null, null, null, [[null, ["ok"]]]])]]);
    expect(parseGeminiWebStreamResponse(`{not json\n)]}'\n${good}`)).toBe("ok");
    expect(parseGeminiWebStreamResponse("nonsense")).toBe("");
    expect(parseGeminiWebStreamResponse("")).toBe("");
  });
});

describe("the models the page can be driven to", () => {
  it("resolves only the UI modes, and refuses a Google API model id", () => {
    expect(resolveGeminiWebModel("gemini-3.1-pro")?.id).toBe("gemini-3.1-pro");
    expect(resolveGeminiWebModel("gemini-3.7-flash")?.id).toBe("gemini-3.7-flash");
    expect(resolveGeminiWebModel("gemini-2.5-pro")).toBeUndefined();
    expect(resolveGeminiWebModel(undefined)).toBeUndefined();
  });

  it("marks the mode the page already opens to, because nothing was clicked for it", () => {
    expect(GEMINI_WEB_MODELS.find((model) => model.id === "gemini-3.1-pro")?.isDefault).toBe(true);
    expect(GEMINI_WEB.streamMarker).toBe("StreamGenerate");
  });
});

describe("check and connect", () => {
  it("refuses an empty paste without opening a browser", async () => {
    const result = await checkWebSession("   ");
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/__Secure-1PSID/);
    // The model list is still reported: it does not depend on the credential.
    expect(result.models).toEqual(["gemini-3.1-pro", "gemini-3.7-flash", "gemini-3.1-flash-lite"]);
  });

  it("refuses a pasted request line, with the message that says what to copy", async () => {
    const result = await checkWebSession("GET /app HTTP/1.1");
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/Cookie header/);
  });

  it("reports a signed-in page as a working session, and stores nothing", async () => {
    const page = fakePage();
    fakeBrowser = fakeChromium(page);
    const result = await checkWebSession(COOKIE);
    expect(result.ok).toBe(true);
    expect(result.models).toHaveLength(3);
    // The check is a page load and nothing else — no cookie is kept anywhere.
    expect(fakeBrowser.context.added[0]).toMatchObject({ name: "__Secure-1PSID", value: "psid-value" });
  });

  it("reports a sign-in wall as a refused session, with the reason", async () => {
    fakeBrowser = fakeChromium(fakePage({ signedOut: true }));
    const result = await checkWebSession(COOKIE);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/sign-in wall/i);
  });

  it("says what to do when the browser is not installed", async () => {
    fakeBrowser = null;
    const result = await checkWebSession(COOKIE);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/playwright install chromium/);
  });

  it("connects with the normalized credential, and refuses a session the page rejects", async () => {
    fakeBrowser = fakeChromium(fakePage());
    const connected = await connectWebSession("just-a-value");
    expect(connected.ok).toBe(true);
    // The value alone has no name in it; accepting it is the difference between "paste what you copied" and
    // "format it correctly first".
    expect(connected.credential).toBe("__Secure-1PSID=just-a-value");
    expect(connected.name).toBe("Gemini Web");
    expect(connected.models).toHaveLength(3);

    fakeBrowser = fakeChromium(fakePage({ signedOut: true }));
    const refused = await connectWebSession(COOKIE);
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/sign-in wall/i);
  });
});

describe("the driver", () => {
  it("types the prompt into the composer and reads the answer out of the page's own request", async () => {
    const page = fakePage({ answer: "the answer" });
    fakeBrowser = fakeChromium(page);
    const driver = createGeminiWebDriver("test-connection");

    const answer = await driver.ask({
      cookies: parseGeminiWebCookieHeader(COOKIE),
      model: resolveGeminiWebModel("gemini-3.1-pro"),
      messages: [{ role: "user", text: "hello" }],
      timeoutMs: 60_000,
    });

    expect(answer.text).toBe("the answer");
    expect(page.typed.text).toBe("hello");
    expect(page.typed.pressed).toEqual(["Enter"]);
  });

  it("fails closed when the page does not confirm the mode it was asked for", async () => {
    // A click that lands is not evidence: the page may still be on another mode. Answering with a model nobody
    // asked for and calling it the one they did is the failure this prevents.
    fakeBrowser = fakeChromium(fakePage({ modeLabel: "Pro" }));
    const driver = createGeminiWebDriver("test-connection");

    await expect(
      driver.ask({
        cookies: parseGeminiWebCookieHeader(COOKIE),
        model: resolveGeminiWebModel("gemini-3.7-flash"),
        messages: [{ role: "user", text: "hello" }],
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow(/could not select/i);
  });
});

describe("the executor", () => {
  const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

  it("refuses a request with no messages, and never throws", async () => {
    const executor = new GeminiWebExecutor();
    const result = await executor.execute({
      model: "gemini-3.1-pro",
      body: { messages: [] },
      stream: false,
      credentials: { apiKey: COOKIE },
      log,
    });
    expect(result.response.status).toBe(400);
    const body = await result.response.json();
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("refuses a missing credential", async () => {
    const executor = new GeminiWebExecutor();
    const result = await executor.execute({
      model: "gemini-3.1-pro",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: {},
      log,
    });
    expect(result.response.status).toBe(401);
    expect((await result.response.json()).error.code).toBe("AUTHENTICATION_FAILED");
  });

  it("refuses a model the page cannot be driven to, and says which ones it can", async () => {
    const executor = new GeminiWebExecutor();
    const result = await executor.execute({
      model: "gemini-2.5-pro",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: COOKIE },
      log,
    });
    expect(result.response.status).toBe(400);
    expect((await result.response.json()).error.message).toMatch(/gemini-3\.1-pro/);
  });

  it("answers a non-streaming request with an OpenAI chat completion", async () => {
    fakeBrowser = fakeChromium(fakePage({ answer: "the answer" }));
    const executor = new GeminiWebExecutor();
    const result = await executor.execute({
      model: "gemini-3.1-pro",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: COOKIE },
      log,
    });
    expect(result.response.status).toBe(200);
    const body = await result.response.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("the answer");
    expect(body.usage.total_tokens).toBeGreaterThan(0);
  });

  it("answers a streaming request with an OpenAI SSE stream", async () => {
    fakeBrowser = fakeChromium(fakePage({ answer: "the answer" }));
    const executor = new GeminiWebExecutor();
    const result = await executor.execute({
      model: "gemini-3.1-pro",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: COOKIE },
      log,
    });
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("content-type")).toContain("text/event-stream");
    const sse = await result.response.text();
    expect(sse).toContain('"role":"assistant"');
    expect(sse).toContain('"content":"the answer"');
    expect(sse).toContain("data: [DONE]");
  });

  it("reports a missing browser as its own failure, with the install command", async () => {
    fakeBrowser = null;
    const executor = new GeminiWebExecutor();
    const result = await executor.execute({
      model: "gemini-3.1-pro",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: COOKIE },
      log,
    });
    expect(result.response.status).toBe(503);
    expect((await result.response.json()).error.message).toMatch(/playwright install chromium/);
  });

  it("speaks OpenAI, so the translator can turn the answer into the client's format", async () => {
    // The contract the whole pipeline rests on: the executor answers in OpenAI's
    // shape, and the translator pivots from there. A Claude client must get a
    // Claude event out of an OpenAI chunk.
    fakeBrowser = fakeChromium(fakePage({ answer: "the answer" }));
    const executor = new GeminiWebExecutor();
    const result = await executor.execute({
      model: "gemini-3.1-pro",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: COOKIE },
      log,
    });

    const sse = await result.response.text();
    const chunks = sse
      .split("\n")
      .filter((entry) => entry.startsWith("data: {"))
      .map((entry) => JSON.parse(entry.slice("data: ".length)));
    const state = initState("claude");
    const events = chunks.flatMap((chunk) => translateResponse("openai", "claude", chunk, state));
    expect(events.some((event) => event.type === "content_block_delta")).toBe(true);
    expect(JSON.stringify(events)).toContain("the answer");
  });
});
