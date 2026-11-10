import type { ContentKind } from '../types.js';
import type { RtkFilterId } from './constants.js';
import { buildOutput } from './buildOutput.js';
import { dedupLog } from './dedupLog.js';
import { find } from './find.js';
import { gitDiff } from './gitDiff.js';
import { gitLog } from './gitLog.js';
import { gitStatus } from './gitStatus.js';
import { grep } from './grep.js';
import { ls } from './ls.js';
import { readNumbered } from './readNumbered.js';
import { searchList, SEARCH_LIST_HEADER_RE } from './searchList.js';
import { smartTruncate } from './smartTruncate.js';
import { tree } from './tree.js';
import {
  BUILD_OUTPUT_RE,
  GIT_DIFF_RE,
  GIT_LOG_RE,
  GIT_ONELINE_RE,
  GIT_STATUS_RE,
  PORCELAIN_RE,
  TREE_GLYPH_RE,
  isGrepLine,
  isLineNumbered,
  isPathLike,
  looksLikeLs,
} from './shapes.js';
import { SMART_TRUNCATE_MIN_LINES } from './constants.js';

export type RtkFilterDefinition = {
  id: RtkFilterId;
  kind: ContentKind;
  apply: (text: string) => string;
  /** Shape check used when a caller names the tool; autodetect has its own ordering. */
  matches: (text: string) => boolean;
};

const nonEmpty = (text: string): string[] => text.split('\n').filter((line) => line.trim().length > 0);

export const FILTERS: Record<RtkFilterId, RtkFilterDefinition> = {
  'git-diff': { id: 'git-diff', kind: 'code', apply: gitDiff, matches: (text) => GIT_DIFF_RE.test(text) },
  'git-status': { id: 'git-status', kind: 'text', apply: gitStatus, matches: (text) => GIT_STATUS_RE.test(text) || PORCELAIN_RE.test(text) },
  'git-log': {
    id: 'git-log',
    kind: 'log',
    apply: gitLog,
    matches: (text) => GIT_LOG_RE.test(text) || GIT_ONELINE_RE.test(text),
  },
  grep: {
    id: 'grep',
    kind: 'search',
    apply: grep,
    matches: (text) => nonEmpty(text).slice(0, 5).some(isGrepLine),
  },
  find: {
    id: 'find',
    kind: 'search',
    apply: find,
    matches: (text) => {
      const lines = nonEmpty(text);
      return lines.length >= 3 && lines.every(isPathLike);
    },
  },
  tree: { id: 'tree', kind: 'text', apply: tree, matches: (text) => TREE_GLYPH_RE.test(text) },
  ls: { id: 'ls', kind: 'text', apply: ls, matches: looksLikeLs },
  'search-list': {
    id: 'search-list',
    kind: 'search',
    apply: searchList,
    matches: (text) => SEARCH_LIST_HEADER_RE.test(text),
  },
  'read-numbered': {
    id: 'read-numbered',
    kind: 'code',
    apply: readNumbered,
    matches: (text) => {
      const lines = text.split('\n');
      return lines.length >= SMART_TRUNCATE_MIN_LINES && isLineNumbered(lines);
    },
  },
  'smart-truncate': {
    id: 'smart-truncate',
    kind: 'text',
    apply: smartTruncate,
    matches: (text) => text.split('\n').length >= SMART_TRUNCATE_MIN_LINES,
  },
  'dedup-log': { id: 'dedup-log', kind: 'log', apply: dedupLog, matches: (text) => nonEmpty(text).length >= 5 },
  'build-output': { id: 'build-output', kind: 'log', apply: buildOutput, matches: (text) => BUILD_OUTPUT_RE.test(text) },
};
