// Simple in-memory cache for workspace lookups.
// Workspaces rarely change, so caching avoids a DB round-trip on every request.

const CACHE_TTL_MS = 30_000; // 30 seconds
const cache = new Map();

export function getCachedWorkspaceById(workspaceId) {
  const entry = cache.get(workspaceId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(workspaceId);
    return null;
  }
  return entry.value;
}

export function storeWorkspaceCache(workspaceId, workspace) {
  cache.set(workspaceId, { value: workspace, expiresAt: Date.now() + CACHE_TTL_MS });
}

export function invalidateWorkspaceCache(workspaceId) {
  if (workspaceId) {
    cache.delete(workspaceId);
  } else {
    cache.clear();
  }
}