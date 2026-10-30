// Per-saver savings aggregation.
//
// The stats endpoint answers "is this saver actually saving anything?" — the
// question nobody could answer before, because the numbers only ever reached a
// console line. These tests pin the aggregation contract: pending rows count,
// rows without telemetry are counted separately from rows with zero savings,
// and per-saver / per-provider attribution stays additive.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

const DAY_MS = 86400000;
const isoDaysAgo = (days) => new Date(Date.now() - days * DAY_MS).toISOString();

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omnihilbras-saverstats-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function record({ provider = "codebuddy-intl", model = "glm-5.2", tokens, meta, daysAgo = 0 }) {
  await db.saveRequestUsage({
    provider,
    model,
    tokens,
    meta,
    timestamp: isoDaysAgo(daysAgo),
    endpoint: "/v1/chat/completions",
    status: "success",
  });
}

function saverMeta(entries, cache) {
  const saver = {};
  let totalBytesSaved = 0;
  let totalTokensSaved = 0;
  for (const [id, e] of Object.entries(entries)) {
    const bytesSaved = Math.max(0, (e.bytesBefore || 0) - (e.bytesAfter || 0));
    const tokensSaved = Math.ceil(bytesSaved / 4);
    saver[id] = {
      bytesBefore: e.bytesBefore || 0,
      bytesAfter: e.bytesAfter || 0,
      bytesSaved,
      tokensSaved,
      units: e.units || 0,
      detail: e.detail ?? null,
    };
    totalBytesSaved += bytesSaved;
    totalTokensSaved += tokensSaved;
  }
  const out = { saver, totalBytesSaved, totalTokensSaved };
  if (cache) out.cache = cache;
  return out;
}

describe("token saver stats", () => {
  it("aggregates savings per saver and per provider", async () => {
    await record({
      tokens: { prompt_tokens: 1000, completion_tokens: 100 },
      meta: saverMeta({ rtk: { bytesBefore: 4000, bytesAfter: 1000, units: 3 } }),
    });
    await record({
      tokens: { prompt_tokens: 2000, completion_tokens: 200 },
      meta: saverMeta({ rtk: { bytesBefore: 2000, bytesAfter: 500, units: 1 } }),
    });
    await record({
      provider: "anthropic",
      model: "claude-sonnet-4.5",
      tokens: { prompt_tokens: 500, completion_tokens: 50 },
      meta: saverMeta({ historyTrim: { bytesBefore: 8000, bytesAfter: 100, units: 6 } }),
    });

    const stats = await db.getTokenSaverStats("all");

    expect(stats.requestsWithTelemetry).toBe(3);
    expect(stats.requestsWithSavings).toBe(3);

    const rtk = stats.savers.find((s) => s.id === "rtk");
    expect(rtk.bytesBefore).toBe(6000);
    expect(rtk.bytesAfter).toBe(1500);
    expect(rtk.bytesSaved).toBe(4500);
    expect(rtk.requests).toBe(2);
    expect(rtk.units).toBe(4);

    const trim = stats.savers.find((s) => s.id === "historyTrim");
    expect(trim.bytesSaved).toBe(7900);

    // Savers are ordered by what they saved.
    expect(stats.savers[0].id).toBe("historyTrim");

    const byProvider = Object.fromEntries(stats.byProvider.map((p) => [p.provider, p]));
    expect(byProvider["codebuddy-intl"].bytesSaved).toBe(4500);
    expect(byProvider.anthropic.bytesSaved).toBe(7900);
  });

  it("counts rows without telemetry separately from zero-savings rows", async () => {
    const before = await db.getTokenSaverStats("all");

    // A pre-telemetry row: no meta at all.
    await record({ tokens: { prompt_tokens: 10, completion_tokens: 1 } });
    // A row where a saver ran and matched nothing.
    await record({
      tokens: { prompt_tokens: 10, completion_tokens: 1 },
      meta: saverMeta({ rtk: { bytesBefore: 100, bytesAfter: 100, units: 0, detail: [] } }),
    });

    const after = await db.getTokenSaverStats("all");
    expect(after.requests - before.requests).toBe(2);
    expect(after.requestsWithTelemetry - before.requestsWithTelemetry).toBe(1);
    expect(after.requestsWithSavings - before.requestsWithSavings).toBe(0);

    // The "ran but matched nothing" saver is still listed, at zero.
    const rtk = after.savers.find((s) => s.id === "rtk");
    expect(rtk).toBeDefined();
    expect(rtk.requestsWithSavings).toBe(2); // from the first test only
  });

  it("surfaces cache read/create figures and a hit rate", async () => {
    await record({
      tokens: { prompt_tokens: 100, completion_tokens: 10 },
      meta: saverMeta({}, { read: 300, create: 100 }),
    });

    const stats = await db.getTokenSaverStats("all");
    expect(stats.cache.read).toBeGreaterThanOrEqual(300);
    expect(stats.cache.create).toBeGreaterThanOrEqual(100);
    expect(stats.cacheHitRate).toBeGreaterThan(0);
    expect(stats.cacheHitRate).toBeLessThanOrEqual(1);
  });

  it("collects the detail values that explain a saver's behaviour", async () => {
    await record({
      tokens: { prompt_tokens: 100, completion_tokens: 10 },
      meta: saverMeta({ rtk: { bytesBefore: 500, bytesAfter: 100, units: 2, detail: ["grep", "ls"] } }),
    });
    const stats = await db.getTokenSaverStats("all");
    const rtk = stats.savers.find((s) => s.id === "rtk");
    expect(rtk.details["grep,ls"]).toBeGreaterThanOrEqual(1);
  });

  it("honours the period window", async () => {
    await record({
      tokens: { prompt_tokens: 100, completion_tokens: 10 },
      meta: saverMeta({ rtk: { bytesBefore: 9000, bytesAfter: 1000, units: 1 } }),
      daysAgo: 45,
    });

    const all = await db.getTokenSaverStats("all");
    const week = await db.getTokenSaverStats("7d");
    expect(all.totalBytesSaved).toBeGreaterThan(week.totalBytesSaved);
    expect(week.since).toBeTruthy();
    expect(new Date(week.since).getTime()).toBeLessThan(Date.now());
    expect((await db.getTokenSaverStats("all")).since).toBeNull();
  });

  it("returns a stable shape for an empty database", async () => {
    const stats = await db.getTokenSaverStats("today");
    expect(Array.isArray(stats.savers)).toBe(true);
    expect(Array.isArray(stats.byProvider)).toBe(true);
    expect(typeof stats.requests).toBe("number");
    expect(typeof stats.totalBytesSaved).toBe("number");
    expect(typeof stats.estimatedCostAvoided).toBe("number");
  });
});
