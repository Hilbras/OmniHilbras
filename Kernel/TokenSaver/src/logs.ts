import { retrievalMarker } from './ccr.js';
import type { CcrStore } from './types.js';

export type LogCompressOptions = {
  targetRatio: number;
  ccr?: CcrStore;
  reversible: boolean;
  maxErrors?: number;
  contextLines?: number;
  maxWarnings?: number;
};

type Line = {
  text: string;
  level: 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'unknown';
  stack: boolean;
  key: string;
};

const ANSI = /\u001b\[[0-9;]*m/g;
const errorRe = /\b(?:FATAL|ERROR|FAIL(?:ED|URE)?|EXCEPTION|PANIC)\b|Traceback \(most recent call last\)/i;
const warnRe = /\bWARN(?:ING)?\b/i;
const debugRe = /\b(?:DEBUG|TRACE)\b/i;
const stackRe = /^(?:\s+at\s|File "|Traceback|\s+\^|\s+~|\s+During handling|\s+The above exception)/;

function levelOf(text: string): Line['level'] {
  if (errorRe.test(text)) return 'error';
  if (warnRe.test(text)) return 'warn';
  if (debugRe.test(text)) return 'debug';
  if (/\bINFO\b/.test(text)) return 'info';
  return 'unknown';
}

/** Digits, hex and paths vary per occurrence; the message before the first separator does not. */
function dedupeKey(text: string): string {
  const boundary = Math.max(text.indexOf(':'), text.indexOf('='));
  if (boundary <= 0) return text.trim();
  const head = text.slice(0, boundary + 1);
  const tail = text.slice(boundary + 1)
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<n>')
    .replace(/[A-Za-z]:\\[^\s]+|\/(?:[\w.-]+\/)+[\w.-]+/g, '<path>');
  return `${head}${tail}`.trim();
}

function parse(text: string): Line[] {
  return text.replace(ANSI, '').split('\n').map((raw) => {
    const line = raw.replace(/\s+$/, '');
    return { text: line, level: levelOf(line), stack: stackRe.test(line), key: dedupeKey(line) };
  });
}

/**
 * Build/test output compression.
 *
 * The invariant is that a failure survives. Errors and warnings are kept with their surrounding
 * stack/context; ordinary progress lines collapse to a count; duplicate messages are emitted once with
 * an occurrence count. A log compressor that drops the FATAL line has saved tokens by making the
 * question unanswerable.
 */
export function compressLog(text: string, options: LogCompressOptions): string | undefined {
  const lines = parse(text);
  if (lines.length < 20) return undefined;
  const maxErrors = options.maxErrors ?? 20;
  const maxWarnings = options.maxWarnings ?? 8;
  const contextLines = options.contextLines ?? 3;

  const keep = new Set<number>();
  const errors = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.level === 'error').slice(0, maxErrors);
  const warnings = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.level === 'warn').slice(0, maxWarnings);
  for (const { index } of [...errors, ...warnings]) {
    for (let offset = -contextLines; offset <= contextLines; offset += 1) {
      const target = index + offset;
      if (target >= 0 && target < lines.length) keep.add(target);
    }
  }
  for (let index = 0; index < Math.min(5, lines.length); index += 1) keep.add(index);
  for (let index = Math.max(0, lines.length - 5); index < lines.length; index += 1) keep.add(index);

  const counts = new Map<string, { count: number; index: number }>();
  for (let index = 0; index < lines.length; index += 1) {
    if (keep.has(index)) continue;
    const line = lines[index]!;
    if (line.level === 'error' || line.level === 'warn' || line.stack) continue;
    const entry = counts.get(line.key);
    if (entry) entry.count += 1;
    else counts.set(line.key, { count: 1, index });
  }

  const output: string[] = [];
  let elided = 0;
  let lastWasElision = false;
  const pushElision = (count: number) => {
    if (count <= 0) return;
    if (!lastWasElision) output.push(`… ${count} lines elided`);
    else output[output.length - 1] = `… ${Number(output[output.length - 1]!.match(/\d+/)?.[0] ?? 0) + count} lines elided`;
    lastWasElision = true;
  };

  const duplicates = new Map<string, number>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (keep.has(index)) {
      pushElision(elided);
      elided = 0;
      lastWasElision = false;
      const seen = duplicates.get(line.key) ?? 0;
      duplicates.set(line.key, seen + 1);
      if (seen === 0) output.push(line.text);
      else if (seen === 1) output[output.length - 1] = `${line.text}  (repeated)`;
      continue;
    }
    const grouped = counts.get(line.key);
    if (grouped && grouped.count > 1) {
      if (grouped.index === index) {
        pushElision(elided);
        elided = 0;
        lastWasElision = false;
        output.push(`${line.text}  (×${grouped.count})`);
      } else {
        elided += 1;
      }
      continue;
    }
    elided += 1;
  }
  pushElision(elided);
  const result = output.join('\n');
  if (result.length >= text.length * options.targetRatio && result.length >= text.length) return undefined;
  if (result.length >= text.length) return undefined;
  if (options.reversible && options.ccr) {
    const entry = options.ccr.put(text, 'log');
    return `${result}\n${retrievalMarker(entry.id, text.length)}`;
  }
  return result;
}
