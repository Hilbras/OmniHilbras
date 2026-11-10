import { FIND_PER_DIR_MAX, FIND_TOTAL_DIR_MAX } from './constants.js';

/** Port of find_wrapper: group paths by parent, basenames only, capped per dir and in total. */
export function find(input: string): string {
  const lines = input.split('\n').filter((line) => line.trim());
  if (lines.length === 0) return input;

  const byDir = new Map<string, string[]>();

  for (const path of lines) {
    const lastSep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    let dir: string;
    let basename: string;
    if (lastSep === -1) {
      dir = '.';
      basename = path;
    } else {
      dir = path.slice(0, lastSep) || '/';
      basename = path.slice(lastSep + 1);
    }
    const files = byDir.get(dir) ?? [];
    files.push(basename);
    byDir.set(dir, files);
  }

  const dirs = Array.from(byDir.keys()).sort();
  let out = `${lines.length} files in ${dirs.length} dirs:\n\n`;

  for (const dir of dirs.slice(0, FIND_TOTAL_DIR_MAX)) {
    const files = byDir.get(dir) ?? [];
    out += `${dir.replace(/\\/g, '/')}/  (${files.length})\n`;
    for (const file of files.slice(0, FIND_PER_DIR_MAX)) out += `  ${file}\n`;
    if (files.length > FIND_PER_DIR_MAX) {
      out += `  +${files.length - FIND_PER_DIR_MAX}\n`;
    }
  }
  if (dirs.length > FIND_TOTAL_DIR_MAX) {
    out += `\n+${dirs.length - FIND_TOTAL_DIR_MAX} more dirs\n`;
  }

  return out;
}
