/**
 * Run an async mapper over a list with a bounded number in flight.
 *
 * `Promise.all(items.map(fn))` starts everything at once. That is fine for a
 * handful of database writes and wrong for a hundred upstream pings: a
 * provider asked for 100 models at once gets 100 sockets, and the request
 * takes as long as the slowest of them while the others hold their slots.
 *
 * The results keep the input order, so the caller can zip them back with the
 * items.
 *
 * @param {Array} items - the values to map over
 * @param {(item: any, index: number) => Promise<any>} fn - the mapper
 * @param {number} limit - how many may be in flight at once
 * @returns {Promise<Array>} the mapped results, in the order of `items`
 */
export async function mapWithConcurrency(items, fn, limit = 4) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];

  const width = Math.max(1, Math.min(Number(limit) || 1, list.length));
  const results = new Array(list.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(list[index], index);
    }
  };

  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}
