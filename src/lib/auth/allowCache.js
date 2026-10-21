// Cache for the resolution of a restricted key's allow list.
//
// A restricted key's allow list is resolved on every request: the combo names
// are read from the database and every entry of the list is resolved to the
// provider/model (or the provider) it routes to. A list of 50 entries costs 50
// resolutions and a combos read per request.
//
// Two things are cached here:
//   * the set of combo names, and
//   * the resolution of a single allow-list entry.
//
// The per-key structure is NOT cached: the list itself is re-read with the
// key (that is the part an operator changes), and the cached resolutions are
// applied to that fresh list.
//
// A cached resolution is dropped when the thing it was resolved against
// changes — a combo is created, renamed or deleted, a provider node is added
// or removed, a model alias is repointed. The TTL is the safety net for a
// write path that forgets to drop them.

const COMBO_NAMES_TTL_MS = 3_000;
const ALLOW_ENTRY_TTL_MS = 3_000;
// Enough for the allow lists of a few keys at once; the oldest entry goes first.
const MAX_ENTRIES = 512;

let comboNames = null; // { names: Set<string>, expiresAt }
const allowEntries = new Map(); // entry → { value, expiresAt }

/**
 * The cached set of combo names.
 * @returns {Set<string>|undefined} undefined when nothing is cached.
 */
export function lookupComboNames() {
  if (!comboNames) return undefined;
  if (comboNames.expiresAt <= Date.now()) {
    comboNames = null;
    return undefined;
  }
  return comboNames.names;
}

/** Remember the set of combo names. */
export function storeComboNames(names) {
  comboNames = { names, expiresAt: Date.now() + COMBO_NAMES_TTL_MS };
}

/** Drop the cached combo names — the combos changed. */
export function invalidateComboNames() {
  comboNames = null;
}

/**
 * The cached resolution of one allow-list entry.
 * @returns {object|undefined} undefined when nothing is cached.
 */
export function lookupAllowEntry(entry) {
  const cached = allowEntries.get(entry);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    allowEntries.delete(entry);
    return undefined;
  }
  // Re-insert: Map iterates in insertion order, so this keeps the map's
  // eviction order the least-recently-used one.
  allowEntries.delete(entry);
  allowEntries.set(entry, cached);
  return cached.value;
}

/** Remember the resolution of one allow-list entry. */
export function storeAllowEntry(entry, value) {
  if (allowEntries.size >= MAX_ENTRIES) {
    const oldest = allowEntries.keys().next().value;
    if (oldest !== undefined) allowEntries.delete(oldest);
  }
  allowEntries.delete(entry);
  allowEntries.set(entry, { value, expiresAt: Date.now() + ALLOW_ENTRY_TTL_MS });
}

/** Drop every cached resolution — the model registry changed. */
export function invalidateAllowEntries() {
  allowEntries.clear();
}
