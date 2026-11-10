import { isLikelyBase64 } from './detect.js';
import { retrievalMarker, stableKey } from './ccr.js';
import type { CcrStore } from './types.js';

export type JsonCompressOptions = {
  maxStringChars: number;
  maxArrayItems: number;
  ccr?: CcrStore;
  reversible: boolean;
  /** Recursion guard for adversarial input. */
  maxDepth?: number;
};

const ERROR_KEY = /^(?:error|errors|exception|stack|traceback|fatal|level|severity|status|code)$/i;

function looksLikeError(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (!ERROR_KEY.test(key)) continue;
    if (typeof child === 'string' && /error|fatal|fail|exception|denied|timeout/i.test(child)) return true;
    if (typeof child === 'number' && child >= 400) return true;
  }
  return false;
}

function elideString(value: string, max: number): string {
  if (value.length <= max) return value;
  if (isLikelyBase64(value)) return `[binary ${value.length} chars omitted]`;
  const head = Math.max(8, Math.floor(max * 0.6));
  const tail = Math.max(4, max - head);
  return `${value.slice(0, head)}…[${value.length - head - tail} chars elided]…${value.slice(-tail)}`;
}

/**
 * SmartCrusher's shape, without its Rust/ML dependencies.
 *
 * Structure is never rewritten into prose: objects keep their keys, arrays stay arrays, and anything
 * dropped leaves a sentinel carrying a retrieval id. A compressor that returns invalid JSON is worse
 * than no compression at all.
 */
export function compressJsonValue(value: unknown, options: JsonCompressOptions, depth = 0): unknown {
  const maxDepth = options.maxDepth ?? 24;
  if (depth > maxDepth) return '[depth limit]';
  if (typeof value === 'string') return elideString(value, options.maxStringChars);
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    const seen = new Set<string>();
    const unique: unknown[] = [];
    for (const item of value) {
      const key = stableKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(item);
    }
    let kept = unique.map((item) => compressJsonValue(item, options, depth + 1));
    if (kept.length > options.maxArrayItems) {
      const errors = kept.filter(looksLikeError);
      const target = Math.max(2, options.maxArrayItems - 1);
      const headCount = Math.max(1, Math.floor((target - Math.min(errors.length, 3)) / 2));
      const tailCount = Math.max(1, target - Math.min(errors.length, 3) - headCount);
      const head = kept.slice(0, headCount);
      const tail = kept.slice(-tailCount);
      const middleErrors = errors.filter((item) => !head.includes(item) && !tail.includes(item)).slice(0, 3);
      const dropped = value.length - head.length - tail.length - middleErrors.length;
      kept = [...head, ...middleErrors, ...tail];
      if (options.reversible && options.ccr && dropped > 0) {
        const entry = options.ccr.put(JSON.stringify(value), 'json');
        kept.splice(Math.min(head.length + middleErrors.length, kept.length), 0, {
          _token_saver: `${dropped} rows elided`,
          retrieve: entry.id,
          marker: retrievalMarker(entry.id, JSON.stringify(value).length),
        });
      } else if (dropped > 0) {
        kept.splice(Math.min(head.length + middleErrors.length, kept.length), 0, { _token_saver: `${dropped} rows elided` });
      }
    }
    return kept;
  }

  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    result[key] = compressJsonValue(child, options, depth + 1);
  }
  return result;
}

export function compressJsonText(text: string, options: JsonCompressOptions): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const compressed = compressJsonValue(parsed, options);
  const rendered = JSON.stringify(compressed);
  return rendered.length < text.length ? rendered : undefined;
}
