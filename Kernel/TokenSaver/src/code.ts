import { retrievalMarker } from './ccr.js';
import type { CcrStore } from './types.js';

export type CodeCompressOptions = {
  targetRatio: number;
  ccr?: CcrStore;
  reversible: boolean;
};

const significant = /\b(?:import|export|function|class|interface|type|enum|const|let|var|return|throw|async|await|def|fn|struct|impl|pub|use|package|module)\b|^\s*(?:#|@|\/\/\s*(?:TODO|FIXME)|[-*]\s)/m;
const commentOnly = /^\s*(?:\/\/|#|\/\*|\*|--)/;

/**
 * Code compression is deliberately the most conservative lever.
 *
 * Removing a function body does not reduce tokens in a context window; it changes what the model is
 * asked to reason about, and can turn a compiling snippet into an invalid one. This keeps signatures,
 * imports, control flow, comments with intent markers and both ends of the file, and collapses only
 * interiors that carry no syntax signal. It is off by default in `TokenSaverOptions`.
 */
export function compressCode(text: string, options: CodeCompressOptions): string | undefined {
  const lines = text.split('\n');
  if (lines.length < 40) return undefined;
  const keep = new Set<number>();
  for (let index = 0; index < Math.min(20, lines.length); index += 1) keep.add(index);
  for (let index = Math.max(0, lines.length - 20); index < lines.length; index += 1) keep.add(index);
  let blanks = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (significant.test(line) || /error|throw|catch|finally/i.test(line)) keep.add(index);
    if (!line.trim()) {
      blanks += 1;
      if (blanks <= 1) keep.add(index);
    } else {
      blanks = 0;
      // A comment is not syntax; keep intent-bearing comments and drop repeated separators.
      if (commentOnly.test(line) && !/TODO|FIXME|NOTE|HACK|why|because/i.test(line)) keep.delete(index);
    }
  }
  const output: string[] = [];
  let elided = 0;
  const flush = () => {
    if (elided === 0) return;
    output.push(`// … ${elided} line${elided === 1 ? '' : 's'} elided`);
    elided = 0;
  };
  for (let index = 0; index < lines.length; index += 1) {
    if (keep.has(index)) {
      flush();
      output.push(lines[index]!);
    } else {
      elided += 1;
    }
  }
  flush();
  const result = output.join('\n');
  if (result.length >= text.length * Math.max(0.5, options.targetRatio)) return undefined;
  if (result.length >= text.length) return undefined;
  if (options.reversible && options.ccr) {
    const entry = options.ccr.put(text, 'code');
    return `${result}\n// ${retrievalMarker(entry.id, text.length)}`;
  }
  return result;
}
