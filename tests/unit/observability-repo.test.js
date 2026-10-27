// Repo + helpers behind /api/observability/*.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { parseLogFilter, redactPayloads, toCsv, toJsonl } from "@/lib/observability/logQuery.js";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

function insert(adapter, row) {
  adapter.run(
    `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.timestamp, row.provider, row.model, row.connectionId || null, row.status, JSON.stringify(row)]
  );
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omnihilbras-observability-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.updateSettings({ enableObservability: true });
  db.invalidateObservabilityConfig();

  const { getAdapter } = await import("@/lib/db/driver.js");
  const adapter = await getAdapter();
  const now = Date.now();
  insert(adapter, {
    id: "a", timestamp: new Date(now - 60_000).toISOString(), provider: "openai", model: "gpt-4", status: "success",
    latency: { total: 100 }, tokens: { prompt_tokens: 10, completion_tokens: 5 },
  });
  insert(adapter, {
    id: "b", timestamp: new Date(now - 120_000).toISOString(), provider: "openai", model: "gpt-4", status: "error",
    latency: { total: 300 }, tokens: {},
  });
  insert(adapter, {
    id: "c", timestamp: new Date(now - 3 * 86400_000).toISOString(), provider: "claude", model: "sonnet", status: "success",
    latency: { total: 200 }, tokens: { input_tokens: 7, output_tokens: 3 },
  });
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("observability stats", () => {
  it("24h window counts only recent rows, with error rate and per-provider groups", async () => {
    const s = await db.getObservabilityStats("24h");
    expect(s.requests).toBe(2);
    expect(s.errors).toBe(1);
    expect(s.errorRate).toBe(0.5);
    expect(s.promptTokens).toBe(10);
    expect(s.completionTokens).toBe(5);
    expect(s.avgLatency).toBe(200);
    expect(s.byProvider).toEqual([{ key: "openai", requests: 2, errors: 1, tokens: 15, avgLatency: 200 }]);
    expect(s.retention.records).toBe(3);
  });

  it("all period includes input_tokens/output_tokens shapes", async () => {
    const s = await db.getObservabilityStats("all");
    expect(s.period).toBe("all");
    expect(s.requests).toBe(3);
    expect(s.promptTokens).toBe(17);
    expect(s.completionTokens).toBe(8);
  });
});

describe("observability deletes and filters", () => {
  it("filters by model and status", async () => {
    const res = await db.getRequestLogEntries({ model: "gpt-4", status: "error" });
    expect(res.details.map((d) => d.id)).toEqual(["b"]);
  });

  it("distinct facets", async () => {
    expect(await db.getDistinctModels()).toEqual(["gpt-4", "sonnet"]);
  });

  it("deleteRequestLogsBefore removes only older rows", async () => {
    const deleted = await db.deleteRequestLogsBefore(new Date(Date.now() - 86400_000));
    expect(deleted).toBe(1);
    expect(await db.getRequestLogDetailById("c")).toBeNull();
  });

  it("deleteRequestLogBatch and deleteRequestLogById", async () => {
    expect(await db.deleteRequestLogBatch(["a", "missing"])).toBe(1);
    expect(await db.deleteRequestLogById("b")).toBe(true);
    expect(await db.deleteRequestLogById("b")).toBe(false);
  });
});

describe("logQuery helpers", () => {
  it("redacts every payload field but keeps metadata", () => {
    const out = redactPayloads({ id: "x", model: "m", request: { messages: [] }, response: { content: "secret" } });
    expect(out).toEqual({ id: "x", model: "m", request: { redacted: true }, response: { redacted: true } });
  });

  it("rejects invalid dates and skips empty values", () => {
    expect(parseLogFilter(new URLSearchParams("startDate=nope")).error).toMatch(/startDate/);
    expect(parseLogFilter({ provider: "", model: "gpt-4" }).filter).toEqual({ model: "gpt-4" });
  });

  it("CSV escapes quotes and commas; JSONL is one object per line", () => {
    const rows = [{ id: "1", model: 'a,"b"', tokens: { input_tokens: 4 } }];
    const csv = toCsv(rows).split("\n");
    expect(csv[0]).toMatch(/^timestamp,id,provider,model/);
    expect(csv[1]).toContain('"a,""b"""');
    expect(csv[1]).toContain(",4,");
    expect(toJsonl(rows)).toBe(JSON.stringify(rows[0]) + "\n");
    expect(toJsonl([])).toBe("");
  });
});
