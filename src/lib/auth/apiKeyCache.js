// Cache for the api-keys row a presented key resolves to.
//
// Every /v1 request looks its key up: the presented secret is hashed and the
// row is read from the database. The answer is the same for every request of
// the same key, so the row is kept here and re-read only when the key table
// changes or the entry ages out.
//
// The cache is keyed by the hash of the presented key, never by the key
// itself: a memory dump must not hand out a usable credential.
//
// A cached row is the row the database holds, with its isActive flag — so a
// paused or deleted key can never be served as valid. Every write to the key
// table drops the whole cache, which is cheap: those writes are dashboard
// actions, not request-path work.

const TTL_MS = 5_000;
// A key that is not in the table is remembered for less time than one that
// is: a miss must not outlive the creation of the key it missed.
const MISS_TTL_MS = 1_000;
// Enough for every key of a busy install; the oldest entry is dropped first.
const MAX_ENTRIES = 512;

const rows = new Map(); // keyHash → { row, expiresAt }

/**
 * The cached row of a key.
 * @returns {object|null|undefined} the row, null when the key is known to be
 * absent, undefined when nothing is cached for it.
 */
export function lookupKeyRow(keyHash) {
  const entry = rows.get(keyHash);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    rows.delete(keyHash);
    return undefined;
  }
  // Re-insert: Map iterates in insertion order, so this keeps the map's
  // eviction order the least-recently-used one.
  rows.delete(keyHash);
  rows.set(keyHash, entry);
  return entry.row;
}

/** Remember the row of a key (null when the key is not in the table). */
export function storeKeyRow(keyHash, row) {
  if (rows.size >= MAX_ENTRIES) {
    const oldest = rows.keys().next().value;
    if (oldest !== undefined) rows.delete(oldest);
  }
  rows.delete(keyHash);
  rows.set(keyHash, { row, expiresAt: Date.now() + (row ? TTL_MS : MISS_TTL_MS) });
}

/** Drop every cached row — the key table changed. */
export function invalidateKeyRows() {
  rows.clear();
}
