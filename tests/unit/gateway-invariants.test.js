import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The invariants of the hardening plan, made executable.
 *
 * Every item in this file is a trap: a change that looks harmless and re-opens
 * a hole, or a change that "simplifies" a timeout pair and breaks reasoning
 * models. They are written as checks that fail when the trap is sprung, so the
 * next person who touches the request path finds out immediately.
 */
const read = (rel) => fs.readFileSync(path.resolve(import.meta.dirname, "../..", rel), "utf8");

describe("gateway invariants", () => {
  describe("1. the connect + stall timeout pair is not replaced by one deadline", () => {
    const base = read("open-sse/executors/base.js");
    const stream = read("open-sse/utils/streamHandler.js");

    it("still bounds header latency with the connect timer", () => {
      expect(base).toContain("FETCH_CONNECT_TIMEOUT_MS");
      expect(base).toMatch(/connectTimer/);
    });

    it("still clears the connect timer when the headers arrive", () => {
      // The timer is deliberately cleared at headers: from that moment the body
      // belongs to the stall watchdog, not to the connect timeout.
      const clearIndex = base.indexOf("clearTimeout(connectTimer)");
      expect(clearIndex).toBeGreaterThan(-1);
      expect(base.indexOf("connectCtrl.abort")).toBeLessThan(clearIndex);
    });

    it("still watches raw upstream bytes for a stall", () => {
      // The watchdog must not measure the transform output: a reasoning model
      // emits no SSE for long stretches while bytes keep flowing.
      expect(stream).toMatch(/raw/i);
      expect(stream).toContain("STREAM_STALL_TIMEOUT_MS");
    });

    it("keeps the absolute ceiling additional, not a replacement", () => {
      const config = read("open-sse/config/runtimeConfig.js");
      expect(config).toContain("UPSTREAM_TOTAL_TIMEOUT_MS");
      expect(config).toContain("STREAM_STALL_TIMEOUT_MS");
      expect(config).toContain("FETCH_CONNECT_TIMEOUT_MS");
      // Three independent budgets, not one.
      expect(new Set([
        "UPSTREAM_TOTAL_TIMEOUT_MS",
        "STREAM_STALL_TIMEOUT_MS",
        "FETCH_CONNECT_TIMEOUT_MS",
      ]).size).toBe(3);
    });
  });

  describe("2. a new deadline goes through the delayed abort", () => {
    const stream = read("open-sse/utils/streamHandler.js");
    const watchdog = stream.slice(stream.indexOf("export function pipeWithDisconnect"));

    it("delays the abort so cleanup can run", () => {
      // The 500 ms delay exists so the terminal frame can be synthesized; a raw
      // abortController.abort() would skip it.
      expect(stream).toMatch(/abortTimeout = setTimeout\(/);
      expect(stream).toMatch(/\}, 500\);/);
    });

    it("routes every watchdog timeout through the stream controller", () => {
      expect(watchdog).toContain("streamController.abort?.()");
      expect(watchdog).toContain("streamController.handleError?.(");
    });

    it("never reaches for the raw abort controller from the watchdog", () => {
      // The watchdog may only end the request through the controller, so the
      // cleanup that synthesises the terminal frame still runs.
      expect(watchdog).not.toContain("abortController");
    });
  });

  describe("3. isLocalRequest stays strict", () => {
    const guard = read("src/dashboardGuard.js");

    it("keeps the reverse-proxy short-circuit", () => {
      // A request forwarded by custom-server.js came through a proxy, so the
      // loopback socket is the proxy hop and not the end user.
      expect(guard).toContain("x-9r-via-proxy");
    });

    it("requires a proven loopback peer", () => {
      expect(guard).toContain("isLoopbackPeer(request)");
    });

    it("checks the Origin header too", () => {
      expect(guard).toContain("origin");
    });
  });

  describe("4. a restricted key is recognised from all four key positions", () => {
    it("reads Bearer, x-api-key, x-goog-api-key and ?key=", async () => {
      const { extractClientApiKey } = await import("@/sse/services/keyAccess.js");
      const key = "sk-test-key";

      const bearer = new Request("https://x.local/v1/chat/completions", {
        headers: { Authorization: `Bearer ${key}` },
      });
      expect(extractClientApiKey(bearer)).toBe(key);

      const xApiKey = new Request("https://x.local/v1/chat/completions", {
        headers: { "x-api-key": key },
      });
      expect(extractClientApiKey(xApiKey)).toBe(key);

      const goog = new Request("https://x.local/v1/chat/completions", {
        headers: { "x-goog-api-key": key },
      });
      expect(extractClientApiKey(goog)).toBe(key);

      const query = new Request(`https://x.local/v1/chat/completions?key=${key}`);
      expect(extractClientApiKey(query)).toBe(key);
    });
  });

  describe("5. the trusted peer derivation is shared, not reinvented", () => {
    it("the rate limiter uses the login limiter's IP derivation", () => {
      const limiter = read("src/sse/services/rateLimit.js");
      expect(limiter).toMatch(/import \{ getClientIp \} from "@\/lib\/auth\/loginLimiter\.js"/);
      // It must not trust a forwarded header on its own.
      expect(limiter).not.toMatch(/headers\.get\(["']x-forwarded-for["']\)/);
    });
  });

  describe("6. PROTECTED_API_PATHS stays dead code", () => {
    it("is not declared anywhere", () => {
      const guard = read("src/dashboardGuard.js");
      expect(guard).not.toMatch(/(const|let|var)\s+PROTECTED_API_PATHS/);
      expect(guard).not.toMatch(/PROTECTED_API_PATHS\s*\[/);
    });
  });

  describe("7. the fail-open savers never throw into the request path", () => {
    it("RTK returns null instead of throwing on a broken body", async () => {
      const { compressMessages } = await import("../../open-sse/rtk/index.js");
      const broken = { messages: "not-an-array" };
      let result;
      expect(() => {
        result = compressMessages(broken, true);
      }).not.toThrow();
      expect(result).toBeNull();
    });

    it("RTK leaves the body untouched when it cannot compress", async () => {
      const { compressMessages } = await import("../../open-sse/rtk/index.js");
      const body = { messages: [{ role: "user", content: "hi" }] };
      const snapshot = JSON.stringify(body);
      compressMessages(body, true);
      expect(JSON.stringify(body)).toBe(snapshot);
    });
  });

  describe("8. the redaction keeps the merge round trip", () => {
    it("drops a credential field and keeps the safe ones", async () => {
      const { toProviderConnectionResponse } = await import("@/lib/providerConnectionResponse.js");
      const response = toProviderConnectionResponse({
        id: "c1",
        apiKey: "sk-secret",
        provider: "github-copilot",
        providerSpecificData: {
          baseUrl: "https://api.github.com",
          copilotToken: "gho_secret",
          clientSecret: "secret",
        },
      });
      expect(response.providerSpecificData.baseUrl).toBe("https://api.github.com");
      expect(response.providerSpecificData.copilotToken).toBeUndefined();
      expect(response.providerSpecificData.clientSecret).toBeUndefined();
      expect(response.apiKey).toBeUndefined();
    });
  });

  describe("9. the usage history never exposes a raw key", () => {
    const originalDataDir = process.env.DATA_DIR;
    let tempDir;

    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omnihilbras-invariants-"));
      process.env.DATA_DIR = tempDir;
    });

    afterAll(() => {
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
      if (originalDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = originalDataDir;
    });

    it("stores the fingerprint, not the key", async () => {
      const { saveRequestUsage, flushUsage, getUsageHistory } = await import(
        "@/lib/db/repos/usageRepo.js"
      );
      const rawKey = "sk-invariants-raw-key-0001";
      await saveRequestUsage({
        apiKey: rawKey,
        provider: "openai",
        model: "gpt-4o",
        endpoint: "/v1/chat/completions",
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        cost: 0.01,
        status: "success",
      });
      await flushUsage();

      const history = await getUsageHistory({});
      const row = history.find((r) => r.model === "gpt-4o");
      expect(row).toBeTruthy();
      expect(row.apiKeyMasked).toBeTruthy();
      expect(row.apiKey).toBeUndefined();
      expect(JSON.stringify(history)).not.toContain(rawKey);
    });
  });
});
