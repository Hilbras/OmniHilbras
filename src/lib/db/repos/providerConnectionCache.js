// Provider connection rows, cached in memory.
//
// The request path reads the whole connection list of a provider on every
// request (account selection, the account-fallback loop, the quota pings).
// Without this cache each of those reads is a table scan, and the
// account-selection lock used to serialise them.
//
// Every write path in connectionsRepo.js updates this cache in the same tick
// as its own DB write, so the cache can never hand out a connection that was
// deleted or disabled. The TTL is only a safety net for writes that come
// from outside this process — the CLI talks to the same SQLite file.

const ALL_PROVIDERS_KEY = "*";

// Short enough that a change made by another process is picked up quickly,
// long enough that a busy provider does not re-read the table every request.
const CACHE_TTL_MS = 5000;

// Kept on global so a dev hot reload cannot end up with two caches: the read
// paths and the write paths must always share the same one, otherwise an
// invalidation would land in an instance nobody reads from.
if (!global._providerConnectionCache) {
  global._providerConnectionCache = { entries: new Map() };
}
const cache = global._providerConnectionCache;

function keyFor(providerId) {
  return providerId || ALL_PROVIDERS_KEY;
}

/**
 * A caller that mutates what it got (say `connection.providerSpecificData`)
 * must not be able to poison the cached row, so every row handed out is a
 * copy.
 */
export function cloneConnection(connection) {
  if (!connection) return connection;
  const copy = { ...connection };
  if (copy.providerSpecificData && typeof copy.providerSpecificData === "object") {
    copy.providerSpecificData = { ...copy.providerSpecificData };
  }
  return copy;
}

export function getCachedProviderConnections(providerId) {
  const key = keyFor(providerId);
  const entry = cache.entries.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    cache.entries.delete(key);
    return null;
  }
  return entry.list;
}

export function setCachedProviderConnections(providerId, list) {
  cache.entries.set(keyFor(providerId), {
    list,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

// A write to one provider changes what the all-providers list holds too, so
// both lists are dropped.
export function invalidateProviderConnections(providerId) {
  cache.entries.delete(keyFor(providerId));
  cache.entries.delete(ALL_PROVIDERS_KEY);
}

export function invalidateAllProviderConnections() {
  cache.entries.clear();
}

// Apply a single row write to the cached lists, so a cache hit sees the new
// value without a re-read. The round-robin bookkeeping writes on every
// selection and must not throw the whole list away.
export function patchCachedProviderConnection(row) {
  for (const key of [keyFor(row.provider), ALL_PROVIDERS_KEY]) {
    const entry = cache.entries.get(key);
    if (!entry) continue;
    const index = entry.list.findIndex(c => c.id === row.id);
    if (index === -1) {
      // The cached snapshot does not know this row — it was created outside
      // this process, or the list was filled before the row existed. Drop
      // the list, the next read reloads it from the database.
      cache.entries.delete(key);
      continue;
    }
    entry.list[index] = cloneConnection(row);
    // The expiry is deliberately not extended: the TTL is the safety net for
    // writes that bypass this process and it has to keep ticking.
  }
}
