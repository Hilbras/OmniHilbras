// The per-request cost of a gateway API key.
//
// Every /v1 request looks its key up and resolves the key's allow list. The
// property under test: the second request of the same key does not read the
// database again — and a change the operator makes (a new allow list, a
// paused key, a deleted key) takes effect on the next request, never later.
//
// The statements are counted on the db adapter itself, so the numbers are
// what the code really does, not what a mock claims.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

// Boot the database in a fresh install and count the statements the request
// path runs.
async function boot() {
  delete global._dbAdapter;
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  const { getAdapter } = await import("@/lib/db/driver.js");
  const adapter = await getAdapter();
  const counter = { statements: 0 };
  for (const method of ["get", "all", "run"]) {
    const original = adapter[method].bind(adapter);
    adapter[method] = (...args) => {
      counter.statements += 1;
      return original(...args);
    };
  }
  return { db, adapter, counter };
}

const request = (key) => new Request("http://localhost/v1/chat/completions", {
  method: "POST",
  headers: { Authorization: `Bearer ${key}` },
});

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omnihilbras-key-cache-"));
  process.env.DATA_DIR = tempDir;
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("the api key is looked up once, not once per request", () => {
  it("serves the second lookup of the same key from the cache", async () => {
    const { db, counter } = await boot();
    const created = await db.createApiKey("Team Key", "machine-1");

    counter.statements = 0;
    const first = await db.getApiKeyByKey(created.key);
    const afterFirst = counter.statements;
    counter.statements = 0;
    const second = await db.getApiKeyByKey(created.key);
    const afterSecond = counter.statements;

    expect(first.id).toBe(created.id);
    expect(second.id).toBe(created.id);
    expect(first.access).toEqual(second.access);
    // The first lookup reads the row, the second one reads nothing.
    expect(afterFirst).toBeGreaterThan(0);
    expect(afterSecond).toBe(0);
  });

  it("serves the validation of the same key from the cache", async () => {
    const { db, counter } = await boot();
    const created = await db.createApiKey("Team Key", "machine-1");

    counter.statements = 0;
    expect(await db.validateApiKey(created.key)).toBe(true);
    expect(counter.statements).toBeGreaterThan(0);

    counter.statements = 0;
    expect(await db.validateApiKey(created.key)).toBe(true);
    expect(counter.statements).toBe(0);
  });

  it("resolves the allow list of the second request without reading the database", async () => {
    const { db, counter } = await boot();
    const { getKeyAccessContext, enforceKeyAccess } = await import("@/sse/services/keyAccess.js");
    const created = await db.createApiKey("Restricted", "machine-1");
    await db.updateApiKey(created.id, { access: { restricted: true, allow: ["openai/model-a"] } });

    counter.statements = 0;
    const firstCtx = await getKeyAccessContext(request(created.key));
    expect(await enforceKeyAccess(firstCtx, "openai/model-a")).toBeNull();
    const afterFirst = counter.statements;

    counter.statements = 0;
    const secondCtx = await getKeyAccessContext(request(created.key));
    expect(await enforceKeyAccess(secondCtx, "openai/model-a")).toBeNull();
    const afterSecond = counter.statements;

    // The key row, the combo names and the resolution of the allow entry are
    // all known after the first request.
    expect(afterFirst).toBeGreaterThan(0);
    expect(afterSecond).toBe(0);
  });
});

describe("a change the operator makes takes effect at once", () => {
  it("applies a new allow list to the next request, and drops the old one", async () => {
    const { db } = await boot();
    const { getKeyAccessContext, enforceKeyAccess } = await import("@/sse/services/keyAccess.js");
    const created = await db.createApiKey("Restricted", "machine-1");
    await db.updateApiKey(created.id, { access: { restricted: true, allow: ["openai/model-a"] } });

    let ctx = await getKeyAccessContext(request(created.key));
    expect(ctx.allow).toEqual(["openai/model-a"]);
    expect(await enforceKeyAccess(ctx, "openai/model-a")).toBeNull();
    expect((await enforceKeyAccess(ctx, "openai/model-b")).status).toBe(403);

    // The operator replaces the list.
    await db.updateApiKey(created.id, { access: { restricted: true, allow: ["openai/model-b"] } });

    ctx = await getKeyAccessContext(request(created.key));
    expect(ctx.allow).toEqual(["openai/model-b"]);
    expect(await enforceKeyAccess(ctx, "openai/model-b")).toBeNull();
    // The entry that was dropped is refused again.
    expect((await enforceKeyAccess(ctx, "openai/model-a")).status).toBe(403);
  });

  it("refuses a key that was paused", async () => {
    const { db } = await boot();
    const created = await db.createApiKey("Paused", "machine-1");
    expect(await db.validateApiKey(created.key)).toBe(true);

    await db.updateApiKey(created.id, { isActive: false });

    expect(await db.validateApiKey(created.key)).toBe(false);
    expect((await db.getApiKeyByKey(created.key)).isActive).toBe(false);
  });

  it("refuses a key that was deleted", async () => {
    const { db } = await boot();
    const created = await db.createApiKey("Doomed", "machine-1");
    expect(await db.validateApiKey(created.key)).toBe(true);
    expect((await db.getApiKeyByKey(created.key)).id).toBe(created.id);

    expect(await db.deleteApiKey(created.id)).toBe(true);

    expect(await db.validateApiKey(created.key)).toBe(false);
    expect(await db.getApiKeyByKey(created.key)).toBeNull();
  });

  it("finds a key in every presentation position, even through the cache", async () => {
    const { db } = await boot();
    const { getKeyAccessContext } = await import("@/sse/services/keyAccess.js");
    const created = await db.createApiKey("Restricted", "machine-1");
    await db.updateApiKey(created.id, { access: { restricted: true, allow: ["openai/model-a"] } });

    const requests = [
      new Request("http://localhost/v1/chat/completions", { headers: { Authorization: `Bearer ${created.key}` } }),
      new Request("http://localhost/v1/chat/completions", { headers: { "x-api-key": created.key } }),
      new Request("http://localhost/v1/chat/completions", { headers: { "x-goog-api-key": created.key } }),
      new Request(`http://localhost/v1/chat/completions?key=${encodeURIComponent(created.key)}`),
    ];

    for (const req of requests) {
      const ctx = await getKeyAccessContext(req);
      expect(ctx).not.toBeNull();
      expect(ctx.keyId).toBe(created.id);
      expect(ctx.allow).toEqual(["openai/model-a"]);
    }
  });
});

describe("a change to the model registry takes effect at once", () => {
  it("lets a key call a combo that was created after its allow list was written", async () => {
    const { db } = await boot();
    const { getKeyAccessContext, enforceKeyAccess } = await import("@/sse/services/keyAccess.js");
    const created = await db.createApiKey("Restricted", "machine-1");
    await db.updateApiKey(created.id, { access: { restricted: true, allow: ["Main"] } });

    // While no combo is named "Main", the entry is a model name and resolves
    // to the provider that name implies.
    let ctx = await getKeyAccessContext(request(created.key));
    expect(await enforceKeyAccess(ctx, "openai/main")).toBeNull();

    await db.createCombo({ name: "Main", models: ["openai/main"] });

    // Now the entry names the combo: the key may call the combo, but not a
    // member of it by name.
    ctx = await getKeyAccessContext(request(created.key));
    expect(await enforceKeyAccess(ctx, "Main")).toBeNull();
    expect((await enforceKeyAccess(ctx, "openai/main")).status).toBe(403);
  });

  it("follows a model alias that was repointed", async () => {
    const { db } = await boot();
    const { getKeyAccessContext, enforceKeyAccess } = await import("@/sse/services/keyAccess.js");
    await db.setModelAlias("fast", "openai/model-a");
    const created = await db.createApiKey("Restricted", "machine-1");
    await db.updateApiKey(created.id, { access: { restricted: true, allow: ["fast"] } });

    let ctx = await getKeyAccessContext(request(created.key));
    expect(await enforceKeyAccess(ctx, "openai/model-a")).toBeNull(); // the alias points there

    await db.setModelAlias("fast", "openai/model-b");

    ctx = await getKeyAccessContext(request(created.key));
    expect((await enforceKeyAccess(ctx, "openai/model-a")).status).toBe(403); // the alias moved
    expect(await enforceKeyAccess(ctx, "openai/model-b")).toBeNull();
  });

  it("follows a provider node that was created for the prefix", async () => {
    const { db } = await boot();
    const { getKeyAccessContext, enforceKeyAccess } = await import("@/sse/services/keyAccess.js");
    const created = await db.createApiKey("Restricted", "machine-1");
    await db.updateApiKey(created.id, { access: { restricted: true, allow: ["p0/model-x"] } });

    // Without a node, the prefix is a provider of its own.
    let ctx = await getKeyAccessContext(request(created.key));
    expect(await enforceKeyAccess(ctx, "p0/model-x")).toBeNull();
    expect((await enforceKeyAccess(ctx, "node-1/model-x")).status).toBe(403);

    await db.createProviderNode({
      id: "node-1",
      type: "openai-compatible",
      name: "Local",
      prefix: "p0",
      apiType: "openai",
      baseUrl: "http://127.0.0.1:1234",
    });

    ctx = await getKeyAccessContext(request(created.key));
    expect(await enforceKeyAccess(ctx, "node-1/model-x")).toBeNull(); // the node owns the prefix now
  });
});
