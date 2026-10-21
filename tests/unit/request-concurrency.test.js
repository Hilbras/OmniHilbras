// Concurrency cap on in-flight client requests.
//
// The gateway's pending-request counter (trackPendingRequest) only counted
// UPSTREAM calls per model/account, which is the wrong unit for a client
// bound: one client request can fan out into many upstream calls and each of
// them holds a buffered request body (up to 128 MB). The cap counts CLIENT
// requests in flight — globally and per key — and rejects with 503 +
// Retry-After. The slot is released when the response body ends.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fx = vi.hoisted(() => ({
  settings: null,
  keys: {},
  isLocal: false,
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => fx.settings,
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

// The real in-flight counters, so the cap is exercised against the same
// counter the dashboard reads.
vi.mock("@/lib/usageDb.js", async () => {
  const actual = await vi.importActual("../../src/lib/db/repos/usageRepo.js");
  return {
    trackClientRequest: actual.trackClientRequest,
    getClientRequestCounts: actual.getClientRequestCounts,
  };
});

vi.mock("@/sse/utils/logger.js", () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }));

const { enforceRequestLimits } = await import("../../src/sse/services/rateLimit.js");
const { trackClientRequest, getClientRequestCounts } = await import("../../src/lib/db/repos/usageRepo.js");

function settings(overrides = {}) {
  return {
    rateLimit: {
      enabled: true,
      requestsPerMinute: 1000,
      tokensPerMinute: 5000000,
      maxInputTokensPerRequest: 1000000,
      concurrency: { global: 32, perKey: 8 },
      maxUpstreamCallsPerRequest: 32,
      keyOverrides: {},
      ...overrides,
    },
  };
}

function req(key) {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
  });
}

const ok = () => new Response("ok", { status: 200 });

// A handler that stays in flight until the test lets it finish.
function gatedHandler() {
  let open;
  let entered;
  const gate = new Promise((resolve) => { open = resolve; });
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const handler = async () => {
    entered();
    await gate;
    return new Response("ok", { status: 200 });
  };
  return { handler, enteredPromise, open };
}

beforeEach(() => {
  fx.isLocal = false;
  fx.keys = { "sk-a": { id: "ka", name: "A" }, "sk-b": { id: "kb", name: "B" } };
  fx.settings = settings();
  // Drain any slot a previous test left behind.
  const counts = getClientRequestCounts();
  for (const [scope, count] of Object.entries(counts.byScope)) {
    for (let i = 0; i < count; i++) trackClientRequest(scope, false);
  }
});

describe("concurrency cap", () => {
  it("rejects above the per-key limit with 503 + Retry-After", async () => {
    fx.settings = settings({ concurrency: { global: 10, perKey: 1 } });
    const { handler, enteredPromise, open } = gatedHandler();

    const inFlight = enforceRequestLimits(req("sk-a"), handler);
    await enteredPromise;

    const rejected = await enforceRequestLimits(req("sk-a"), ok);
    expect(rejected.status).toBe(503);
    expect(Number(rejected.headers.get("retry-after"))).toBeGreaterThan(0);

    open();
    const res = await inFlight;
    await res.text();
  });

  it("releases the slot once the response body has ended", async () => {
    fx.settings = settings({ concurrency: { global: 10, perKey: 1 } });
    const { handler, enteredPromise, open } = gatedHandler();

    const inFlight = enforceRequestLimits(req("sk-a"), handler);
    await enteredPromise;
    expect((await enforceRequestLimits(req("sk-a"), ok)).status).toBe(503);

    open();
    const res = await inFlight;
    await res.text(); // the body ends → the slot is released

    const after = await enforceRequestLimits(req("sk-a"), ok);
    expect(after.status).toBe(200);
    await after.text();
  });

  it("releases the slot when the handler throws", async () => {
    fx.settings = settings({ concurrency: { global: 10, perKey: 1 } });
    await expect(
      enforceRequestLimits(req("sk-a"), async () => { throw new Error("boom"); }),
    ).rejects.toThrow("boom");

    const after = await enforceRequestLimits(req("sk-a"), ok);
    expect(after.status).toBe(200);
    await after.text();
  });

  it("applies the global limit across keys", async () => {
    fx.settings = settings({ concurrency: { global: 1, perKey: 10 } });
    const { handler, enteredPromise, open } = gatedHandler();

    const inFlight = enforceRequestLimits(req("sk-a"), handler);
    await enteredPromise;

    // A different key: its own per-key budget is fine, the global one is not.
    const rejected = await enforceRequestLimits(req("sk-b"), ok);
    expect(rejected.status).toBe(503);

    open();
    const res = await inFlight;
    await res.text();
  });

  it("honours a per-key concurrency override", async () => {
    fx.settings = settings({
      concurrency: { global: 10, perKey: 1 },
      keyOverrides: { ka: { concurrency: 2 } },
    });
    const first = gatedHandler();
    const second = gatedHandler();

    const inFlightA = enforceRequestLimits(req("sk-a"), first.handler);
    await first.enteredPromise;
    const inFlightB = enforceRequestLimits(req("sk-a"), second.handler);
    await second.enteredPromise;

    // The overridden key may run two requests at once, but not three.
    expect((await enforceRequestLimits(req("sk-a"), ok)).status).toBe(503);

    // A key without an override keeps the global per-key ceiling of 1.
    const other = gatedHandler();
    const inFlightC = enforceRequestLimits(req("sk-b"), other.handler);
    await other.enteredPromise;
    expect((await enforceRequestLimits(req("sk-b"), ok)).status).toBe(503);

    first.open();
    second.open();
    other.open();
    await (await inFlightA).text();
    await (await inFlightB).text();
    await (await inFlightC).text();
  });
});
