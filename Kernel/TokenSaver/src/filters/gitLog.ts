import { GIT_LOG_MAX_LINES } from './constants.js';

const COMMIT_RE = /^commit [0-9a-f]{7,40}$/i;
const GRAPH_COMMIT_RE = /^[*|/\\ ]+commit [0-9a-f]{7,40}/i;

/** Compress `git log`: keep commit headers, author/date, subject and change stats; drop bodies. */
export function gitLog(text: string, maxLines = GIT_LOG_MAX_LINES): string {
  if (!text) return '';

  const input = String(text);
  const lines = input.split('\n');
  const out: string[] = [];
  let skipped = 0;
  let inCommit = false;
  let subjectSeen = false;

  const pushLine = (line: string): void => {
    if (out.length < maxLines) out.push(line);
    else skipped++;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();

    if (COMMIT_RE.test(trimmed) || GRAPH_COMMIT_RE.test(trimmed)) {
      inCommit = true;
      subjectSeen = false;
      pushLine(line);
      continue;
    }

    if (inCommit) {
      if (/^[*|/\\ ]*(Author|Date):/i.test(trimmed)) {
        pushLine(trimmed);
        continue;
      }
      if (trimmed === '') continue;
      if (!subjectSeen && /^[*|/\\ ]*    \S/.test(line)) {
        pushLine(`  Subject: ${trimmed}`);
        subjectSeen = true;
        continue;
      }
      if (/^\d+ file\w* changed/.test(trimmed)) {
        pushLine(`  ${trimmed}`);
        continue;
      }
      if (/^diff --git /.test(trimmed)) {
        pushLine('  ... diff body omitted');
        continue;
      }
      continue;
    }

    const graphMatch = /^[*|/\\ ]+([0-9a-f]{7,40}\s+.+)/i.exec(trimmed);
    if (graphMatch) {
      pushLine(graphMatch[1]!);
      continue;
    }

    if (/^[0-9a-f]{7,40}\s+/.test(trimmed)) {
      pushLine(trimmed);
      continue;
    }

    if (/^[*|/\\ ]+$/.test(trimmed) && /[*|/\\]/.test(trimmed)) continue;

    pushLine(trimmed);
  }

  if (skipped > 0) out.push(`... (${skipped} more lines)`);

  const result = out.join('\n');
  if (!result && input) return input;
  if (result.length > input.length) return input;
  return result;
}
