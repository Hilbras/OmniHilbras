import { createHash } from 'node:crypto';
import type { CcrEntry, CcrStore, ContentKind, SavableMessage } from './types.js';

/**
 * Reversible storage for everything the compressors rewrite.
 *
 * The model sees a marker with an id; the original stays here. This is the CCR idea from Headroom,
 * reimplemented without its proxy/MCP surface: a bounded in-memory store with a pluggable interface so
 * the gateway can later back it with the local vault.
 */
export class MemoryCcrStore implements CcrStore {
  private readonly entries = new Map<string, CcrEntry>();
  private readonly limit: number;

  constructor(limit = 200) {
    this.limit = Math.max(1, limit);
  }

  put(content: string, kind: ContentKind): CcrEntry {
    const id = createHash('sha256').update(content).digest('hex').slice(0, 12);
    const existing = this.entries.get(id);
    if (existing) {
      this.entries.delete(id);
      this.entries.set(id, existing);
      return existing;
    }
    const entry = { id, content, kind, createdAt: Date.now(), bytes: Buffer.byteLength(content, 'utf8') };
    this.entries.set(id, entry);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return entry;
  }

  get(id: string): CcrEntry | undefined {
    return this.entries.get(id);
  }

  delete(id: string): boolean {
    return this.entries.delete(id);
  }

  size(): number {
    return this.entries.size;
  }
}

export function retrievalMarker(id: string, originalChars: number): string {
  return `<<token-saver:${id} ${originalChars} chars elided; retrieve with this id>>`;
}

/** Stable identity for a value, used for JSON row deduplication. */
export function stableKey(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableKey(record[key])}`).join(',')}}`;
}

/** Rough token estimate. Deliberately model-agnostic: no tokenizer dependency, no false precision. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Code and JSON are denser than prose; counting UTF-8 bytes / 4 is closer than chars / 4 for them,
  // and for prose it is the same for ASCII. The result is an estimate, and the stats say so.
  return Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 4));
}

export function countMessageTokens(messages: readonly SavableMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += 4; // role and framing
    if (typeof message.content === 'string') total += estimateTokens(message.content);
    else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'text' && typeof (part as { text?: unknown }).text === 'string') total += estimateTokens((part as { text: string }).text);
        else total += 8;
      }
    }
    if (message.toolCalls) total += estimateTokens(JSON.stringify(message.toolCalls));
  }
  return total;
}
