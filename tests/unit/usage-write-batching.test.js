// The usage write path: a completed request is recorded in memory and
// written with the next batch.
//
// The properties under test:
//   a) the readers see a request before its row is written — the in-memory
//      path stays immediate, the dashboard never lags behind the gateway,
//   b) the buffered rows reach the database: when the batch is full, and on
//      an explicit flush (the shutdown path uses the same call),
//   c) the daily roll-up holds exactly the numbers of the requests, before
//      and after the flush — and the blob is written once per batch, not
//      once per request.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const originalInterval = process.env.USAGE_FLUSH_INTERVAL_MS;
const originalMaxRows = process.env.USAGE_FLUSH_MAX_ROWS;

let tempDir;
let db;
let adapter;
let dailyWrites = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function historyCount() {
  return adapter.get(`SELECT COUNT(*) c FROM usageHistory`).c;
}

function readDay() {
  const row = adapter.get(`SELECT data FROM usageDaily WHERE dateKey = ?`, [todayKey()]);
  return row ? JSON.parse(row.data) : { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
}

// The tests decide when a batch is written: the interval never fires (the
// flush is called explicitly), the threshold does.
beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omnihilbras-usage-batch-"));
  process.env.DATA_DIR = tempDir;
  process.env.USAGE_FLUSH_INTERVAL_MS = "600000";
  process.env.USAGE_FLUSH_MAX_ROWS = "5";
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  const { getAdapter } = await import("@/lib/db/driver.js");
  adapter = await getAdapter();

  // Count the writes of the daily roll-up: one per batch is the point.
  const originalRun = adapter.run.bind(adapter);
  adapter.run = (sql, params) => {
    if (/INSERT INTO usageDaily/i.test(sql)) dailyWrites += 1;
    return originalRun(sql, params);
  };
});

afterAll(() => {
  try { adapter?.close?.(); } catch {}
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalInterval === undefined) delete process.env.USAGE_FLUSH_INTERVAL_MS;
  else process.env.USAGE_FLUSH_INTERVAL_MS = originalInterval;
  if (originalMaxRows === undefined) delete process.env.USAGE_FLUSH_MAX_ROWS;
  else process.env.USAGE_FLUSH_MAX_ROWS = originalMaxRows;
});

async function waitFor(check, what, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

describe("usage write batching", () => {
  it("shows a recorded request to the readers before the row is written", async () => {
    const before = historyCount();
    const recorded = db.saveRequestUsage({
      provider: "openai", model: "gpt-4", connectionId: "c-live",
      apiKey: "sk-live-key-1234", endpoint: "/v1/chat/completions",
      tokens: { prompt_tokens: 12, completion_tokens: 3 }, status: "ok",
    });

    const history = await waitFor(
      async () => {
        const rows = await db.getUsageHistory({ provider: "openai" });
        return rows.length ? rows : null;
      },
      "the request to show up in the history"
    );
    expect(history.length).toBe(1);
    expect(history[0].model).toBe("gpt-4");
    expect(history[0].tokens.completion_tokens).toBe(3);
    // The key is masked — the history never hands out a credential.
    expect(history[0].apiKeyMasked).toBeTruthy();
    expect(history[0].apiKey).toBeUndefined();

    // The row is still in memory: the batch has not been written yet.
    expect(historyCount()).toBe(before);

    const stats = await db.getUsageStats("24h");
    expect(stats.byProvider.openai.requests).toBe(1);
    expect(stats.totalPromptTokens).toBe(12);

    await db.flushUsage();
    await recorded;
    expect(historyCount()).toBe(before + 1);
  });

  it("writes the buffered rows when the batch is full", async () => {
    const before = historyCount();
    const rollupWrites = dailyWrites;
    const writes = [];
    const base = Date.now();

    for (let i = 0; i < 5; i++) {
      writes.push(db.saveRequestUsage({
        timestamp: new Date(base + i).toISOString(),
        provider: "anthropic", model: "claude-sonnet-4-6", connectionId: "c-batch",
        tokens: { prompt_tokens: 10, completion_tokens: 5 }, status: "ok",
      }));
    }

    await waitFor(() => historyCount() >= before + 5, "the batch to be written");
    expect(historyCount()).toBe(before + 5);
    // The day blob is NOT written by the row batch: it has its own cadence,
    // because rewriting the whole day per batch is what made a trickle of
    // requests expensive.
    expect(dailyWrites - rollupWrites).toBe(0);

    // The roll-up flush writes it once — for the whole batch.
    await db.flushUsageRollup();
    expect(dailyWrites - rollupWrites).toBe(1);
    await Promise.all(writes);
  });

  it("writes the buffered rows on an explicit flush", async () => {
    const before = historyCount();
    const recorded = db.saveRequestUsage({
      provider: "google", model: "gemini-2.5-pro", connectionId: "c-flush",
      tokens: { prompt_tokens: 7, completion_tokens: 4 }, status: "ok",
    });

    await waitFor(
      async () => ((await db.getUsageHistory({ provider: "google" })).length ? true : null),
      "the request to show up in the history"
    );
    expect(historyCount()).toBe(before);

    await db.flushUsage();
    expect(historyCount()).toBe(before + 1);
    await recorded;
  });

  it("writes the buffered rows when the process shuts down", async () => {
    const before = historyCount();
    const { __test__ } = await import("@/lib/db/repos/usageRepo.js");
    const recorded = db.saveRequestUsage({
      provider: "xai", model: "grok-4", connectionId: "c-exit",
      tokens: { prompt_tokens: 3, completion_tokens: 2 }, status: "ok",
    });

    await waitFor(
      async () => ((await db.getUsageHistory({ provider: "xai" })).length ? true : null),
      "the request to show up in the history"
    );
    expect(historyCount()).toBe(before);

    // The shutdown hooks cannot await: they write what is left, synchronously.
    expect(__test__.flushUsageSync()).toBe(1);
    expect(historyCount()).toBe(before + 1);
    await recorded;
  });

  it("rolls the day up exactly like the un-batched computation", async () => {
    const requests = [
      { provider: "cohere", model: "command-r", connectionId: "c-roll-1", apiKey: "sk-roll-aaaa-1111", endpoint: "/v1/chat", tokens: { prompt_tokens: 10, completion_tokens: 5 } },
      { provider: "cohere", model: "command-r-plus", connectionId: "c-roll-1", apiKey: "sk-roll-aaaa-1111", endpoint: "/v1/chat", tokens: { prompt_tokens: 20, completion_tokens: 7 } },
      { provider: "mistral", model: "mistral-large", connectionId: "c-roll-2", apiKey: "sk-roll-bbbb-2222", endpoint: "/v1/chat", tokens: { prompt_tokens: 30, completion_tokens: 9, cached_tokens: 12 } },
      { provider: "mistral", model: "mistral-large", connectionId: "c-roll-2", apiKey: "sk-roll-bbbb-2222", endpoint: "/v1/chat", tokens: { prompt_tokens: 5, completion_tokens: 2 } },
    ];

    // The day blob has its own cadence: what the earlier tests left in the
    // roll-up buffer is written first, so the baseline is the stored day.
    await db.flushUsageRollup();
    const dayBefore = readDay();
    const writes = requests.map((r) => db.saveRequestUsage(r));

    await waitFor(
      async () => ((await db.getUsageHistory()).length >= requests.length ? true : null),
      "the requests to show up in the history"
    );

    // What the readers show while the batch is still in memory...
    const before = await db.getUsageStats("7d");
    // ...and what they show once the batch is written.
    await db.flushUsage();
    await Promise.all(writes);
    const afterRows = await db.getUsageStats("7d");

    expect(afterRows.totalRequests).toBe(before.totalRequests);
    expect(afterRows.totalPromptTokens).toBe(before.totalPromptTokens);
    expect(afterRows.totalCompletionTokens).toBe(before.totalCompletionTokens);
    expect(afterRows.totalCachedTokens).toBe(before.totalCachedTokens);
    expect(afterRows.totalCost).toBe(before.totalCost);
    expect(afterRows.byProvider).toEqual(before.byProvider);
    expect(afterRows.byModel).toEqual(before.byModel);
    expect(afterRows.byAccount).toEqual(before.byAccount);
    expect(afterRows.byApiKey).toEqual(before.byApiKey);
    expect(afterRows.byEndpoint).toEqual(before.byEndpoint);

    // The day blob follows on its own flush — and the numbers do not move.
    await db.flushUsageRollup();
    const after = await db.getUsageStats("7d");
    expect(after.totalRequests).toBe(before.totalRequests);
    expect(after.totalPromptTokens).toBe(before.totalPromptTokens);
    expect(after.totalCompletionTokens).toBe(before.totalCompletionTokens);
    expect(after.totalCachedTokens).toBe(before.totalCachedTokens);
    expect(after.totalCost).toBe(before.totalCost);
    expect(after.byProvider).toEqual(before.byProvider);
    expect(after.byModel).toEqual(before.byModel);
    expect(after.byAccount).toEqual(before.byAccount);
    expect(after.byApiKey).toEqual(before.byApiKey);
    expect(after.byEndpoint).toEqual(before.byEndpoint);

    // The roll-up of the four requests, counted from the day the flush wrote.
    const dayAfter = readDay();
    expect(dayAfter.requests - dayBefore.requests).toBe(4);
    expect(dayAfter.promptTokens - dayBefore.promptTokens).toBe(65);
    expect(dayAfter.completionTokens - dayBefore.completionTokens).toBe(23);
    expect(dayAfter.cachedTokens - dayBefore.cachedTokens).toBe(12);
    expect(dayAfter.byProvider.cohere.requests).toBe(2);
    expect(dayAfter.byProvider.cohere.promptTokens).toBe(30);
    expect(dayAfter.byProvider.cohere.completionTokens).toBe(12);
    expect(dayAfter.byProvider.mistral.requests).toBe(2);
    expect(dayAfter.byProvider.mistral.promptTokens).toBe(35);
    expect(dayAfter.byProvider.mistral.completionTokens).toBe(11);
    expect(dayAfter.byProvider.mistral.cachedTokens).toBe(12);

    // And the same numbers in the stats the dashboard reads.
    expect(after.byProvider.cohere.requests).toBe(2);
    expect(after.byProvider.cohere.promptTokens).toBe(30);
    expect(after.byProvider.cohere.completionTokens).toBe(12);
    expect(after.byProvider.mistral.requests).toBe(2);
    expect(after.byProvider.mistral.promptTokens).toBe(35);
    expect(after.byProvider.mistral.cachedTokens).toBe(12);
  });
});
