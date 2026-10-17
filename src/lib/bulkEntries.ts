/**
 * The Bulk Add parser, extracted so it can be **called** rather than read.
 *
 * The modal's bulk tab accepts one entry per line, either `name|key` or a bare key. Its inline version
 * parsed the name and then threw the key away:
 *
 * ```ts
 * const entryName = separator > 0 ? entry.slice(0, separator).trim() : '';   // and the key was never read
 * ```
 *
 * Nothing noticed for the life of the feature, and the reason is worth recording: the entries it produced
 * carried `hasKey: true` — a *claim* that a key existed — while the save path they were handed to needs the
 * key itself. So the bulk tab could not save anything, in either page, and the one page whose bulk handler
 * was honest could only report one failure per line. A field asserting something about a key is not a key,
 * which is this repository's oldest theme with the polarity reversed: the value was dropped, and a boolean
 * about it survived.
 *
 * Keeping this pure and in `src/lib/` is the point of the extraction — `tests/bulk-entries.test.js` calls it,
 * so the property is stated over inputs rather than inferred from the shape of the source.
 */

export type BulkEntry = {
  /** The name the user wrote before the separator, or `''` for a bare key. */
  name: string;
  /** The key. Never empty: a line with nothing after the separator is refused rather than saved as `''`. */
  key: string;
};

/**
 * One entry per non-blank line.
 *
 * A line with a separator and nothing after it yields **no** entry rather than an empty key. That is the
 * difference between "the user left a line blank" and "the user wrote `name|` and meant it", and only the
 * first is harmless: an empty key would reach the gateway as a request for a connection with no credential,
 * which is a statement about the provider that the user did not make.
 */
export function parseBulkEntries(text: string): BulkEntry[] {
  const entries: BulkEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf('|');
    if (separator < 0) {
      entries.push({ name: '', key: trimmed });
      continue;
    }
    const key = trimmed.slice(separator + 1).trim();
    if (!key) continue;
    entries.push({ name: trimmed.slice(0, separator).trim(), key });
  }
  return entries;
}

/** The name to show for an entry that did not carry one: `Name 1`, `Name 2`, … */
export function bulkEntryName(entry: BulkEntry, fallbackName: string, providerName: string, index: number): string {
  return entry.name || fallbackName.trim() || `${providerName} ${index + 1}`;
}