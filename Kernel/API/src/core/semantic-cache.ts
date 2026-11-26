/**
 * Opt-in similarity cache.
 *
 * Exact caching answers "the same request". This answers "a request close enough that the same answer
 * is still right", which is only safe when the operator decides the threshold and keeps the feature
 * off by default. The embedding is local and deterministic (hashed token trigrams), so enabling it
 * costs no provider request and works offline; it is a lexical embedding, not a learned one, and its
 * limits are stated rather than implied.
 */

export type Embedder = (text: string) => number[];

const dimensions = 256;

/** A hashed bag of word unigrams and trigrams, L2-normalized. */
export function embedLocally(text: string): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const add = (token: string, weight: number) => {
    let hash = 2166136261;
    for (let index = 0; index < token.length; index += 1) {
      hash ^= token.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    const slot = Math.abs(hash) % dimensions;
    vector[slot] = (vector[slot] ?? 0) + weight;
  };
  for (const word of words) add(word, 1);
  for (let index = 0; index + 2 < words.length; index += 1) add(`${words[index]} ${words[index + 1]} ${words[index + 2]}`, 0.5);
  const length = Math.hypot(...vector) || 1;
  return vector.map((value) => value / length);
}

export function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) return 0;
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) dot += left[index]! * right[index]!;
  return dot;
}

type Entry = { vector: number[]; value: unknown; expiresAt: number };

export class SemanticCache {
  private readonly entries: Entry[] = [];
  private readonly threshold: number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly embedder: Embedder;
  private readonly now: () => number;

  constructor(options: { threshold?: number; ttlMs?: number; maxEntries?: number; embedder?: Embedder; now?: () => number } = {}) {
    this.threshold = Math.min(1, Math.max(0.5, options.threshold ?? 0.92));
    this.ttlMs = options.ttlMs ?? 300_000;
    this.maxEntries = options.maxEntries ?? 128;
    this.embedder = options.embedder ?? embedLocally;
    this.now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.ttlMs > 0;
  }

  async get(text: string): Promise<{ value: unknown; similarity: number } | undefined> {
    if (!this.enabled) return undefined;
    const vector = this.embedder(text);
    let best: { entry: Entry; similarity: number } | undefined;
    for (const entry of this.entries) {
      if (entry.expiresAt <= this.now()) continue;
      const similarity = cosine(vector, entry.vector);
      if (similarity >= this.threshold && (!best || similarity > best.similarity)) best = { entry, similarity };
    }
    return best ? { value: best.entry.value, similarity: best.similarity } : undefined;
  }

  async set(text: string, value: unknown): Promise<void> {
    if (!this.enabled) return;
    this.entries.push({ vector: this.embedder(text), value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.length > this.maxEntries) this.entries.shift();
  }
}
