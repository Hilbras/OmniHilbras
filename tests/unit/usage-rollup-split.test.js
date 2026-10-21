// The daily roll-up has its own write cadence.
//
// The day blob is a read-modify-write of a whole day: parsing and serialising
// it cost 4 ms for a 180 KiB day and 43 ms for a 1.2 MiB day. A batch of rows
// amortised that — a slow trickle of requests did not: every request paid for
// the whole day.
//
// So the rows and the roll-up are written separately: the rows go immediately,
// the day blob follows on its own flush. The readers merge the pending delta,
// so the numbers never move.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const originalInterval = process.env.USAGE_FLUSH_INTERVAL_MS;
const originalRollupInterval = process.env.USAGE_ROLLUP_FLUSH_INTERVAL_MS;

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
  return row ? JSON.parse(row.data) : null;
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omnihilbras-rollup-"));
  process.env.DATA_DIR = tempDir;
  // The row flush is quick, the roll-up flush never fires on its own: the
  // tests decide when it does.
  process.env.USAGE_FLUSH_INTERVAL_MS = "50";
  process.env.USAGE_ROLLUP_FLUSH_INTERVAL_MS = "600000";
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  const { getAdapter } = await import("@/lib/db/driver.js");
  adapter = await getAdapter();

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
  if (originalRollupInterval === undefined) delete process.env.USAGE_ROLLUP_FLUSH_INTERVAL_MS;
  else process.env.USAGE_ROLLUP_FLUSH_INTERVAL_MS = originalRollupInterval;
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

function record(provider, model, tokens = 10) {
  return db.saveRequestUsage({
    provider,
    model,
    connectionId: "c-rollup",
    apiKey: "sk-rollup-key-1234",
    endpoint: "/v1/chat",
    tokens: { prompt_tokens: tokens, completion_tokens: 5 },
    status: "ok",
  });
}

describe("the daily roll-up write cadence", () => {
  it("writes the row without rewriting the day", async () => {
    await db.flushUsageRollup();
    const writesBefore = dailyWrites;
    const rowsBefore = historyCount();

    record("openai", "gpt-4o");

    // The row lands with the next batch…
    await waitFor(() => historyCount() > rowsBefore, "the row to be written");
    // …and the day blob is NOT rewritten for it.
    expect(dailyWrites - writesBefore).toBe(0);
  });

  it("shows the request to the readers before the day blob has it", async () => {
    const stats = await db.getUsageStats("7d");
    expect(stats.byProvider.openai.requests).toBeGreaterThanOrEqual(1);
    // The blob does not have it yet.
    const day = readDay();
    const stored = day ? day.byProvider?.openai?.requests || 0 : 0;
    expect(stored).toBeLessThan(stats.byProvider.openai.requests);
  });

  it("writes the day once when the roll-up flushes", async () => {
    const writesBefore = dailyWrites;
    const rowsBefore = historyCount();
    record("anthropic", "claude-sonnet-4-6");
    record("mistral", "mistral-large");

    // The rows first: writing them is what creates the day aggregate.
    await waitFor(() => historyCount() > rowsBefore, "the rows to be written");
    await db.flushUsageRollup();
    // One write for the day — not one per request.
    expect(dailyWrites - writesBefore).toBe(1);

    const day = readDay();
    expect(day.byProvider.anthropic.requests).toBe(1);
    expect(day.byProvider.mistral.requests).toBe(1);
    // The earlier request is in there too.
    expect(day.byProvider.openai.requests).toBeGreaterThanOrEqual(1);
  });

  it("keeps the numbers the same across the roll-up flush", async () => {
    const before = await db.getUsageStats("7d");
    record("cohere", "command-r", 20);
    const withPending = await db.getUsageStats("7d");
    await db.flushUsageRollup();
    const after = await db.getUsageStats("7d");

    expect(withPending.totalRequests).toBe(before.totalRequests + 1);
    expect(after.totalRequests).toBe(withPending.totalRequests);
    expect(after.totalPromptTokens).toBe(withPending.totalPromptTokens);
    expect(after.totalCompletionTokens).toBe(withPending.totalCompletionTokens);
    expect(after.byProvider).toEqual(withPending.byProvider);
    expect(after.byModel).toEqual(withPending.byModel);
    expect(after.byAccount).toEqual(withPending.byAccount);
    expect(after.byApiKey).toEqual(withPending.byApiKey);
    expect(after.byEndpoint).toEqual(withPending.byEndpoint);
  });

  it("writes the roll-up on shutdown", async () => {
    const { __test__ } = await import("@/lib/db/repos/usageRepo.js");
    await db.flushUsageRollup();
    const writesBefore = dailyWrites;
    const rowsBefore = historyCount();

    record("xai", "grok-4");
    await waitFor(() => historyCount() > rowsBefore, "the row to be written");
    // The row is in the table, the day aggregate is still pending.
    expect(dailyWrites - writesBefore).toBe(0);

    __test__.flushUsageSync();
    expect(dailyWrites - writesBefore).toBe(1);
    expect(readDay().byProvider.xai.requests).toBe(1);
  });
});
