/** The public surface of the standalone token saver. */

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url?: { url?: string } }
  | { type: string; [key: string]: unknown };

export type SavableMessage = {
  role: string;
  content?: string | ContentPart[] | null;
  toolCalls?: unknown;
  toolCallId?: string;
  name?: string;
  /** Tool result flag carried by the gateway; trimmed history must preserve it. */
  isError?: boolean;
  [key: string]: unknown;
};

export type ContentKind = 'json' | 'log' | 'search' | 'code' | 'text';

export type RouteStats = {
  kind: ContentKind;
  originalTokens: number;
  compressedTokens: number;
  strategy: string;
  ccrId?: string;
};

export type CompressionStats = {
  originalTokens: number;
  compressedTokens: number;
  savedTokens: number;
  /** saved / original, 0 when nothing was compressed. */
  savedRatio: number;
  routes: RouteStats[];
  /** True when at least one original was stored and can be retrieved by id. */
  reversible: boolean;
};

export type CompressionResult<T> = {
  value: T;
  stats: CompressionStats;
};

export type TokenSaverOptions = {
  /** Approximate target for lossy text/log compression. JSON keeps structure instead. */
  targetRatio?: number;
  /** Last N messages are left untouched. */
  protectRecent?: number;
  compressSystem?: boolean;
  compressUsers?: boolean;
  /** Compress code bodies. Off by default: removing a function body changes meaning. */
  compressCode?: boolean;
  /** Strings shorter than this are never rewritten. */
  minChars?: number;
  /** Longest string retained inside a JSON value before head/tail elision. */
  maxStringChars?: number;
  /** Largest array retained before row dropping. */
  maxArrayItems?: number;
  /** Store originals for lossy rewrites and emit a retrieval marker. */
  reversible?: boolean;
  /** Optional shared store; a bounded in-memory store is used when omitted. */
  ccr?: CcrStore;
  /** Upper bound on stored originals; oldest are evicted. */
  ccrLimit?: number;
};

export type CcrEntry = {
  id: string;
  content: string;
  kind: ContentKind;
  createdAt: number;
  bytes: number;
};

export interface CcrStore {
  put(content: string, kind: ContentKind): CcrEntry;
  get(id: string): CcrEntry | undefined;
  delete(id: string): boolean;
  size(): number;
}
