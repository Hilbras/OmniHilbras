import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";
import { DEFAULT_WORKSPACE_ID } from "../constants.js";

const pricingKv = makeKv("pricing");
const CACHE_TTL_MS = 5000;

let cache = { value: null, expiresAt: 0 };

// The user pricing rows, cached on their own.
//
// getPricingForModel() runs on every completed request (to price it) and used
// to read the whole `pricing` scope and JSON-parse every row, every time —
// while the merged cache right above it already existed for exactly this. The
// rows only change when the user edits a price, and every write path calls
// invalidate() below.
let userPricingCache = { value: null, expiresAt: 0 };

function invalidate() {
  cache = { value: null, expiresAt: 0 };
  userPricingCache = { value: null, expiresAt: 0 };
  pricingMemo.clear();
}

async function getUserPricing() {
  const now = Date.now();
  if (userPricingCache.value && userPricingCache.expiresAt > now) return userPricingCache.value;
  const value = await pricingKv.getAll();
  userPricingCache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

export async function getPricing() {
  const now = Date.now();
  if (cache.value && cache.expiresAt > now) return cache.value;

  const userPricing = await getUserPricing();
  const { PROVIDER_PRICING } = await import("open-sse/providers/pricing.js");
  const merged = {};

  for (const [provider, models] of Object.entries(PROVIDER_PRICING)) {
    merged[provider] = { ...models };
    if (userPricing[provider]) {
      for (const [model, pricing] of Object.entries(userPricing[provider])) {
        merged[provider][model] = merged[provider][model]
          ? { ...merged[provider][model], ...pricing }
          : pricing;
      }
    }
  }

  for (const [provider, models] of Object.entries(userPricing)) {
    if (!merged[provider]) {
      merged[provider] = { ...models };
    } else {
      for (const [model, pricing] of Object.entries(models)) {
        if (!merged[provider][model]) merged[provider][model] = pricing;
      }
    }
  }

  cache = { value: merged, expiresAt: now + CACHE_TTL_MS };
  return merged;
}

/**
 * The constant pricing resolver, loaded once.
 *
 * It used to be a dynamic `await import(...)` on every call — and this
 * function runs on every completed request, to price it. The import is
 * cached by the module system, but the promise still costs tens of
 * microseconds each time, which was the bulk of the per-request pricing
 * cost.
 */
let constPricingResolver = null;
async function resolveConstPricing(provider, model) {
  if (!constPricingResolver) {
    const { getPricingForModel } = await import("open-sse/providers/pricing.js");
    constPricingResolver = getPricingForModel;
  }
  return constPricingResolver(provider, model);
}

/**
 * The resolved price, per provider + model.
 *
 * Every completed request prices its model, and the same model is priced over
 * and over. An unknown model is the expensive case: the fallback chain ends in
 * a scan of all 51 pricing patterns, which costs ~50 µs. The memo turns the
 * repeat into a map lookup, and it is dropped together with the user pricing
 * cache (every pricing write goes through invalidate()).
 */
const PRICING_MEMO_LIMIT = 2000;
const pricingMemo = new Map();

export async function getPricingForModel(provider, model) {
  if (!model) return null;
  const key = `${provider || ""}\u0000${model}`;
  const memoized = pricingMemo.get(key);
  if (memoized !== undefined) return memoized;

  const userPricing = await getUserPricing();
  const value =
    provider && userPricing[provider]?.[model]
      ? userPricing[provider][model]
      : await resolveConstPricing(provider, model);

  if (pricingMemo.size >= PRICING_MEMO_LIMIT) pricingMemo.clear();
  pricingMemo.set(key, value);
  return value;
}

// Atomic merge inside transaction (per-provider read-modify-write)
export async function updatePricing(pricingData) {
  const db = await getAdapter();
  db.transaction(() => {
    for (const [provider, models] of Object.entries(pricingData)) {
      const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      const current = row ? (parseJson(row.value, {}) || {}) : {};
      const merged = { ...current };
      for (const [model, pricing] of Object.entries(models)) {
        merged[model] = pricing;
      }
      db.run(
        `INSERT INTO kv(scope, key, workspaceId, value) VALUES('pricing', ?, ?, ?) ON CONFLICT(scope, key, workspaceId) DO UPDATE SET value = excluded.value`,
        [provider, DEFAULT_WORKSPACE_ID, stringifyJson(merged)]
      );
    }
  });
  invalidate();
  return await getUserPricing();
}

export async function resetPricing(provider, model, workspaceId = DEFAULT_WORKSPACE_ID) {
  if (!provider) return await getUserPricing();
  const db = await getAdapter();
  db.transaction(() => {
    if (!model) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ? AND workspaceId = ?`, [provider, workspaceId]);
      return;
    }
    const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ? AND workspaceId = ?`, [provider, workspaceId]);
    const current = row ? (parseJson(row.value, {}) || {}) : {};
    delete current[model];
    if (Object.keys(current).length === 0) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ? AND workspaceId = ?`, [provider, workspaceId]);
    } else {
      db.run(
        `INSERT INTO kv(scope, key, workspaceId, value) VALUES('pricing', ?, ?, ?) ON CONFLICT(scope, key, workspaceId) DO UPDATE SET value = excluded.value`,
        [provider, workspaceId, stringifyJson(current)]
      );
    }
  });
  invalidate();
  return await getUserPricing();
}

export async function resetAllPricing() {
  await pricingKv.clear();
  invalidate();
  return {};
}
