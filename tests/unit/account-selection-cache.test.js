// Account selection reads the connection list of a provider out of an
// in-process cache instead of the database. These tests pin the two
// properties that cache must not break:
//
//   1. a write is visible to the very next selection (no stale list), and
//   2. the selection still picks exactly the same account as before —
//      fill-first, the pin, the fallback order and the round-robin sticky
//      window all behave the way they did without the cache.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let auth;
let getAdapterSync;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omnihilbras-acct-cache-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  auth = await import("@/sse/services/auth.js");
  ({ getAdapterSync } = await import("@/lib/db/driver.js"));
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function makeConnection(provider, name) {
  return db.createProviderConnection({
    provider,
    authType: "apikey",
    name,
    apiKey: `key-${name}`,
  });
}

// The round-robin bookkeeping compares lastUsedAt timestamps, so the
// selections have to be far enough apart to get distinct ones.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("account selection — connection list cache", () => {
  it("sees a connection that was created after the list was read", async () => {
    const provider = "acct-cache-created";
    const first = await makeConnection(provider, "first");

    // Warm the list with the account that exists so far.
    expect((await auth.getProviderCredentials(provider)).connectionId).toBe(first.id);

    const second = await makeConnection(provider, "second");
    // The new account has to be selectable right away — a stale list would
    // not know about it and the request would find no account at all.
    const next = await auth.getProviderCredentials(provider, new Set([first.id]));
    expect(next.connectionId).toBe(second.id);
  });

  it("stops selecting a deleted account", async () => {
    const provider = "acct-cache-deleted";
    const first = await makeConnection(provider, "first");
    const second = await makeConnection(provider, "second");
    expect((await auth.getProviderCredentials(provider)).connectionId).toBe(first.id);

    await db.deleteProviderConnection(first.id);

    expect((await auth.getProviderCredentials(provider)).connectionId).toBe(second.id);
  });

  it("stops selecting a disabled account", async () => {
    const provider = "acct-cache-disabled";
    const first = await makeConnection(provider, "first");
    const second = await makeConnection(provider, "second");
    expect((await auth.getProviderCredentials(provider)).connectionId).toBe(first.id);

    await db.updateProviderConnection(first.id, { isActive: false });
    expect((await auth.getProviderCredentials(provider)).connectionId).toBe(second.id);

    await db.updateProviderConnection(second.id, { isActive: false });
    expect(await auth.getProviderCredentials(provider)).toBeNull();
  });

  it("keeps the fill-first pick, the pin and the fallback order", async () => {
    const provider = "acct-cache-fill-first";
    const a = await makeConnection(provider, "a");
    const b = await makeConnection(provider, "b");
    const c = await makeConnection(provider, "c");

    // fill-first: the lowest priority number wins and keeps winning.
    expect((await auth.getProviderCredentials(provider)).connectionId).toBe(a.id);
    expect((await auth.getProviderCredentials(provider)).connectionId).toBe(a.id);

    // A pinned account wins over the strategy.
    const pinned = await auth.getProviderCredentials(provider, null, null, { preferredConnectionId: c.id });
    expect(pinned.connectionId).toBe(c.id);

    // An excluded account falls through to the next one in priority order.
    const fallback = await auth.getProviderCredentials(provider, new Set([a.id]));
    expect(fallback.connectionId).toBe(b.id);
  });

  it("keeps the round-robin sticky window and the rotation order", async () => {
    const provider = "acct-cache-round-robin";
    await db.updateSettings({
      providerStrategies: { [provider]: { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 3 } },
    });
    const a = await makeConnection(provider, "a");
    const b = await makeConnection(provider, "b");

    // The account is held for stickyRoundRobinLimit requests, then the
    // least recently used one takes over — the same order the selection
    // produced before the list was cached.
    const picks = [];
    for (let i = 0; i < 7; i++) {
      picks.push((await auth.getProviderCredentials(provider)).connectionId);
      await sleep(10);
    }
    expect(picks).toEqual([a.id, a.id, a.id, b.id, b.id, b.id, a.id]);
  });

  it("serialises concurrent selections of the same provider", async () => {
    const provider = "acct-cache-concurrent";
    await db.updateSettings({
      providerStrategies: { [provider]: { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 10 } },
    });
    const a = await makeConnection(provider, "a");

    // The five requests queue up behind each other, so the sticky counter has
    // to advance five times — not once.
    await Promise.all(Array.from({ length: 5 }, () => auth.getProviderCredentials(provider)));

    const row = await db.getProviderConnectionById(a.id);
    expect(row.consecutiveUseCount).toBe(5);
  });

  it("does not read the connection table again for every request", async () => {
    const provider = "acct-cache-reads";
    await makeConnection(provider, "a");

    const adapter = getAdapterSync();
    const originalAll = adapter.all;
    let selects = 0;
    adapter.all = function (sql, params) {
      if (String(sql).includes("providerConnections")) selects++;
      return originalAll.call(this, sql, params);
    };
    try {
      await auth.getProviderCredentials(provider); // warm the cache
      selects = 0;
      for (let i = 0; i < 5; i++) await auth.getProviderCredentials(provider);
      expect(selects).toBe(0);
    } finally {
      adapter.all = originalAll;
    }
  });
});
