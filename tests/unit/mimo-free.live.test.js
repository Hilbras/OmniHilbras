/**
 * Issue #1933: MiMo Code Free returns HTTP 502 "MiMo bootstrap failed: 403".
 * Root cause: upstream gates on Chrome-like User-Agent. Without UA → 403 "Illegal access".
 *
 * Two layers:
 *  1. Hermetic (always runs) — the executor must send a Chrome-like
 *     User-Agent on both the bootstrap and the chat path. This is the
 *     regression the issue was about, and it is checked without the network.
 *  2. Live (RUN_REAL=1) — the real endpoints, following the same convention
 *     as tests/translator/real/*. A live provider is subject to its own
 *     anti-abuse and rate limits, so it must not decide whether the suite is
 *     green.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { __test__ } from "../../open-sse/executors/mimo-free.js";
import { MimoFreeExecutor } from "../../open-sse/executors/mimo-free.js";

const RUN_REAL = process.env.RUN_REAL === "1";

const { BOOTSTRAP_URL, CHAT_URL, generateFingerprint, MIMO_SYSTEM_MARKER } = __test__;

const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function bootstrapWith(ua) {
  const headers = { "Content-Type": "application/json" };
  if (ua) headers["User-Agent"] = ua;
  const r = await proxyAwareFetch(BOOTSTRAP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ client: generateFingerprint() }),
  });
  const data = await r.json();
  return { status: r.status, jwt: data.jwt };
}

async function chatWith(jwt, ua) {
  const headers = {
    "Content-Type": "application/json",
    "X-Mimo-Source": "mimocode-cli-free",
    Authorization: `Bearer ${jwt}`,
    Accept: "application/json",
  };
  if (ua) headers["User-Agent"] = ua;
  const body = {
    model: "mimo-auto",
    messages: [
      { role: "system", content: MIMO_SYSTEM_MARKER },
      { role: "user", content: "hi" },
    ],
    stream: false,
  };
  return proxyAwareFetch(CHAT_URL, { method: "POST", headers, body: JSON.stringify(body) });
}

describe("MiMo Free anti-abuse gate (hermetic)", () => {
  it("buildHeaders sends a Chrome-like User-Agent", () => {
    // Without a browser-like UA, upstream answers 403 "Illegal access".
    const headers = new MimoFreeExecutor().buildHeaders({ apiKey: "" }, false);
    expect(headers["User-Agent"]).toMatch(/Mozilla\/5\.0 .*Chrome\/\d+/);
  });

  it("the bootstrap request sends a Chrome-like User-Agent", async () => {
    const calls = [];
    vi.spyOn(await import("../../open-sse/utils/proxyFetch.js"), "proxyAwareFetch")
      .mockImplementation(async (url, opts) => {
        calls.push({ url, opts });
        return {
          ok: true,
          status: 200,
          json: async () => ({ jwt: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.sig" }),
        };
      });

    await __test__.bootstrapJwt();

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.opts.headers["User-Agent"]).toMatch(/Mozilla\/5\.0 .*Chrome\/\d+/);
    }
  });
});

describe.skipIf(!RUN_REAL)("MiMo Free bootstrap (live)", () => {
  it("bootstrap returns 200 with JWT", async () => {
    const { status, jwt } = await bootstrapWith(CHROME_UA);
    expect(status).toBe(200);
    expect(jwt).toBeTruthy();
  });
});

describe.skipIf(!RUN_REAL)("MiMo Free anti-abuse gate (live)", () => {
  it("chat WITH Chrome User-Agent → 200", async () => {
    const { jwt } = await bootstrapWith(CHROME_UA);
    const r = await chatWith(jwt, CHROME_UA);
    expect(r.status).toBe(200);
  });
});
