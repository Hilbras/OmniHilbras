import { retrievalMarker } from './ccr.js';
import type { CcrStore } from './types.js';

export type TextCompressOptions = {
  targetRatio: number;
  query?: string;
  ccr?: CcrStore;
  reversible: boolean;
};

const fence = /^\s*(```|~~~)/;
const heading = /^\s*#{1,6}\s/;

function terms(query: string | undefined): Set<string> {
  return new Set((query ?? '').toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
}

function score(text: string, queryTerms: Set<string>, position: number, total: number): number {
  const lower = text.toLowerCase();
  let hit = 0;
  for (const term of queryTerms) if (lower.includes(term)) hit += 1;
  const relevance = queryTerms.size ? hit / queryTerms.size : 0;
  // Keep the opening and closing of a document: they carry the ask and the conclusion.
  const edge = position === 0 || position === total - 1 ? 0.35 : 0;
  return relevance + edge;
}

/**
 * Prose compression: select whole sentences/paragraphs, never the middle of one.
 *
 * Code fences, headings and lines carrying errors or URLs are protected. The rest is chosen by query
 * overlap and position until the target ratio is met; the dropped ranges become one marker, and the
 * original is retrievable.
 */
export function compressText(text: string, options: TextCompressOptions): string | undefined {
  if (text.length < 600) return undefined;
  const blocks = text.split(/\n{2,}/);
  if (blocks.length < 4) return undefined;
  const queryTerms = terms(options.query);
  const targetChars = Math.max(200, text.length * Math.min(0.9, Math.max(0.05, options.targetRatio)));
  const scored = blocks.map((block, index) => ({
    block,
    index,
    keep: fence.test(block) || heading.test(block) || /error|fatal|fail|https?:\/\//i.test(block),
    score: score(block, queryTerms, index, blocks.length),
  }));
  const ordered = [...scored].filter((item) => !item.keep).sort((a, b) => b.score - a.score);
  const kept = new Set<number>(scored.filter((item) => item.keep).map((item) => item.index));
  let size = [...kept].reduce((sum, index) => sum + blocks[index]!.length, 0);
  for (const item of ordered) {
    if (size + item.block.length > targetChars && kept.size > 0) continue;
    kept.add(item.index);
    size += item.block.length;
  }
  if (kept.size === blocks.length) return undefined;

  const output: string[] = [];
  let elided = 0;
  for (let index = 0; index < blocks.length; index += 1) {
    if (kept.has(index)) {
      if (elided > 0) {
        output.push(`… [${elided} block${elided === 1 ? '' : 's'} elided] …`);
        elided = 0;
      }
      output.push(blocks[index]!);
    } else {
      elided += 1;
    }
  }
  if (elided > 0) output.push(`… [${elided} block${elided === 1 ? '' : 's'} elided] …`);
  const result = output.join('\n\n');
  if (result.length >= text.length) return undefined;
  if (options.reversible && options.ccr) {
    const entry = options.ccr.put(text, 'text');
    return `${result}\n\n${retrievalMarker(entry.id, text.length)}`;
  }
  return result;
}
