import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { atomicWrite, defaultStateDirectory } from './secure-store.js';

/**
 * An **optional** request-detail store, deliberately separate from `UsageRecord`.
 *
 * `usage-store.ts` has no field capable of holding content, and `Kernel/API/test/usage-store.test.js`
 * asserts that by scanning its keys. Widening that record to carry an error string, a tool name or a
 * schema would undo the property in one edit. So this store is opt-in, holds only a small whitelist of
 * non-content facts, and is bounded in three ways: record count, retained age, and total file bytes.
 *
 * What is stored, and nothing else: request id, model, provider id, a **sanitised** error line, tool
 * names, schema byte counts and a timestamp. No prompt, no response text, no headers, no credential.
 */

export type RequestDetail = {
  id: string;
  at: string;
  requestId: string;
  model: string;
  providerId?: string;
  errorText?: string;
  toolNames?: string[];
  schemaBytes?: { declared: number; forwarded: number };
};

export type RequestDetailInput = Omit<RequestDetail, 'id' | 'at'>;

export interface RequestDetailStore {
  record(input: RequestDetailInput): Promise<RequestDetail>;
  list(query?: { requestId?: string; limit?: number }): Promise<RequestDetail[]>;
  exportState?(): Promise<RequestDetailsBackupState>;
  importState?(state: RequestDetailsBackupState): Promise<void>;
}

export type RequestDetailsBackupState = { version: 1; details: RequestDetail[] };

const maxErrorChars = 500;
const maxToolNames = 32;
const maxToolNameChars = 80;
const defaultMaxRecords = 200;
const defaultRetentionMs = 7 * 24 * 60 * 60_000;
const defaultMaxFileBytes = 512 * 1024;

/**
 * Removes credential-shaped values before a line is written.
 *
 * A provider's refusal can echo the bearer token it was given, and a gateway error can include a URL
 * with a query secret. The patterns below are deliberately broad: dropping a harmless line is better
 * than persisting a key, and the detail store is diagnostic, not an audit trail.
 */
export function sanitizeErrorText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/(sk-[A-Za-z0-9_-]{8,}|ohk_[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,})/g, '[redacted]')
    .replace(/([?&](?:key|token|api_key|apikey|password|secret)=)[^&\s]+/gi, '$1[redacted]')
    .trim();
  return cleaned ? cleaned.slice(0, maxErrorChars) : undefined;
}

export function sanitizeToolNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
    .slice(0, maxToolNames)
    .map((name) => name.trim().slice(0, maxToolNameChars));
  return names.length ? [...new Set(names)] : undefined;
}

export function sanitizeSchemaBytes(value: unknown): { declared: number; forwarded: number } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { declared, forwarded } = value as { declared?: unknown; forwarded?: unknown };
  if (typeof declared !== 'number' || !Number.isFinite(declared) || declared < 0) return undefined;
  if (typeof forwarded !== 'number' || !Number.isFinite(forwarded) || forwarded < 0) return undefined;
  return { declared: Math.floor(declared), forwarded: Math.floor(forwarded) };
}

/**
 * Strict backup reader. The load path tolerates a corrupt file; swapping a whole section in does not.
 * Every record is normalized, so an imported detail is one the writer would have produced.
 */
export function parseRequestDetailState(value: unknown): RequestDetailsBackupState {
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1
    || !Array.isArray((value as { details?: unknown }).details)) {
    throw new Error('The backup\'s request-detail section is not readable.');
  }
  const details = (value as { details: RequestDetailInput[] }).details.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.requestId !== 'string' || typeof entry.model !== 'string') {
      throw new Error('The backup contains an unreadable request detail.');
    }
    return normalizeRequestDetail(entry, entry as RequestDetail);
  });
  return { version: 1, details };
}

/** Keeps a record to the whitelist rather than spreading an input that might carry extra keys. */
export function normalizeRequestDetail(input: RequestDetailInput, existing?: RequestDetail): RequestDetail {
  if (typeof input.requestId !== 'string' || !input.requestId.trim()) throw new Error('A request detail needs a request id.');
  if (typeof input.model !== 'string' || !input.model.trim()) throw new Error('A request detail needs a model.');
  return {
    id: existing?.id ?? `rd_${input.requestId.slice(0, 40)}`,
    at: existing?.at ?? new Date().toISOString(),
    requestId: input.requestId.trim().slice(0, 200),
    model: input.model.trim().slice(0, 200),
    ...(input.providerId ? { providerId: input.providerId.slice(0, 120) } : {}),
    ...(sanitizeErrorText(input.errorText) ? { errorText: sanitizeErrorText(input.errorText) } : {}),
    ...(sanitizeToolNames(input.toolNames) ? { toolNames: sanitizeToolNames(input.toolNames) } : {}),
    ...(sanitizeSchemaBytes(input.schemaBytes) ? { schemaBytes: sanitizeSchemaBytes(input.schemaBytes) } : {}),
  };
}

function bounded(details: RequestDetail[], maxRecords: number, retentionMs: number, maxFileBytes: number): RequestDetail[] {
  const cutoff = Date.now() - retentionMs;
  const kept = details.filter((detail) => Date.parse(detail.at) >= cutoff).slice(-maxRecords);
  // A hand-edited file or an enormous error line must not make the next write grow without limit.
  while (kept.length > 1 && JSON.stringify(kept).length > maxFileBytes) kept.shift();
  return kept;
}

export class InMemoryRequestDetailStore implements RequestDetailStore {
  private details: RequestDetail[] = [];

  constructor(private readonly options: { maxRecords?: number; retentionMs?: number; maxFileBytes?: number } = {}) {}

  async record(input: RequestDetailInput) {
    const detail = normalizeRequestDetail(input);
    this.details = bounded([...this.details.filter((entry) => entry.id !== detail.id), detail],
      this.options.maxRecords ?? defaultMaxRecords,
      this.options.retentionMs ?? defaultRetentionMs,
      this.options.maxFileBytes ?? defaultMaxFileBytes);
    return detail;
  }

  async list(query: { requestId?: string; limit?: number } = {}) {
    const filtered = query.requestId ? this.details.filter((detail) => detail.requestId === query.requestId) : this.details;
    return filtered.slice().reverse().slice(0, query.limit ?? defaultMaxRecords);
  }

  async exportState(): Promise<RequestDetailsBackupState> { return { version: 1, details: [...this.details] }; }
  async importState(state: RequestDetailsBackupState) {
    if (!state || state.version !== 1 || !Array.isArray(state.details)) throw new Error('The request-detail section is not readable.');
    this.details = bounded(state.details.map((entry) => normalizeRequestDetail(entry, entry)),
      this.options.maxRecords ?? defaultMaxRecords,
      this.options.retentionMs ?? defaultRetentionMs,
      this.options.maxFileBytes ?? defaultMaxFileBytes);
  }
}

/** Durable, opt-in store. Writes are serialised; the file is bounded on every write. */
export class LocalRequestDetailStore implements RequestDetailStore {
  private readonly path: string;
  private details: RequestDetail[] = [];
  private loaded = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly maxRecords: number;
  private readonly retentionMs: number;
  private readonly maxFileBytes: number;

  constructor(options: { directory?: string; path?: string; maxRecords?: number; retentionMs?: number; maxFileBytes?: number } = {}) {
    this.path = options.path ?? join(options.directory ?? defaultStateDirectory(), 'request-details.json');
    this.maxRecords = options.maxRecords ?? defaultMaxRecords;
    this.retentionMs = options.retentionMs ?? defaultRetentionMs;
    this.maxFileBytes = options.maxFileBytes ?? defaultMaxFileBytes;
  }

  private async ensureLoaded() {
    if (this.loaded) return;
    try {
      const raw: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (raw && typeof raw === 'object' && Array.isArray((raw as { details?: unknown }).details)) {
        this.details = bounded(
          (raw as { details: RequestDetail[] }).details.map((entry) => normalizeRequestDetail(entry, entry)),
          this.maxRecords, this.retentionMs, this.maxFileBytes,
        );
      }
    } catch {
      // A missing or corrupt file is an empty log, not an unstartable gateway.
    }
    this.loaded = true;
  }

  private persist() {
    return atomicWrite(this.path, `${JSON.stringify({ version: 1, details: this.details } satisfies RequestDetailsBackupState, null, 2)}\n`);
  }

  private withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async record(input: RequestDetailInput) {
    return this.withMutation(async () => {
      await this.ensureLoaded();
      const detail = normalizeRequestDetail(input);
      const next = bounded([...this.details.filter((entry) => entry.id !== detail.id), detail], this.maxRecords, this.retentionMs, this.maxFileBytes);
      const previous = this.details;
      this.details = next;
      try { await this.persist(); } catch (error) { this.details = previous; throw error; }
      return detail;
    });
  }

  async list(query: { requestId?: string; limit?: number } = {}) {
    await this.queue;
    await this.ensureLoaded();
    const filtered = query.requestId ? this.details.filter((detail) => detail.requestId === query.requestId) : this.details;
    return filtered.slice().reverse().slice(0, query.limit ?? defaultMaxRecords);
  }

  async exportState(): Promise<RequestDetailsBackupState> {
    await this.queue;
    await this.ensureLoaded();
    return { version: 1, details: [...this.details] };
  }

  async importState(state: RequestDetailsBackupState): Promise<void> {
    if (!state || state.version !== 1 || !Array.isArray(state.details)) throw new Error('The request-detail section is not readable.');
    const next = bounded(state.details.map((entry) => normalizeRequestDetail(entry, entry)), this.maxRecords, this.retentionMs, this.maxFileBytes);
    return this.withMutation(async () => {
      await this.ensureLoaded();
      const previous = this.details;
      this.details = next;
      try { await this.persist(); } catch (error) { this.details = previous; throw error; }
    });
  }
}
