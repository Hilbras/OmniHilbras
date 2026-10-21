// The identity of a proxy pool, used to tell an already stored pool from a
// new one.
//
// Both sides of the comparison have to be normalised the same way: the import
// parses its lines with `new URL(...)`, which adds a trailing slash to a bare
// host, while a pool created by hand keeps the URL exactly as it was typed.
// Comparing a normalised URL against a raw one makes the same proxy look like
// two different pools, and every import then adds a duplicate.
export function normalizeProxyUrl(value) {
  const trimmed = (value || "").trim();
  if (!trimmed) return "";
  try {
    return new URL(trimmed).toString();
  } catch {
    // Not a URL the parser understands — keep it as it is.
    return trimmed;
  }
}

export function proxyPoolDedupeKey(proxyUrl, noProxy = "") {
  return `${normalizeProxyUrl(proxyUrl)}|||${(noProxy || "").trim()}`;
}
