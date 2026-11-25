/**
 * A map that holds at most `limit` entries and evicts the least recently used one. A read counts as a use.
 *
 * A renewal memo keyed by every token ever renewed grows for as long as the gateway runs. The cap keeps the newest
 * renewals, which are the ones a request can still arrive with.
 */
export function boundedMap<K, V>(limit: number): Map<K, V> {
  const entries = new Map<K, V>();
  return new Proxy(entries, {
    get(target, property, receiver) {
      if (property === 'get') {
        return (key: K) => {
          if (!target.has(key)) return undefined;
          const value = target.get(key) as V;
          target.delete(key);
          target.set(key, value);
          return value;
        };
      }
      if (property === 'set') {
        return (key: K, value: V) => {
          target.delete(key);
          target.set(key, value);
          while (target.size > limit) {
            const oldest = target.keys().next().value as K;
            target.delete(oldest);
          }
          return receiver;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Map<K, V>;
}
