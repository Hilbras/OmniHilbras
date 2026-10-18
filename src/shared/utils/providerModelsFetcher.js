// Fetch and cache suggested models for providers that expose a public models API
// Fetches via backend proxy to avoid CORS issues

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const cache = new Map(); // key: fetcher.url+provider → { payload, expiresAt }

/**
 * Fetch suggested models for a provider using its modelsFetcher config.
 * When providerId is passed, the backend attaches the saved API key so
 * authenticated /v1/models endpoints return their full catalogue with
 * real context-window numbers.
 *
 * `force: true` skips and overwrites the client cache — used by the Fetch
 * button and immediately after saving a key, when the catalogue must be new.
 *
 * Errors are part of the result (never thrown): the payload carries
 * `{ data, error?, upstream? }` so callers can say WHY nothing arrived.
 *
 * @param {{ url: string, type: string }} fetcher
 * @param {string} [providerId]
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<{ data: Array<{ id: string, name: string, contextLength?: number }>, error?: string, upstream?: number }>}
 */
export async function fetchSuggestedModels(fetcher, providerId, { force = false } = {}) {
  if (!fetcher?.url || !fetcher?.type) return { data: [] };

  const cacheKey = `${fetcher.url}::${providerId || ""}`;
  if (!force) {
    const cached = cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) return cached.payload;
  }

  try {
    const params = new URLSearchParams({ url: fetcher.url, type: fetcher.type });
    if (providerId) params.set("provider", providerId);
    const res = await fetch(`/api/providers/suggested-models?${params}`);
    const json = await res.json().catch(() => ({}));
    const payload = {
      data: Array.isArray(json.data) ? json.data : [],
      ...(json.error ? { error: json.error } : {}),
      ...(json.upstream ? { upstream: json.upstream } : {}),
      ...(res.ok ? {} : { error: json.error || `Request failed (HTTP ${res.status})` }),
    };
    // Only cache complete catalogues — an error must retry next time.
    if (payload.data.length > 0 && !payload.error) {
      cache.set(cacheKey, { payload, expiresAt: Date.now() + CACHE_TTL_MS });
    }
    return payload;
  } catch (err) {
    return { data: [], error: err?.message || "Network error" };
  }
}
