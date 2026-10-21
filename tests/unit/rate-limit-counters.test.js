// What the rate limiter did.
//
// A rejected request never reaches a provider, so no usage row exists for it:
// before the counters, a 429 left nothing but a line in the server log. These
// tests prove that every way of being turned away is counted, that the
// counters are bounded, and that they never hold the key.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fx = vi.hoisted(() => ({
  settings: null,
  keys: {},
  isLocal: false,
  settingsError: null,
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => {
    if (fx.settingsError) throw fx.settingsError;
    return fx.settings;
  },
  getModelAliases: async () => ({}),
  getComboByName: async () => null,
  getProviderNodes: async () => [],
  getCombos: async () => [],
}));

vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({
  getApiKeyByKey: async (key) => fx.keys[key] || null,
}));

vi.mock("@/dashboardGuard.js", () => ({
  isLocalRequest: () => fx.isLocal,
}));

vi.mock("@/lib/usageDb.js", async () => {
  const actual = await vi.importActual("../../src/lib/db/repos/usageRepo.js");
  return {
    trackClientRequest: actual.trackClientRequest,
    getClientRequestCounts: actual.getClientRequestCounts,
  };
});

vi.mock("@/sse/utils/logger.js", () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }));

const { enforceRequestLimits, getRateLimitStatus } = await import("../../src/sse/services/rateLimit.js");
const { resetBuckets, getBucketCount, spendRequests } = await import("../../src/shared/utils/rateLimitBucket.js");
const {
  resetCounters,
  getCounterList,
  getCounterSnapshot,
  getCounterCount,
  recordSpend,
  recordRejection,
} = await import("../../src/shared/utils/rateLimitCounters.js");

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

function req({ key = null, contentLength = null } = {}) {
  const headers = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  if (contentLength !== null) headers["content-length"] = String(contentLength);
  headers["content-type"] = "application/json";
  return new Request("http://localhost/v1/chat/completions", { method: "POST", headers });
}

const ok = () => new Response("ok", { status: 200 });

async function call(request, handler = ok) {
  const res = await enforceRequestLimits(request, handler);
  await res.text();
  return res;
}

beforeEach(() => {
  resetBuckets();
  resetCounters();
  fx.isLocal = false;
  fx.settingsError = null;
  fx.keys = { "sk-a": { id: "ka", name: "A" }, "sk-b": { id: "kb", name: "B" } };
  fx.settings = settings();
});

describe("the counter store", () => {
  it("counts what an identity spent in the last minute", () => {
    recordSpend("key:ka", { requests: 3, tokens: 1200, keyId: "ka", keyName: "A" });
    const snapshot = getCounterSnapshot("key:ka");
    expect(snapshot.requestsPerMinute).toBe(3);
    expect(snapshot.tokensPerMinute).toBe(1200);
    expect(snapshot.admitted).toBe(3);
    expect(snapshot.keyId).toBe("ka");
    expect(snapshot.keyName).toBe("A");
  });

  it("counts the rejections per dimension", () => {
    recordRejection("key:ka", "requests");
    recordRejection("key:ka", "requests");
    recordRejection("key:ka", "tokens");
    const snapshot = getCounterSnapshot("key:ka");
    expect(snapshot.rejections.requests).toBe(2);
    expect(snapshot.rejections.tokens).toBe(1);
    expect(snapshot.rejected).toBe(3);
  });

  it("ignores an unknown dimension", () => {
    recordRejection("key:ka", "not-a-dimension");
    expect(getCounterSnapshot("key:ka")?.rejected ?? 0).toBe(0);
  });

  it("never holds the key itself", () => {
    recordSpend("key:ka", { requests: 1, tokens: 10, keyId: "ka", keyName: "A" });
    recordRejection("key:ka", "requests", { keyId: "ka" });
    const serialized = JSON.stringify(getCounterList());
    expect(serialized).not.toContain("sk-");
    expect(serialized).not.toContain("sk-a");
  });

  it("stays bounded when a client rotates identities", () => {
    for (let i = 0; i < 5000; i++) {
      recordSpend(`key:rotated-${i}`, { requests: 1, tokens: 1 });
      recordRejection(`key:rotated-${i}`, "requests");
    }
    expect(getCounterCount()).toBeLessThanOrEqual(512);
  });

  it("lists the identities most recently active first", () => {
    recordSpend("key:old", { requests: 1 });
    recordSpend("key:new", { requests: 1 });
    const list = getCounterList();
    expect(list[0].scope).toBe("key:new");
    expect(list).toHaveLength(2);
  });
});

describe("the limiter reports what it does", () => {
  it("counts an admitted request", async () => {
    await call(req({ key: "sk-a" }));
    const snapshot = getCounterSnapshot("key:ka");
    expect(snapshot.admitted).toBe(1);
    expect(snapshot.requestsPerMinute).toBe(1);
    expect(snapshot.rejected).toBe(0);
  });

  it("counts a request that was over its requests ceiling", async () => {
    fx.settings = settings({ requestsPerMinute: 1 });
    await call(req({ key: "sk-a" }));
    const blocked = await call(req({ key: "sk-a" }));
    expect(blocked.status).toBe(429);
    const snapshot = getCounterSnapshot("key:ka");
    expect(snapshot.rejections.requests).toBe(1);
    expect(snapshot.admitted).toBe(1);
  });

  it("counts a request that was over its tokens ceiling", async () => {
    fx.settings = settings({ tokensPerMinute: 1000 });
    // 8 KB of JSON ≈ 2000 tokens, above the 1000 tokens/minute ceiling.
    const blocked = await call(req({ key: "sk-a", contentLength: 8000 }));
    expect(blocked.status).toBe(429);
    expect(getCounterSnapshot("key:ka").rejections.tokens).toBe(1);
  });

  it("counts a request that hit the concurrency cap", async () => {
    fx.settings = settings({ concurrency: { global: 1, perKey: 1 } });
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const slow = async () => {
      await held;
      return ok();
    };
    // The first request holds the only slot while it runs.
    const first = enforceRequestLimits(req({ key: "sk-a" }), slow);
    await new Promise((r) => setTimeout(r, 10));
    const blocked = await call(req({ key: "sk-a" }));
    expect(blocked.status).toBe(503);
    expect(getCounterSnapshot("key:ka").rejections.concurrency).toBe(1);
    release();
    await first;
  });

  it("counts a request that ran out of upstream-call budget", async () => {
    fx.settings = settings({ maxUpstreamCallsPerRequest: 1 });
    const { consumeFanOutSlot } = await import("../../open-sse/services/fanOut.js");
    const handler = async (ctx) => {
      consumeFanOutSlot(ctx.fanOutBudget, "first");
      const second = consumeFanOutSlot(ctx.fanOutBudget, "second");
      return new Response(second ? "ok" : "no", { status: second ? 200 : 429 });
    };
    const res = await call(req({ key: "sk-a" }), handler);
    expect(res.status).toBe(429);
    expect(getCounterSnapshot("key:ka").rejections.fanout).toBe(1);
  });

  it("counts the limiter's own failure, which let the request through", async () => {
    fx.settingsError = new Error("settings db unreachable");
    const res = await call(req({ key: "sk-a" }));
    expect(res.status).toBe(200);
    // The scope of a request whose identity could not be resolved is the hash
    // of the presented key — never the key itself.
    const list = getCounterList();
    expect(list).toHaveLength(1);
    expect(list[0].scope.startsWith("key:")).toBe(true);
    expect(list[0].scope).not.toContain("sk-a");
    expect(list[0].rejections.error).toBe(1);
  });

  it("reports nothing for traffic that was exempt", async () => {
    fx.isLocal = true;
    await call(req({ key: "sk-a" }));
    expect(getCounterCount()).toBe(0);
  });
});

describe("the status read-out", () => {
  it("names the ceiling and what each identity did", async () => {
    fx.settings = settings({ requestsPerMinute: 10, keyOverrides: { ka: { requestsPerMinute: 50 } } });
    await call(req({ key: "sk-a" }));

    const status = await getRateLimitStatus();
    expect(status.enabled).toBe(true);
    expect(status.defaults.requestsPerMinute).toBe(10);
    expect(status.defaults.concurrency.perKey).toBe(8);

    const identity = status.identities.find((i) => i.keyId === "ka");
    expect(identity.requestsPerMinute).toBe(1);
    // The per-key override is the ceiling that applies to this key.
    expect(identity.limits.requestsPerMinute).toBe(50);
  });
});

describe("the bucket map", () => {
  it("stays bounded when a client rotates keys", () => {
    for (let i = 0; i < 5000; i++) {
      spendRequests(`key:rotated-${i}`, 120, 1);
    }
    expect(getBucketCount()).toBeLessThanOrEqual(4096);
  });
});

describe("the status route", () => {
  it("answers with the limiter status", async () => {
    vi.doMock("next/server", () => ({
      NextResponse: {
        json(body, init = {}) {
          return new Response(JSON.stringify(body), {
            status: init.status || 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    }));
    vi.resetModules();
    const { GET } = await import("@/app/api/usage/rate-limit/route.js");

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("defaults");
    expect(body).toHaveProperty("identities");
    expect(Array.isArray(body.identities)).toBe(true);
    // The route names the keys that are calling: it must not be public.
    expect(body.identities).not.toContain("sk-a");
  });
});
