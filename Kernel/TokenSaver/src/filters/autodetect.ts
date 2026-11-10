import { DETECT_WINDOW, SMART_TRUNCATE_MIN_LINES } from './constants.js';
import type { RtkFilterId } from './constants.js';
import { SEARCH_LIST_HEADER_RE } from './searchList.js';
import {
  BUILD_OUTPUT_RE,
  GIT_DIFF_RE,
  GIT_LOG_RE,
  GIT_STATUS_RE,
  TREE_GLYPH_RE,
  isGrepLine,
  isLineNumbered,
  isMostlyPorcelain,
  isPathLike,
  looksLikeLs,
} from './shapes.js';

/**
 * Detection order ported from the reference implementation:
 * git-log → git-diff → git-status → build-output → porcelain status → grep → find →
 * tree → ls → search-list → read-numbered → dedup-log → smart-truncate.
 */
export function autoDetectFilter(text: string): RtkFilterId | null {
  const head = text.length > DETECT_WINDOW ? text.slice(0, DETECT_WINDOW) : text;

  if (GIT_LOG_RE.test(head)) return 'git-log';
  if (GIT_DIFF_RE.test(head)) return 'git-diff';
  if (GIT_STATUS_RE.test(head)) return 'git-status';

  // Build output before the porcelain check: cargo's "Compiling" is not `git status`.
  if (BUILD_OUTPUT_RE.test(head)) return 'build-output';

  if (isMostlyPorcelain(head)) return 'git-status';

  const lines = head.split('\n');
  const nonEmpty = lines.filter((line) => line.trim().length > 0);

  if (nonEmpty.slice(0, 5).some(isGrepLine)) return 'grep';

  if (nonEmpty.length >= 3 && nonEmpty.every(isPathLike)) return 'find';

  if (TREE_GLYPH_RE.test(head)) return 'tree';

  if (looksLikeLs(head)) return 'ls';

  if (SEARCH_LIST_HEADER_RE.test(head)) return 'search-list';

  if (lines.length >= SMART_TRUNCATE_MIN_LINES && isLineNumbered(lines)) return 'read-numbered';
  // Read-numbered dumps are long; the first 1 KiB holds only ~25 lines. Judge this shape on the whole
  // document, not the detection window.
  const allLines = text.split('\n');
  if (allLines.length >= SMART_TRUNCATE_MIN_LINES && isLineNumbered(allLines)) return 'read-numbered';

  if (nonEmpty.length >= 5) return 'dedup-log';

  if (text.split('\n').length >= SMART_TRUNCATE_MIN_LINES) return 'smart-truncate';

  return null;
}
