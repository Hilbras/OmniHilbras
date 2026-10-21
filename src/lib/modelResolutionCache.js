// The memoised model resolution.
//
// Resolving a model string is a pure function of the string, the alias table,
// the combo table and the provider-node table — and it runs on every request,
// once per combo member and once per allow-list entry of a restricted key.
// Those tables only change when the operator edits them, so the answer is
// cached and dropped on every write to them.
//
// The module holds no imports on purpose: the repositories that invalidate it
// sit below the model service, and a cache that imported them back would
// close a cycle.

const MODEL_RESOLUTION_TTL_MS = 3000;
// Enough for the models of a busy day; the oldest entry goes first.
const MODEL_RESOLUTION_LIMIT = 1000;

const resolutions = new Map();

/**
 * The cached answer for a key, or undefined when there is none (or it expired).
 */
export function readModelResolution(key) {
  const hit = resolutions.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    resolutions.delete(key);
    return undefined;
  }
  return hit.value;
}

/** Cache an answer for a key. */
export function writeModelResolution(key, value) {
  if (resolutions.size >= MODEL_RESOLUTION_LIMIT) resolutions.clear();
  resolutions.set(key, { value, expiresAt: Date.now() + MODEL_RESOLUTION_TTL_MS });
  return value;
}

/**
 * Drop the memoised resolutions.
 *
 * Called when the alias table, the combo table or the provider-node table
 * changes: a repointed alias, a renamed combo and a new node prefix all change
 * what a model string resolves to.
 */
export function clearModelResolutionCache() {
  resolutions.clear();
}
