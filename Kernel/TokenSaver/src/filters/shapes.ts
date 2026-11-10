import { READ_NUMBERED_MIN_HIT_RATIO } from './constants.js';
import { READ_NUMBERED_LINE_RE } from './readNumbered.js';
import { LS_ROW_RE, LS_TOTAL_RE } from './ls.js';

export const GIT_DIFF_RE = /^diff --git |^@@ /m;
export const GIT_STATUS_RE = /^On branch |^nothing to commit|^Changes (not |to be )|^Untracked files:|^## /m;
export const GIT_LOG_RE = /^[*|/\\ ]*commit [0-9a-f]{7,40}$/m;
export const GIT_ONELINE_RE = /^[0-9a-f]{7,40}\s+\S+/m;
export const PORCELAIN_RE = /^[ MADRCU?!][ MADRCU?!] \S/m;
export const BUILD_OUTPUT_RE = /^(npm (warn|error|ERR!)|yarn (warn|error)|\s*Compiling\s+\S+|\s*Downloading\s+\S+|added \d+ package|\[ERROR\]|BUILD (SUCCESS|FAILED)|\s*Finished\s+|Successfully (installed|built)|ERROR:)/im;
export const TREE_GLYPH_RE = /[├└]──|│  /;

/** Rust splitn(3, ':') rule: `file:number:content`. */
export function isGrepLine(line: string): boolean {
  const first = line.indexOf(':');
  if (first === -1) return false;
  const second = line.indexOf(':', first + 1);
  if (second === -1) return false;
  return /^\d+$/.test(line.slice(first + 1, second));
}

export function isPathLike(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true;
  if (trimmed.includes(':')) return false;
  return trimmed.startsWith('.') || trimmed.startsWith('/') || trimmed.includes('/');
}

export function isMostlyPorcelain(head: string): boolean {
  const lines = head.split('\n').filter((line) => line.trim());
  if (lines.length < 3) return false;
  const hits = lines.filter((line) => PORCELAIN_RE.test(line)).length;
  return hits / lines.length >= 0.6;
}

export function isLineNumbered(lines: readonly string[]): boolean {
  let hits = 0;
  let nonEmpty = 0;
  for (const line of lines.slice(0, 100)) {
    if (line.length === 0) continue;
    nonEmpty++;
    if (READ_NUMBERED_LINE_RE.test(line)) hits++;
  }
  if (nonEmpty < 5) return false;
  return hits / nonEmpty >= READ_NUMBERED_MIN_HIT_RATIO;
}

export function countMatches(text: string, re: RegExp): number {
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  return (text.match(global) ?? []).length;
}

export function looksLikeLs(text: string): boolean {
  return LS_TOTAL_RE.test(text) || countMatches(text, LS_ROW_RE) >= 3;
}
