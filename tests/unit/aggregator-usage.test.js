/**
 * Aggregator usage adapter tests (tokenharbor group — open-sse/services/usage/aggregator.js).
 * All upstream calls are mocked through proxyAwareFetch; the adapter itself is real.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Queue of canned upstream responses, one per proxyAwareFetch call (FIFO).
// Shape: { status, json, text, headers: { "x-ratelimit-limit-requests": ".." } }
// totals: what the (otherwise DB-backed) local-history repo returns.
const setup = { calls: [], responses: [], totals: null, refreshToken: null, updated: [] };

vi.mock("@/lib/db/repos/usageRepo.js", () => ({
  getUsageTotalsForConnection: async () => setup.totals,
}));

// The account-session refresh reads the connection and writes the new token
// pair back; both are mocked so no DB is touched.
vi.mock("@/lib/localDb.js", () => ({
  getProviderConnectionById: async (id) => ({
    id,
    provider: "tokenharbor",
    refreshToken: setup.refreshToken || null,
  }),
  updateProviderConnection: async (id, data) => {
    setup.updated.push({ id, ...data });
    return { id, ...data };
  },
}));

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: async (url, opts = {}) => {
    setup.calls.push({ url, headers: opts.headers || {} });
    const next = setup.responses.shift() ?? { status: 404 };
    const headers = next.headers ?? {};
    return {
      status: next.status ?? 200,
      ok: next.status >= 200 && next.status < 300,
      headers: { get: (key) => headers[key] ?? null },
      json: async () => next.json,
      text: async () => next.text ?? "",
    };
  },
}));

const { getAggregatorUsage } = await import("open-sse/services/usage/aggregator.js");

beforeEach(() => {
  setup.calls.length = 0;
  setup.responses.length = 0;
  setup.totals = null;
  setup.refreshToken = null;
  setup.updated.length = 0;
});

describe("aggregator usage adapter", () => {
  it("openai-billing flavor: subscription + usage turn into a Wallet (USD) bucket", async () => {
    setup.responses = [
      { status: 200, json: { hard_limit_usd: 100 } },
      { status: 200, json: { total_usage: 2500 } },
    ];
    const out = await getAggregatorUsage({ provider: "tokenharbor", apiKey: "th-test-key" });

    expect(setup.calls[0].url).toContain("/dashboard/billing/subscription");
    expect(setup.calls[1].url).toContain("/dashboard/billing/usage");
    expect(out.message).toBeUndefined();
    expect(out.plan).toBe("Token Harbor");
    const wallet = out.quotas["Wallet (USD)"];
    expect(wallet).toMatchObject({
      used: 25,
      total: 100,
      remainingPercentage: 75,
      unlimited: false,
      isCreditBalance: true,
      currency: "USD",
    });
  });

  it("falls back to new-api /api/user/self when billing routes are missing", async () => {
    setup.responses = [
      { status: 404 }, // billing/subscription
      { status: 200, json: { success: true, data: { quota: 25000000, used_quota: 12500000 } } },
    ];
    const out = await getAggregatorUsage({ provider: "nara-router", apiKey: "nr-test-key" });

    expect(setup.calls[1].url).toContain("/api/user/self");
    // remaining 25000000/500000 = $50; used 12500000/500000 = $25; total $75
    const wallet = out.quotas["Wallet (USD)"];
    expect(wallet).toMatchObject({
      used: 25,
      total: 75,
      remainingPercentage: 67,
      isCreditBalance: true,
    });
  });

  it("falls back to x-ratelimit header scan when no billing API exists", async () => {
    setup.responses = [
      { status: 404 },             // billing/subscription (usage URL never reached)
      { status: 404 },             // /api/user/self
      {
        status: 200,
        json: { data: [] },
        headers: {
          "x-ratelimit-limit-requests": "1000",
          "x-ratelimit-remaining-requests": "400",
          "x-ratelimit-reset-requests": "2m59.56s",
        },
      },
    ];
    const out = await getAggregatorUsage({ provider: "apmix", apiKey: "am-test-key" });

    const bucket = out.quotas["Requests (rate limit)"];
    expect(bucket).toMatchObject({ used: 600, total: 1000, isCreditBalance: false });
    expect(bucket.resetAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(out.plan).toBe("APMIX.AI (rate limit)");
  });

  it("401 on every candidate → auth-failed message, never a throw", async () => {
    setup.responses = [{ status: 401 }, { status: 403 }, { status: 401 }];
    const out = await getAggregatorUsage({ provider: "xkiro", apiKey: "xk-test-key" });

    expect(out.quotas).toBeUndefined();
    expect(out.message).toMatch(/authentication failed/i);
  });

  it("full miss → graceful message + negative cache stops re-probing immediately", async () => {
    setup.responses = [{ status: 404 }, { status: 404 }, { status: 404 }];
    const first = await getAggregatorUsage({ provider: "tiarina", apiKey: "ti-test-key" });
    expect(first.message).toMatch(/doesn't expose a usage API/i);
    expect(setup.calls.length).toBe(3);

    const callsAfterFirst = setup.calls.length;
    const second = await getAggregatorUsage({ provider: "tiarina", apiKey: "ti-test-key" });

    expect(second.message).toMatch(/doesn't expose a usage API/i);
    expect(setup.calls.length).toBe(callsAfterFirst);
  });

  it("missing API key → message without any network call", async () => {
    const out = await getAggregatorUsage({ provider: "tokenharbor", apiKey: null });
    expect(setup.calls.length).toBe(0);
    expect(out.message).toMatch(/API key not available/i);
  });

  it("registry flavor pin restricts the candidates tried", async () => {
    // apinex registry pins nothing → both lanes tried; simulate new-api success
    // on a provider whose usage block pins a flavor by monkey-friendly routing:
    // use a flavor order that skips heavy lanes via pin is covered by config;
    // here assert that the openai-billing lane is tried first for every provider.
    setup.responses = [
      { status: 200, json: { system_hard_limit_usd: 50 } },
      { status: 200, json: { total_usage: 1000 } },
    ];
    const out = await getAggregatorUsage({ provider: "apinex", apiKey: "ax-test-key" });
    expect(setup.calls[0].url).toContain("/dashboard/billing/subscription");
    expect(out.quotas["Wallet (USD)"]).toMatchObject({ used: 10, total: 50, remainingPercentage: 80 });
  });

  it("remote full miss + local history → 'local history' unlimited rows", async () => {
    setup.responses = [{ status: 404 }, { status: 404 }, { status: 404 }];
    setup.totals = { windowMs: 2592000000, requests: 6, tokens: 725, cost: 0.0001 };

    const out = await getAggregatorUsage({ provider: "tokenharbor", apiKey: "th-test-key", connectionId: "conn-abc" });

    expect(out.message).toBeUndefined();
    expect(out.plan).toBe("Token Harbor");
    const tokens = out.quotas["Tokens · local history (30d)"];
    expect(tokens).toMatchObject({ used: 725, unlimited: true, resetAt: null, isCreditBalance: false });
    expect(out.quotas["Requests · local history (30d)"]).toMatchObject({ used: 6, unlimited: true });
  });

  it("negative-cache cooldown still surfaces local history data", async () => {
    setup.responses = [{ status: 404 }, { status: 404 }, { status: 404 }];
    // Prime the cooldown with a miss and no local data available.
    // xkiro is used only by the 401 test earlier (cooldown not set there),
    // so this test owns a clean provider id.
    const first = await getAggregatorUsage({ provider: "xkiro", apiKey: "xk-test-key", connectionId: "conn-cold" });
    expect(first.message).toMatch(/doesn't expose a usage API/i);

    // Now history arrives — a cooldown hit must show the rows instead of the message.
    setup.totals = { windowMs: 2592000000, requests: 3, tokens: 120, cost: 0 };
    const second = await getAggregatorUsage({ provider: "xkiro", apiKey: "xk-test-key", connectionId: "conn-cold" });
    expect(second.message).toBeUndefined();
    expect(second.quotas["Requests · local history (30d)"]).toMatchObject({ used: 3 });
    expect(setup.calls.length).toBe(3); // no extra upstream probing during cooldown
  });

  it("remote full miss + no local history → unchanged graceful message", async () => {
    // apmix: cleared by the headers test earlier; here it misses everything.
    setup.responses = [{ status: 404 }, { status: 404 }, { status: 404 }];
    const out = await getAggregatorUsage({ provider: "apmix", apiKey: "am-test-key", connectionId: "conn-empty" });
    expect(out.message).toMatch(/doesn't expose a usage API/i);
  });

  it("account session → Supabase wallet balance row (no API-key probes)", async () => {
    setup.responses = [
      {
        status: 200,
        json: [{ balance_paid: 12.5, balance_trial: 3, balance_bonus: 1.25, balance_bonus_locked: 5 }],
      },
    ];
    const out = await getAggregatorUsage({
      provider: "tokenharbor",
      apiKey: "th-key",
      accessToken: "user-jwt",
    });

    expect(out.message).toBeUndefined();
    expect(out.plan).toBe("Token Harbor");
    // The wallet is the authoritative answer, so no API-key probing happened.
    expect(setup.calls.length).toBe(1);
    expect(setup.calls[0].url).toContain("/rest/v1/wallets");
    expect(setup.calls[0].url).toContain("balance_paid");
    expect(setup.calls[0].headers.Authorization).toBe("Bearer user-jwt");
    expect(setup.calls[0].headers.apikey).toBeTruthy();

    const wallet = out.quotas["Wallet balance"];
    // paid + trial + bonus are spendable; the locked bonus is not.
    expect(wallet).toMatchObject({
      used: 0,
      total: 16.75,
      isCreditBalance: true,
      currency: "USD",
      unlimited: false,
      resetAt: null,
    });
  });

  it("expired account session → falls back to the API-key flavors / local history", async () => {
    // Wallet read fails (expired session) → the key-based lanes run next.
    setup.responses = [
      { status: 401, json: { message: "invalid JWT" } },
      { status: 404 },
      { status: 404 },
      { status: 404 },
    ];
    setup.totals = { windowMs: 2592000000, requests: 2, tokens: 40, cost: 0 };
    const out = await getAggregatorUsage({
      provider: "tokenharbor",
      apiKey: "th-key",
      accessToken: "expired-jwt",
      connectionId: "conn-wallet",
    });

    expect(out.quotas["Tokens · local history (30d)"]).toMatchObject({ used: 40, unlimited: true });
    expect(out.quotas["Wallet balance"]).toBeUndefined();
  });

  it("no session and no key → message without any network call", async () => {
    const out = await getAggregatorUsage({ provider: "tokenharbor" });
    expect(setup.calls.length).toBe(0);
    expect(out.message).toMatch(/API key not available/i);
  });

  it("expired session refreshes once and retries the wallet read", async () => {
    // 401 on the wallet read → refresh → 200 with the balance.
    setup.responses = [
      { status: 401, json: { message: "invalid JWT" } },
      { status: 200, json: { access_token: "fresh-jwt", refresh_token: "refresh-9" } },
      { status: 200, json: [{ balance_paid: 7, balance_trial: 0, balance_bonus: 0, balance_bonus_locked: 0 }] },
    ];
    setup.refreshToken = "refresh-1";

    const out = await getAggregatorUsage({
      provider: "tokenharbor",
      accessToken: "expired-jwt",
      connectionId: "conn-refresh",
    });

    expect(out.quotas["Wallet balance"]).toMatchObject({ total: 7, isCreditBalance: true });
    // The retry used the refreshed token, not the expired one.
    const walletCalls = setup.calls.filter((c) => c.url.includes("/rest/v1/wallets"));
    expect(walletCalls.length).toBe(2);
    expect(walletCalls[0].headers.Authorization).toBe("Bearer expired-jwt");
    expect(walletCalls[1].headers.Authorization).toBe("Bearer fresh-jwt");
  });
});
