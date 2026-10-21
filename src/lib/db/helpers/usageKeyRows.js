// The usage rows identify a key by its display form.
//
// A row written before the key hash was introduced holds the raw key, in the
// history and in the daily rollup — where it is also part of the bucket key
// ("{apiKey}|{model}|{provider}"). Both have to be rewritten, or the usage
// table resolves no row to a key name and old and new rows stop grouping
// together.
import { maskApiKey } from "./maskApiKey.js";

/**
 * Rewrite the byApiKey buckets of one day to the display form.
 * @param {object} day - the parsed usageDaily row
 * @returns {boolean} whether anything changed
 */
export function rewriteDayApiKeys(day) {
  if (!day?.byApiKey || typeof day.byApiKey !== "object") return false;

  const byApiKey = {};
  let changed = false;
  for (const [bucketKey, bucket] of Object.entries(day.byApiKey)) {
    const masked = bucket?.apiKey ? maskApiKey(bucket.apiKey) : null;
    // The bucket key is "{apiKey}|{model}|{provider}" — the tail is kept
    // verbatim so the row keeps its identity.
    const tail = bucketKey.split("|").slice(1).join("|");
    const nextKey = tail ? `${masked || "local-no-key"}|${tail}` : (masked || "local-no-key");
    byApiKey[nextKey] = { ...bucket, apiKey: masked };
    if (nextKey !== bucketKey || masked !== bucket?.apiKey) changed = true;
  }
  if (!changed) return false;

  day.byApiKey = byApiKey;
  return true;
}
