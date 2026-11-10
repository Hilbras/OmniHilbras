import { LS_EXT_SUMMARY_TOP, LS_NOISE_DIRS } from './constants.js';

const LS_DATE_RE = /\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+(\d{4}|\d{2}:\d{2})\s+/;

function humanSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)}M`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${bytes}B`;
}

type ParsedLine = { fileType: string; size: number; name: string };

function parseLsLine(line: string): ParsedLine | null {
  const match = LS_DATE_RE.exec(line);
  if (!match) return null;
  const name = line.slice(match.index + match[0].length);
  const beforeParts = line.slice(0, match.index).split(/\s+/).filter(Boolean);
  if (beforeParts.length < 4) return null;

  const perms = beforeParts[0]!;
  let size = 0;
  for (let index = beforeParts.length - 1; index >= 0; index -= 1) {
    const part = beforeParts[index]!;
    const value = Number(part);
    if (Number.isInteger(value) && String(value) === part) {
      size = value;
      break;
    }
  }
  return { fileType: perms.charAt(0), size, name };
}

/** Compact `ls -la`: dirs first, files with human sizes, extension summary, noise dirs skipped. */
export function ls(input: string): string {
  const dirs: string[] = [];
  const files: Array<[string, string]> = [];
  const byExt = new Map<string, number>();

  for (const line of input.split('\n')) {
    if (line.startsWith('total ') || line.length === 0) continue;
    const parsed = parseLsLine(line);
    if (!parsed) continue;
    if (parsed.name === '.' || parsed.name === '..') continue;
    if ((LS_NOISE_DIRS as readonly string[]).includes(parsed.name)) continue;

    if (parsed.fileType === 'd') {
      dirs.push(parsed.name);
    } else if (parsed.fileType === '-' || parsed.fileType === 'l') {
      const dot = parsed.name.lastIndexOf('.');
      const ext = dot > 0 ? parsed.name.slice(dot) : 'no ext';
      byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
      files.push([parsed.name, humanSize(parsed.size)]);
    }
  }

  if (dirs.length === 0 && files.length === 0) return input;

  let out = '';
  for (const dir of dirs) out += `${dir}/\n`;
  for (const [name, size] of files) out += `${name}  ${size}\n`;

  let summary = `\nSummary: ${files.length} files, ${dirs.length} dirs`;
  if (byExt.size > 0) {
    const extensions = Array.from(byExt.entries()).sort((a, b) => b[1] - a[1]);
    const parts = extensions.slice(0, LS_EXT_SUMMARY_TOP).map(([ext, count]) => `${count} ${ext}`);
    summary += ` (${parts.join(', ')}`;
    if (extensions.length > LS_EXT_SUMMARY_TOP) {
      summary += `, +${extensions.length - LS_EXT_SUMMARY_TOP} more`;
    }
    summary += ')';
  }

  return out + summary;
}

export const LS_ROW_RE = /^[-dlbcps][rwx-]{9}/m;
export const LS_TOTAL_RE = /^total \d+$/m;
