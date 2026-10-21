// Gateway API keys are stored as a hash plus a display form.
//
// The property under test: a stolen database holds no usable key, while
// every key — the ones that existed before the change and the ones created
// after it — keeps authenticating, keeps its name in the usage stats, and
// keeps its access rules.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

// sk-{machineId}-{keyId}-{crc} — the current key format.
const LEGACY_KEY = "sk-abcdef0123456789-XyZwVuTsRqPoNmLkIjHgFdCb-1a2b3c4d";

// The apiKeys DDL as it was before the key hash, plus a stamped v1 _meta —
// and the usage rows, which held the raw key as well.
function writeLegacyDb(dir) {
  fs.mkdirSync(path.join(dir, "db"), { recursive: true });
  const db = new DatabaseSync(path.join(dir, "db", "data.sqlite"));
  db.exec(`CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.exec(`INSERT INTO _meta(key, value) VALUES ('schemaVersion', '1'), ('backupSchemaVersion', '1')`);
  db.exec(`CREATE TABLE apiKeys (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT, machineId TEXT, isActive INTEGER DEFAULT 1, createdAt TEXT NOT NULL)`);
  const ins = db.prepare(`INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES (?, ?, ?, ?, ?, ?)`);
  ins.run("k1", LEGACY_KEY, "Legacy Key", "machine-1", 1, "2026-09-01T00:00:00.000Z");
  db.exec(`CREATE TABLE usageHistory (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, provider TEXT, model TEXT, connectionId TEXT, apiKey TEXT, endpoint TEXT, promptTokens INTEGER DEFAULT 0, completionTokens INTEGER DEFAULT 0, cost REAL DEFAULT 0, status TEXT, tokens TEXT, meta TEXT)`);
  db.prepare(`INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
              VALUES (?, 'openai', 'gpt-4', 'c1', ?, '/v1/chat', 7, 3, 0, 'ok', '{}', '{}')`)
    .run("2026-09-01T00:00:00.000Z", LEGACY_KEY);
  db.exec(`CREATE TABLE usageDaily (dateKey TEXT PRIMARY KEY, data TEXT NOT NULL)`);
  db.prepare(`INSERT INTO usageDaily(dateKey, data) VALUES (?, ?)`).run("2026-09-01", JSON.stringify({
    requests: 1, promptTokens: 7, completionTokens: 3, cost: 0,
    byProvider: {}, byModel: {}, byAccount: {},
    byApiKey: { [`${LEGACY_KEY}|gpt-4|openai`]: { requests: 1, promptTokens: 7, completionTokens: 3, cost: 0, rawModel: "gpt-4", provider: "openai", apiKey: LEGACY_KEY } },
    byEndpoint: {},
  }));
  db.close();
}

async function boot() {
  delete global._dbAdapter;
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  const { getAdapter } = await import("@/lib/db/driver.js");
  const { maskApiKey } = await import("@/lib/db/helpers/maskApiKey.js");
  return { db, adapter: await getAdapter(), maskApiKey };
}

// Every byte the install keeps on disk — the database and its WAL sidecars.
function databaseBytes() {
  const dir = path.join(tempDir, "db");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.startsWith("data.sqlite"))
    .map((f) => fs.readFileSync(path.join(dir, f)));
}

function plaintextOnDisk(text) {
  const needle = Buffer.from(text, "utf-8");
  return databaseBytes().some((buf) => buf.includes(needle));
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omnihilbras-key-hash-"));
  process.env.DATA_DIR = tempDir;
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("apiKeys: the secret leaves the database", () => {
  it("a key created before the change still authenticates, and its row holds no plaintext", async () => {
    writeLegacyDb(tempDir);
    const { db, adapter, maskApiKey } = await boot();

    expect(await db.validateApiKey(LEGACY_KEY)).toBe(true);
    expect((await db.getApiKeyByKey(LEGACY_KEY)).id).toBe("k1");

    const row = adapter.get(`SELECT * FROM apiKeys WHERE id = ?`, ["k1"]);
    expect(row.key).toBe(maskApiKey(LEGACY_KEY));
    expect(row.key).not.toBe(LEGACY_KEY);
    expect(row.keyHash).toMatch(/^[0-9a-f]{64}$/);

    // The usage rows held the raw key too — they were rewritten as well.
    expect(adapter.get(`SELECT apiKey FROM usageHistory LIMIT 1`).apiKey).toBe(maskApiKey(LEGACY_KEY));
    const day = JSON.parse(adapter.get(`SELECT data FROM usageDaily LIMIT 1`).data);
    expect(Object.values(day.byApiKey)[0].apiKey).toBe(maskApiKey(LEGACY_KEY));

    // Not a byte of the key is left in the file.
    expect(plaintextOnDisk(LEGACY_KEY)).toBe(false);
  });

  it("a row that still holds its plaintext is found and healed on first use", async () => {
    const { db, adapter, maskApiKey } = await boot();

    // A row written by an older build after the migration already ran: no
    // hash, the secret in the clear.
    adapter.run(
      `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES (?, ?, ?, ?, 1, ?)`,
      ["k1", LEGACY_KEY, "Legacy Key", "machine-1", "2026-09-01T00:00:00.000Z"]
    );
    expect(await db.validateApiKey(LEGACY_KEY)).toBe(true);

    const row = adapter.get(`SELECT * FROM apiKeys WHERE id = ?`, ["k1"]);
    expect(row.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.key).toBe(maskApiKey(LEGACY_KEY));
    // The row no longer holds the secret. The freed page still holds its
    // bytes until the database is compacted — the heal asks for that at the
    // next boot.
    expect(adapter.get(`SELECT value FROM _meta WHERE key = 'needsCompaction'`).value).toBe("1");
  });

  it("a key created after the change authenticates, and the row holds no plaintext", async () => {
    const { db, adapter, maskApiKey } = await boot();

    const created = await db.createApiKey("Team Key", "machine-1");
    expect(await db.validateApiKey(created.key)).toBe(true);

    const row = adapter.get(`SELECT * FROM apiKeys WHERE id = ?`, [created.id]);
    expect(row.key).toBe(maskApiKey(created.key));
    expect(row.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(plaintextOnDisk(created.key)).toBe(false);

    // The dashboard lists the display form, never the secret.
    const listed = await db.getApiKeys();
    expect(listed).toHaveLength(1);
    expect(listed[0].key).toBe(maskApiKey(created.key));
    expect(listed[0].name).toBe("Team Key");
  });

  it("the pepper is a per-install secret in its own 0600 file", async () => {
    const { db } = await boot();
    await db.createApiKey("Team Key", "machine-1");

    const pepper = path.join(tempDir, "auth", "key-pepper");
    const stat = fs.statSync(pepper);
    expect(stat.size).toBe(32);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("the display form identifies a key without being usable", async () => {
    const { maskApiKey } = await boot();
    const masked = maskApiKey(LEGACY_KEY);

    expect(masked).toBe("sk-abcde***3c4d");
    expect(masked).not.toContain("XyZwVuTsRqPoNmLkIjHgFdCb"); // the secret part is gone
    expect(LEGACY_KEY.startsWith(masked.slice(0, 8))).toBe(true);
    expect(LEGACY_KEY.endsWith(masked.slice(-4))).toBe(true);
    // Masking is idempotent: the display form of a display form is itself.
    expect(maskApiKey(masked)).toBe(masked);
  });
});

describe("usage rows follow the key table", () => {
  it("stores no raw key and still resolves the key's name", async () => {
    const { db, adapter, maskApiKey } = await boot();

    const created = await db.createApiKey("Team Key", "machine-1");
    await db.saveRequestUsage({
      provider: "openai",
      model: "gpt-4",
      connectionId: "c1",
      apiKey: created.key,
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
      endpoint: "/v1/chat",
      status: "ok",
    });
    // The row is written with the next batch; this test reads the table
    // directly, so the batch is flushed first.
    await db.flushUsage();
    // The day blob has its own cadence: the roll-up is flushed separately.
    await db.flushUsageRollup();

    const history = adapter.get(`SELECT apiKey FROM usageHistory LIMIT 1`);
    expect(history.apiKey).toBe(maskApiKey(created.key));
    expect(history.apiKey).not.toBe(created.key);

    const day = JSON.parse(adapter.get(`SELECT data FROM usageDaily LIMIT 1`).data);
    const bucket = Object.values(day.byApiKey)[0];
    expect(bucket.apiKey).toBe(maskApiKey(created.key));
    expect(Object.keys(day.byApiKey)[0]).toContain(maskApiKey(created.key));

    expect(plaintextOnDisk(created.key)).toBe(false);

    // The usage table resolves the name of the key — from the live history
    // and from the daily rollup, which key their rows differently.
    const live = await db.getUsageStats("24h");
    const liveEntries = Object.values(live.byApiKey);
    expect(liveEntries).toHaveLength(1);
    expect(liveEntries[0].keyName).toBe("Team Key");

    const daily = await db.getUsageStats("7d");
    const dailyEntries = Object.values(daily.byApiKey);
    expect(dailyEntries).toHaveLength(1);
    expect(dailyEntries[0].keyName).toBe("Team Key");
  });

  it("groups old and new rows under the same key", async () => {
    writeLegacyDb(tempDir);
    const { db, adapter, maskApiKey } = await boot();

    // The migration rewrote both rows to the display form.
    expect(adapter.get(`SELECT apiKey FROM usageHistory LIMIT 1`).apiKey).toBe(maskApiKey(LEGACY_KEY));
    const day = JSON.parse(adapter.get(`SELECT data FROM usageDaily WHERE dateKey = '2026-09-01'`).data);
    expect(Object.values(day.byApiKey)[0].apiKey).toBe(maskApiKey(LEGACY_KEY));
    expect(Object.keys(day.byApiKey)[0]).toBe(`${maskApiKey(LEGACY_KEY)}|gpt-4|openai`);

    // A row written after the change lands in the same bucket as the
    // rewritten one.
    await db.saveRequestUsage({
      provider: "openai",
      model: "gpt-4",
      connectionId: "c1",
      apiKey: LEGACY_KEY,
      tokens: { prompt_tokens: 2, completion_tokens: 2 },
      endpoint: "/v1/chat",
      status: "ok",
    });
    const stats = await db.getUsageStats("all");
    const entries = Object.values(stats.byApiKey);
    expect(entries).toHaveLength(1);
    expect(entries[0].keyName).toBe("Legacy Key");
    expect(entries[0].requests).toBe(2);
  });
});

describe("restricted keys keep their rules", () => {
  it("finds the key in all four presentation positions", async () => {
    const { db } = await boot();
    const { getKeyAccessContext } = await import("@/sse/services/keyAccess.js");

    const created = await db.createApiKey("Restricted", "machine-1");
    await db.updateApiKey(created.id, { access: { restricted: true, allow: ["Main"] } });

    const requests = [
      new Request("http://localhost/v1/chat/completions", { headers: { Authorization: `Bearer ${created.key}` } }),
      new Request("http://localhost/v1/chat/completions", { headers: { "x-api-key": created.key } }),
      new Request("http://localhost/v1/chat/completions", { headers: { "x-goog-api-key": created.key } }),
      new Request(`http://localhost/v1/chat/completions?key=${encodeURIComponent(created.key)}`),
    ];

    for (const request of requests) {
      const ctx = await getKeyAccessContext(request);
      expect(ctx).not.toBeNull();
      expect(ctx.keyId).toBe(created.id);
      expect(ctx.allow).toEqual(["Main"]);
    }
  });

  it("an unrestricted key stays unrestricted, an unknown key stays unknown", async () => {
    const { db } = await boot();
    const { getKeyAccessContext } = await import("@/sse/services/keyAccess.js");

    const created = await db.createApiKey("Open", "machine-1");
    const request = new Request("http://localhost/v1/chat/completions", { headers: { Authorization: `Bearer ${created.key}` } });
    expect(await getKeyAccessContext(request)).toBeNull();

    const unknown = new Request("http://localhost/v1/chat/completions", { headers: { Authorization: "Bearer sk-nope" } });
    expect(await getKeyAccessContext(unknown)).toBeNull();
  });
});
