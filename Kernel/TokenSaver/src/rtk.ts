import { retrievalMarker } from './ccr.js';
import { MIN_COMPRESS_SIZE, RAW_CAP } from './filters/constants.js';
import type { RtkFilterId } from './filters/constants.js';
import { autoDetectFilter } from './filters/autodetect.js';
import { FILTERS } from './filters/registry.js';
import type { CcrStore, ContentKind } from './types.js';

export type RtkOptions = {
  /** Explicit tool name; when recognized it wins over content autodetection. */
  toolName?: string;
  ccr?: CcrStore;
  /** Store the original and append a retrieval marker. Defaults to true when a store is given. */
  reversible?: boolean;
};

export type RtkResult = {
  result: string;
  filter: RtkFilterId;
  kind: ContentKind;
};

const TOOL_FILTERS: Record<string, readonly RtkFilterId[]> = {
  'git-diff': ['git-diff'],
  gitdiff: ['git-diff'],
  'git-status': ['git-status'],
  gitstatus: ['git-status'],
  'git-log': ['git-log'],
  gitlog: ['git-log'],
  grep: ['grep'],
  rg: ['grep'],
  ripgrep: ['grep'],
  'grep-search': ['grep'],
  'search-files': ['grep', 'find'],
  find: ['find'],
  fd: ['find'],
  glob: ['search-list', 'find'],
  tree: ['tree'],
  ls: ['ls'],
  'list-dir': ['ls'],
  'list-directory': ['ls'],
  listdir: ['ls'],
  'read-file': ['read-numbered'],
  readfile: ['read-numbered'],
  read: ['read-numbered'],
  'read-numbered': ['read-numbered'],
  'build-output': ['build-output'],
  build: ['build-output'],
  npm: ['build-output'],
  yarn: ['build-output'],
  pnpm: ['build-output'],
  cargo: ['build-output'],
  make: ['build-output'],
  gradle: ['build-output'],
  maven: ['build-output'],
  webpack: ['build-output'],
  vite: ['build-output'],
  tsc: ['build-output'],
  'dedup-log': ['dedup-log'],
  'smart-truncate': ['smart-truncate'],
};

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

function resolveFilter(text: string, toolName: string | undefined): RtkFilterId | null {
  if (!toolName) return autoDetectFilter(text);
  const candidates = TOOL_FILTERS[normalizeToolName(toolName)];
  if (!candidates) return autoDetectFilter(text);
  for (const candidate of candidates) {
    if (FILTERS[candidate].matches(text)) return candidate;
  }
  // The caller named a known tool but the payload does not have that shape. Do not guess.
  return null;
}

/**
 * Apply the specialized RTK tool-output filter to one string.
 *
 * Returns `undefined` when the content is too small, too large, unrecognized, or when the rewrite
 * would not make it smaller. Every returned string is strictly smaller than the input; when a CCR
 * store is supplied the original is stored and a retrieval marker is appended.
 */
export function compressRtk(text: string, options: RtkOptions = {}): RtkResult | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  const bytesIn = Buffer.byteLength(text, 'utf8');
  if (bytesIn < MIN_COMPRESS_SIZE || bytesIn > RAW_CAP) return undefined;

  const filterId = resolveFilter(text, options.toolName);
  if (!filterId) return undefined;
  const filter = FILTERS[filterId];

  let output: string;
  try {
    output = filter.apply(text);
  } catch {
    return undefined;
  }
  if (typeof output !== 'string' || output.length === 0 || output.length >= text.length) return undefined;

  let result = output;
  if (options.ccr && options.reversible !== false) {
    const entry = options.ccr.put(text, filter.kind);
    result = `${output}\n${retrievalMarker(entry.id, text.length)}`;
  }
  if (result.length >= text.length || Buffer.byteLength(result, 'utf8') >= bytesIn) return undefined;

  return { result, filter: filterId, kind: filter.kind };
}
