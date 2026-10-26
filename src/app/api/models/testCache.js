// In-memory test result cache with TTL.
// Key: providerStorageAlias, Value: { results: { modelId: "ok"|"error"|string }, fetchedAt: number }
const testResultCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export function getCachedTestResults(providerAlias) {
  if (!providerAlias) return null;
  const entry = testResultCache.get(providerAlias);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    testResultCache.delete(providerAlias);
    return null;
  }
  return entry.results;
}

export function setCachedTestResults(providerAlias, results) {
  if (!providerAlias) return;
  testResultCache.set(providerAlias, { results, fetchedAt: Date.now() });
}

export function clearCachedTestResults(providerAlias) {
  if (!providerAlias) return;
  testResultCache.delete(providerAlias);
}

export function getCacheAge(providerAlias) {
  if (!providerAlias) return null;
  const entry = testResultCache.get(providerAlias);
  if (!entry) return null;
  const ageMs = Date.now() - entry.fetchedAt;
  if (ageMs > CACHE_TTL_MS) {
    testResultCache.delete(providerAlias);
    return null;
  }
  return ageMs;
}
