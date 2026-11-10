import { GIT_DIFF_HUNK_MAX_LINES, GIT_DIFF_MAX_LINES } from './constants.js';

/** Compact a unified diff: file blocks, hunk headers and changed lines; per-hunk cap. */
export function gitDiff(diff: string, maxLines = GIT_DIFF_MAX_LINES): string {
  const result: string[] = [];
  let currentFile = '';
  let added = 0;
  let removed = 0;
  let inHunk = false;
  let hunkShown = 0;
  let hunkSkipped = 0;
  let wasTruncated = false;

  outer: for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      if (hunkSkipped > 0) {
        result.push(`  ... (${hunkSkipped} lines truncated)`);
        wasTruncated = true;
        hunkSkipped = 0;
      }
      if (currentFile && (added > 0 || removed > 0)) {
        result.push(`  +${added} -${removed}`);
      }
      const parts = line.split(' b/');
      currentFile = parts.length > 1 ? parts.slice(1).join(' b/') : 'unknown';
      result.push(`\n${currentFile}`);
      added = 0;
      removed = 0;
      inHunk = false;
      hunkShown = 0;
    } else if (line.startsWith('@@')) {
      if (hunkSkipped > 0) {
        result.push(`  ... (${hunkSkipped} lines truncated)`);
        wasTruncated = true;
        hunkSkipped = 0;
      }
      inHunk = true;
      hunkShown = 0;
      result.push(`  ${line}`);
    } else if (inHunk) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        added += 1;
        if (hunkShown < GIT_DIFF_HUNK_MAX_LINES) {
          result.push(`  ${line}`);
          hunkShown += 1;
        } else {
          hunkSkipped += 1;
        }
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        removed += 1;
        if (hunkShown < GIT_DIFF_HUNK_MAX_LINES) {
          result.push(`  ${line}`);
          hunkShown += 1;
        } else {
          hunkSkipped += 1;
        }
      } else if (hunkShown < GIT_DIFF_HUNK_MAX_LINES && !line.startsWith('\\')) {
        result.push(`  ${line}`);
        hunkShown += 1;
      }
    }

    if (result.length >= maxLines) {
      result.push('\n... (more changes truncated)');
      wasTruncated = true;
      break outer;
    }
  }

  if (hunkSkipped > 0) {
    result.push(`  ... (${hunkSkipped} lines truncated)`);
    wasTruncated = true;
  }

  if (currentFile && (added > 0 || removed > 0)) {
    result.push(`  +${added} -${removed}`);
  }

  if (wasTruncated) {
    result.push('[full diff: rtk git diff --no-compact]');
  }

  return result.join('\n');
}
