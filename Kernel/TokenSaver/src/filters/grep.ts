import { GREP_PER_FILE_MAX } from './constants.js';

/** Port of grep_wrapper: group `file:lineno:content` by file, cap matches per file. */
export function grep(input: string): string {
  const byFile = new Map<string, Array<[string, string]>>();
  let total = 0;

  for (const line of input.split('\n')) {
    const first = line.indexOf(':');
    if (first === -1) continue;
    const second = line.indexOf(':', first + 1);
    if (second === -1) continue;
    const file = line.slice(0, first);
    const lineNumStr = line.slice(first + 1, second);
    const content = line.slice(second + 1);
    if (!/^\d+$/.test(lineNumStr)) continue;
    total++;
    const matches = byFile.get(file) ?? [];
    matches.push([lineNumStr, content]);
    byFile.set(file, matches);
  }

  if (total === 0) return input;

  const files = Array.from(byFile.keys()).sort();
  let out = `${total} matches in ${files.length}F:\n\n`;

  for (const file of files) {
    const matches = byFile.get(file) ?? [];
    out += `[file] ${file} (${matches.length}):\n`;
    for (const [lineNum, content] of matches.slice(0, GREP_PER_FILE_MAX)) {
      out += `  ${lineNum.padStart(4)}: ${content.trim()}\n`;
    }
    if (matches.length > GREP_PER_FILE_MAX) {
      out += `  +${matches.length - GREP_PER_FILE_MAX}\n`;
    }
    out += '\n';
  }

  return out;
}
