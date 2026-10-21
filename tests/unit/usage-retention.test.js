// Retention for the usage tables.
//
// usageHistory grew one row per request and nothing ever deleted one, so a
// long-running gateway accumulated rows without bound; the daily rollup grew
// one row per day forever. Both are pruned on a timer, with the window taken
// from the settings.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let retention;

const DAY_MS = 86400000;
const isoDaysAgo = (days) => new Date(Date.now() - days * DAY_MS).toISOString();

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omnihilbras-retention-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  retention = await import("@/shared/services/usageRetention.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function insertUsage(timestamp, completionTokens) {
  await db.saveRequestUsage({
    provider: "openai",
    model: "gpt-test",
    tokens: { prompt_tokens: 10, completion_tokens: completionTokens },
    timestamp,
    endpoint: "/v1/chat/completions",
    status: "success",
  });
}

describe("usage retention", () => {
  it("removes the rows older than the window and keeps the recent ones", async () => {
    const oldTimestamp = isoDaysAgo(200);
    const recentTimestamp = isoDaysAgo(2);
    await insertUsage(oldTimestamp, 11);
    await insertUsage(recentTimestamp, 12);

    const before = await db.getUsageHistory();
    expect(before.length).toBe(2);

    const result = await db.pruneUsageHistory(90, 400);
    expect(result.history).toBe(1);

    const after = await db.getUsageHistory();
    expect(after.length).toBe(1);
    expect(after[0].timestamp).toBe(recentTimestamp);
    expect(after[0].tokens.completion_tokens).toBe(12);
  });

  it("prunes the daily rollup on its own window", async () => {
    // The 200-day-old day is still inside the 400-day daily window.
    const keep = await db.pruneUsageHistory(3650, 400);
    expect(keep.daily).toBe(0);

    const prune = await db.pruneUsageHistory(3650, 30);
    expect(prune.daily).toBeGreaterThan(0);
  });

  it("takes the window from the settings", async () => {
    await db.updateSettings({ usageRetention: { enabled: true, historyDays: 1, dailyDays: 400 } });
    await insertUsage(isoDaysAgo(3), 21);

    const result = await retention.runUsageRetentionOnce();
    expect(result).not.toBeNull();

    const after = await db.getUsageHistory();
    expect(after.find((r) => r.tokens.completion_tokens === 21)).toBeUndefined();

    await db.updateSettings({ usageRetention: { enabled: true, historyDays: 90, dailyDays: 400 } });
  });

  it("does nothing when retention is switched off", async () => {
    await db.updateSettings({ usageRetention: { enabled: false, historyDays: 1, dailyDays: 1 } });
    await insertUsage(isoDaysAgo(30), 31);

    const result = await retention.runUsageRetentionOnce();
    expect(result).toBeNull();

    const after = await db.getUsageHistory();
    expect(after.find((r) => r.tokens.completion_tokens === 31)).toBeDefined();

    await db.updateSettings({ usageRetention: { enabled: true, historyDays: 90, dailyDays: 400 } });
  });
});
