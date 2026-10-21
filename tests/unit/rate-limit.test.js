// Client-facing rate limiter on the /v1 inference API.
//
// A token bucket per identity (the presented API key, else the peer IP) with a
// requests-per-minute and a tokens-per-minute ceiling. Proves: a key over its
// limit gets 429 + Retry-After while a key under it does not; the per-key
// override raises the ceiling for that key only; the global kill-switch turns
// the limiter off; the limiter FAILS OPEN (a limiter that throws still lets
// the request through); and local CLI traffic is exempt.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fx = vi.hoisted(() => ({
  settings: null,
  keys: {},
  isLocal: false,
  settingsError: null,
  keyLookupError: null,
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => {
    if (fx.settingsError) throw fx.settingsError;
    return fx.settings;
  },
  // Model resolution pulls these in through keyAccess.js — unused here.
  getModelAliases: async () => ({}),
  getComboByName: async () => null,
  getProviderNodes: async () => [],
  getCombos: async () => [],
}));

vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({
  getApiKeyByKey: async (key) => {
    if (fx.keyLookupError) throw fx.keyLookupError;
    return fx.keys[key] || null;
  },
}));

// The guard's own loopback detection is covered by
// tests/unit/local-request-peer-trust-3294.test.js — here it is a switch.
vi.mock("@/dashboardGuard.js", () => ({
  isLocalRequest: () => fx.isLocal,
}));

// The real in-flight counters, so the concurrency cap is exercised for real.
vi.mock("@/lib/usageDb.js", async () => {
  const actual = await vi.importActual("../../src/lib/db/repos/usageRepo.js");
  return {
    trackClientRequest: actual.trackClientRequest,
    getClientRequestCounts: actual.getClientRequestCounts,
  };
});

vi.mock("@/sse/utils/logger.js", () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }));

const { enforceRequestLimits } = await import("../../src/sse/services/rateLimit.js");
const { resetBuckets } = await import("../../src/shared/utils/rateLimitBucket.js");

function settings(overrides = {}) {
  return {
    rateLimit: {
      enabled: true,
      requestsPerMinute: 120,
      tokensPerMinute: 5000000,
      maxInputTokensPerRequest: 1000000,
      concurrency: { global: 32, perKey: 8 },
      maxUpstreamCallsPerRequest: 32,
      keyOverrides: {},
      ...overrides,
    },
  };
}

function req({ key = null, contentLength = null, contentType = "application/json" } = {}) {
  const headers = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  if (contentLength !== null) headers["content-length"] = String(contentLength);
  if (contentType) headers["content-type"] = contentType;
  return new Request("http://localhost/v1/chat/completions", { method: "POST", headers });
}

const ok = () => new Response("ok", { status: 200 });

// The concurrency slot is held until the response body ends, so a test that
// never reads the body would keep every slot it took. Reading it is what a
// real client does.
async function call(request, handler = ok) {
  const res = await enforceRequestLimits(request, handler);
  await res.text();
  return res;
}

beforeEach(() => {
  resetBuckets();
  fx.isLocal = false;
  fx.settingsError = null;
  fx.keyLookupError = null;
  fx.keys = {
    "sk-a": { id: "ka", name: "A" },
    "sk-b": { id: "kb", name: "B" },
  };
  fx.settings = settings();
});

describe("client request rate limit", () => {
  it("lets a key under its limit through and answers 429 + Retry-After above it", async () => {
    fx.settings = settings({ requestsPerMinute: 2 });

    expect((await call(req({ key: "sk-a" }), ok)).status).toBe(200);
    expect((await call(req({ key: "sk-a" }), ok)).status).toBe(200);

    const blocked = await call(req({ key: "sk-a" }), ok);
    expect(blocked.status).toBe(429);
    const retryAfter = Number(blocked.headers.get("retry-after"));
    expect(Number.isFinite(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
  });

  it("does not run the handler for a blocked request", async () => {
    fx.settings = settings({ requestsPerMinute: 1 });
    const handler = vi.fn(ok);
    await call(req({ key: "sk-a" }), handler);
    await call(req({ key: "sk-a" }), handler);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("keeps one key's exhausted budget from blocking a different key", async () => {
    fx.settings = settings({ requestsPerMinute: 1 });
    expect((await call(req({ key: "sk-a" }), ok)).status).toBe(200);
    expect((await call(req({ key: "sk-a" }), ok)).status).toBe(429);
    expect((await call(req({ key: "sk-b" }), ok)).status).toBe(200);
  });

  it("charges the token bucket with the estimated prompt size", async () => {
    fx.settings = settings({ tokensPerMinute: 1000 });
    // 8 KB of JSON ≈ 2000 tokens, above the 1000 tokens/minute ceiling.
    const blocked = await call(req({ key: "sk-a", contentLength: 8000 }), ok);
    expect(blocked.status).toBe(429);
  });

  it("lets a small request through when the token budget is generous", async () => {
    fx.settings = settings({ tokensPerMinute: 1000000 });
    expect((await call(req({ key: "sk-a", contentLength: 800 }), ok)).status).toBe(200);
  });

  it("buckets requests without a key by peer IP (one shared 'unknown' bucket)", async () => {
    fx.settings = settings({ requestsPerMinute: 1 });
    expect((await call(req(), ok)).status).toBe(200);
    expect((await call(req(), ok)).status).toBe(429);
  });
});

describe("per-key override", () => {
  it("raises the ceiling for that key only", async () => {
    fx.settings = settings({ requestsPerMinute: 2, keyOverrides: { ka: { requestsPerMinute: 4 } } });

    for (let i = 0; i < 4; i++) {
      expect((await call(req({ key: "sk-a" }), ok)).status).toBe(200);
    }
    expect((await call(req({ key: "sk-a" }), ok)).status).toBe(429);

    // sk-b has no override — it keeps the global ceiling of 2.
    expect((await call(req({ key: "sk-b" }), ok)).status).toBe(200);
    expect((await call(req({ key: "sk-b" }), ok)).status).toBe(200);
    expect((await call(req({ key: "sk-b" }), ok)).status).toBe(429);
  });
});

describe("global kill-switch", () => {
  it("turns the limiter off entirely", async () => {
    fx.settings = settings({ enabled: false, requestsPerMinute: 1, tokensPerMinute: 1 });
    for (let i = 0; i < 5; i++) {
      expect((await call(req({ key: "sk-a", contentLength: 100000 }), ok)).status).toBe(200);
    }
  });
});

describe("fail-open", () => {
  it("lets the request through when the limiter itself throws", async () => {
    fx.settingsError = new Error("settings db unreachable");
    const res = await call(req({ key: "sk-a" }), ok);
    expect(res.status).toBe(200);
  });

  it("lets the request through when the key lookup throws", async () => {
    fx.keyLookupError = new Error("key db unreachable");
    const res = await call(req({ key: "sk-a" }), ok);
    expect(res.status).toBe(200);
  });
});

describe("local CLI traffic", () => {
  it("is exempt from every bound", async () => {
    fx.isLocal = true;
    fx.settings = settings({ requestsPerMinute: 1, tokensPerMinute: 1 });
    for (let i = 0; i < 5; i++) {
      expect((await call(req({ key: "sk-a", contentLength: 100000 }), ok)).status).toBe(200);
    }
  });
});
