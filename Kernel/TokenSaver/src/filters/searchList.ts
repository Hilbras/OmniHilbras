import { SEARCH_LIST_PER_DIR_MAX, SEARCH_LIST_TOTAL_DIR_MAX } from './constants.js';

/** Compact Cursor Glob output: header plus `- path` lines grouped by parent dir. */
export function searchList(input: string): string {
  const lines = input.split('\n');
  if (lines.length === 0) return input;

  const header = lines[0] ?? '';
  const paths: string[] = [];
  for (const raw of lines.slice(1)) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('- ')) paths.push(trimmed.slice(2));
  }
  if (paths.length === 0) return input;

  const byDir = new Map<string, string[]>();
  for (const path of paths) {
    const slash = path.lastIndexOf('/');
    const dir = slash === -1 ? '.' : (path.slice(0, slash) || '/');
    const name = slash === -1 ? path : path.slice(slash + 1);
    const names = byDir.get(dir) ?? [];
    names.push(name);
    byDir.set(dir, names);
  }

  const dirs = Array.from(byDir.keys()).sort();
  let out = `${header}\n${paths.length} files in ${dirs.length} dirs:\n\n`;

  for (const dir of dirs.slice(0, SEARCH_LIST_TOTAL_DIR_MAX)) {
    const names = byDir.get(dir) ?? [];
    out += `${dir}/ (${names.length}):\n`;
    for (const name of names.slice(0, SEARCH_LIST_PER_DIR_MAX)) out += `  ${name}\n`;
    if (names.length > SEARCH_LIST_PER_DIR_MAX) {
      out += `  +${names.length - SEARCH_LIST_PER_DIR_MAX}\n`;
    }
    out += '\n';
  }
  if (dirs.length > SEARCH_LIST_TOTAL_DIR_MAX) {
    out += `+${dirs.length - SEARCH_LIST_TOTAL_DIR_MAX} more dirs\n`;
  }

  return out.replace(/\n+$/, '');
}

export const SEARCH_LIST_HEADER_RE = /^Result of search in '[^']*' \(total (\d+) files?\):/;
