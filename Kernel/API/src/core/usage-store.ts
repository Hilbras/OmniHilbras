import { join } from 'node:path';
import { ProviderId } from './index.js';;
import { atomicWrite, readOptionalText } from './secure-store.js';
import { defaultConnectionDirectory } from './connections.js';

/**
 * Per-request records, and the store that keeps them.
 *
 * ## Why this exists
 *
 * Measured before it was written: the gateway had **no per-request record at all**. It stored connections,
 * API keys and OAuth sessions, and nothing else — so the dashboard's `Usage` and `Request log` nav items
 * were disabled because the product genuinely lacked the thing behind them, and `Overview` was deleted rather
 * than built on invented numbers.
 *
 * ## What is deliberately NOT recorded
 *
 * **No request or response content, and no headers.** A usage log that keeps prompts is a prompt-injection
 * target and a privacy liability, and neither is what "how much did that cost" needs. The record below has no
 * field capable of holding a message: that is a property of the type, not a convention callers are trusted to
 * follow. `tests/usage-store.test.js` asserts it by scanning the record's own keys, so adding a content field
 * later fails a test rather than quietly widening what is written to disk.
 *
 * That is the opposite trade to what a request log usually makes, and it is the reason this file is small.
 *
 * ## Bounded by construction
 *
 * `maxRecords` is enforced on every write, in both implementations. A long-lived local gateway is exactly
 * where an append-only table becomes a disk-filling bug, and `Usage` is a page a person looks at rather than an
 * audit trail they replay.
 */

/** How a request ended. `cancelled` is deliberately neither success nor failure. */
export type UsageOutcome = 'success' | 'failure' | 'cancelled';

/**
 * One provider attempt within a logical request. `dispatched` is false when the attempt was planned but
 * never sent (for example a hedge that was cancelled before it started), so a count of attempts is never
 * read as a count of provider calls.
 */
export type UsageAttempt = {
  connectionId?: string;
  providerId?: string;
  dispatched: boolean;
  outcome: UsageOutcome | 'abandoned';
  errorCode?: string;
};

export type UsageCompression = {
  totalTokensSaved: number;
  totalBytesSaved: number;
  savers: Record<string, {
    kind: string;
    requests: number;
    tokensSaved: number;
    bytesBefore: number;
    bytesAfter: number;
    state?: 'ran' | 'skipped';
    detail?: string;
  }>;
};

/** Counts only — no tool names or schemas — so a record can explain a stripped contract without holding prompt content. */
export type ToolContractCounts = {
  declared: number;
  forwarded: number;
  stripped: number;
  dropped: number;
};

export type UsageRecord = {
  /** Monotonic within a store; the stable id a UI row keys on. */
  id: string;
  /** ISO 8601, when the request finished. */
  at: string;
  model: string;
  /**
   * Which provider served it — **absent when no provider was reached.**
   *
   * Optional because a request can end before any route is tried: a client that disconnects during startup,
   * or a request no connection could serve. Recording those with a placeholder would put a provider name on a
   * request that provider never saw, which is the one thing this whole file exists to avoid. A page shows
   * "unattributed" for them rather than a provider.
   */
  providerId?: ProviderId;
  /** Absent for the same reason as `providerId`. */
  connectionId?: string;
  outcome: UsageOutcome;
  /** Set when `outcome` is `failure` — the provider's error code, not a generic message. */
  errorCode?: string;
  /**
   * A stream that ended without a terminal finish reason. The request succeeded in the sense that nothing threw,
   * but the agent's tool loop may have been cut off — a stopped turn and a completed one used to be identical here.
   */
  incomplete?: boolean;
  /** Total attempts across every route, so a failover is visible as more than one. */
  attempts: number;
  /**
   * The logical request this record belongs to. Opaque, generated per request, and never a credential or a
   * prompt. Two records with one `requestId` are two attempts at one request, which a single count cannot show.
   */
  requestId?: string;
  /**
   * Who spent it. `key` is an authenticated gateway key, `dashboard` is the trusted loopback dashboard,
   * `anonymous` is a call that arrived outside a request (a test, a background pass) or a gateway with
   * enforcement off. Records written before 4.1 have no actor and read as unattributed rather than as a
   * guess.
   */
  actor?: 'key' | 'dashboard' | 'anonymous';
  /** The key's id — never its secret — so spend can be attributed without the key being readable. */
  apiKeyId?: string;
  /** The key's displayable prefix, so a record can be shown next to the key without a second lookup. */
  apiKeyPrefix?: string;
  /** The key's workspace, when it has one. */
  workspaceId?: string;
  /**
   * Each connection tried, in order, with what it did. Present on records written after this field existed;
   * absent on older records, which therefore show only the total.
   */
  path?: UsageAttempt[];
  latencyMs: number;
  /**
   * Token counts, when the provider reported them. **Optional on purpose**: not every provider meters, and a
   * store that invented a zero would make "cost" look like a measurement rather than an absence.
   */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** True when these numbers are an estimate, not a provider measurement. */
  tokensEstimated?: boolean;
  /** What the token saver did to the prompt, when it changed anything. No prompt content is stored. */
  compression?: UsageCompression;
  /** Whether the request's tool definitions survived the target provider's contract. Counts only. */
  toolContract?: ToolContractCounts;
};

/** What a caller wants out. Every field is optional; the default is everything, newest first. */
export type UsageQuery = {
  since?: string;
  until?: string;
  providerId?: ProviderId;
  model?: string;
  connectionId?: string;
  outcome?: UsageOutcome;
  apiKeyId?: string;
  workspaceId?: string;
  actor?: 'key' | 'dashboard' | 'anonymous';
  limit?: number;
};

/** Per-key totals, so a page can answer "who spent what" without rendering every record. */
export type UsageKeyTotals = {
  apiKeyId: string;
  apiKeyPrefix?: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Filled by the route from the same prices the totals use; absent when nothing was priced. */
  costUsd?: number;
  unpricedRequests?: number;
};

/** Unattributed records — written before attribution existed — are their own row, never a zero. */
export const unattributedUsageKey = 'unattributed' as const;

export type UsageTotals = {
  requests: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** True when **no** record carried token counts, so the token totals are an absence and not a zero. */
  tokensUnmeasured: boolean;
  /**
   * True when **any** figure in the totals came from an estimate rather than a provider's own count.
   *
   * The page needs both facts to be honest: `tokensUnmeasured` says nothing was recorded at all, and this says part of
   * what was recorded was guessed. A single flag rather than a per-record breakdown because the question the page asks
   * is "can I trust this number", and the answer is no if even one request contributed a guess.
   */
  tokensEstimated: boolean;
};

export type UsageSummary = {
  totals: UsageTotals;
  /** Newest first. Bounded by the store's `maxRecords`, never by the query. */
  records: UsageRecord[];
  /** Spend per key over the same records. An absent key id is grouped as `unattributed`. */
  byKey?: UsageKeyTotals[];
};

export interface UsageStore {
  record(entry: Omit<UsageRecord, 'id'>): Promise<UsageRecord>;
  list(query?: UsageQuery): Promise<UsageRecord[]>;
  summary(query?: UsageQuery): Promise<UsageSummary>;
  /** Total records retained, for the bounded-by-construction test and the dashboard's own honesty. */
  size(): Promise<number>;
  clear(): Promise<void>;
  /** Encrypted-backup support, in the store's own file shape. Optional, like `ApiKeyStore`'s pair. */
  exportState?(): Promise<UsageBackupState>;
  /** Replaces every record, bounded by this store's `maxRecords` exactly as the load path is. */
  importState?(state: UsageBackupState): Promise<void>;
  /** Persists coalesced records now. Optional for stores that write synchronously. */
  flush?(): Promise<void>;
}

/** The store's own file shape, so a backup is the file it already writes rather than a second format. */
export type UsageBackupState = { version: number; records: UsageRecord[] };

const usageFileVersion = 1;

/**
 * Reads a backup's usage section.
 *
 * Strict about the records and about the version, where the load path is tolerant about both: a
 * hand-edited file must not make the gateway unopenable, and a whole section being swapped in is a
 * different question from one bad line. A record is only readable if `isUsageRecord` says so — the same
 * function the file's reader applies — so a backup cannot introduce a record shape this store would
 * refuse to load on the next restart.
 */
export function parseUsageState(value: unknown): UsageBackupState {
  if (!isRecord(value) || value.version !== usageFileVersion || !Array.isArray(value.records)) {
    throw new Error('The backup\'s usage section is not readable.');
  }
  const records: UsageRecord[] = [];
  for (const record of value.records) {
    if (!isUsageRecord(record)) throw new Error('The backup contains an unreadable usage record.');
    records.push(normalizeRecord(record));
  }
  return { version: usageFileVersion, records };
}

/**
 * The highest id this set of records implies, so ids stay unique after a restore.
 *
 * Shared by the load path and the import path: a sequence reset to 0 would mint `req_1` again, and two
 * records with one id is a row the dashboard cannot tell from another.
 */
export function highestSequence(records: readonly UsageRecord[]): number {
  return records.reduce((max, record) => {
    const parsedId = /^req_([0-9a-z]+)$/.exec(record.id);
    const value = parsedId ? parseInt(parsedId[1]!, 36) : 0;
    return value > max ? value : max;
  }, 0);
}

/** Fields that must never appear on a record. Asserted in tests, and the reason this list exists. */
export const FORBIDDEN_RECORD_FIELDS = [
  'content',
  'message',
  'messages',
  'prompt',
  'response',
  'body',
  'headers',
  'apiKey',
  'authorization',
  'system',
] as const;

export const defaultMaxUsageRecords = 1_000;

/** Applies a query to an already-newest-first list. Shared so both stores cannot diverge. */
export function selectUsageRecords(all: readonly UsageRecord[], query: UsageQuery = {}): UsageRecord[] {
  const since = query.since ? Date.parse(query.since) : undefined;
  const until = query.until ? Date.parse(query.until) : undefined;
  const limit = Math.max(0, Math.min(query.limit ?? Number.MAX_SAFE_INTEGER, 10_000));

  const matched = all.filter((record) => {
    const at = Date.parse(record.at);
    // An unparseable timestamp is not a reason to drop a record: hiding it would make the totals disagree
    // with the count on screen, which is the exact confusion a usage page must not create.
    if (Number.isNaN(at)) return true;
    if (since !== undefined && !Number.isNaN(since) && at < since) return false;
    if (until !== undefined && !Number.isNaN(until) && at > until) return false;
    if (query.providerId !== undefined && record.providerId !== query.providerId) return false;
    if (query.model !== undefined && record.model !== query.model) return false;
    if (query.connectionId !== undefined && record.connectionId !== query.connectionId) return false;
    if (query.outcome !== undefined && record.outcome !== query.outcome) return false;
    if (query.apiKeyId !== undefined && record.apiKeyId !== query.apiKeyId) return false;
    if (query.workspaceId !== undefined && record.workspaceId !== query.workspaceId) return false;
    if (query.actor !== undefined && (record.actor ?? 'anonymous') !== query.actor) return false;
    return true;
  });

  return matched.slice(0, limit);
}

/** Groups the same records the totals were computed from, so the two cannot describe different windows. */
export function summarizeByKey(records: readonly UsageRecord[]): UsageKeyTotals[] {
  const groups = new Map<string, UsageKeyTotals>();
  for (const record of records) {
    const id = record.apiKeyId ?? unattributedUsageKey;
    const group = groups.get(id) ?? {
      apiKeyId: id,
      ...(record.apiKeyPrefix === undefined ? {} : { apiKeyPrefix: record.apiKeyPrefix }),
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    group.requests += 1;
    group.inputTokens += record.inputTokens ?? 0;
    group.outputTokens += record.outputTokens ?? 0;
    groups.set(id, group);
  }
  return [...groups.values()].sort((left, right) => right.requests - left.requests);
}

export function summarizeUsage(records: readonly UsageRecord[]): UsageTotals {
  let succeeded = 0;
  let failed = 0;
  let cancelled = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  let metered = 0;
  let estimated = 0;

  for (const record of records) {
    if (record.outcome === 'success') succeeded += 1;
    else if (record.outcome === 'failure') failed += 1;
    else cancelled += 1;

    // Counted only when at least one number was actually reported. Summing an absent field as 0 would make
    // an unmetered provider indistinguishable from a free one.
    if (record.inputTokens !== undefined || record.outputTokens !== undefined) {
      metered += 1;
      if (record.tokensEstimated === true) estimated += 1;
      inputTokens += record.inputTokens ?? 0;
      outputTokens += record.outputTokens ?? 0;
      cacheReadTokens += record.cacheReadTokens ?? 0;
      cacheWriteTokens += record.cacheWriteTokens ?? 0;
      reasoningTokens += record.reasoningTokens ?? 0;
    }
  }

  return {
    requests: records.length,
    succeeded,
    failed,
    cancelled,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    tokensUnmeasured: metered === 0,
    tokensEstimated: estimated > 0,
  };
}

/** A monotonically increasing id that stays unique across a store's lifetime. */
function nextId(sequence: { value: number }): string {
  sequence.value += 1;
  return `req_${sequence.value.toString(36)}`;
}

export type InMemoryUsageStoreOptions = { maxRecords?: number };

export type LocalUsageStoreOptions = { directory?: string; path?: string; maxRecords?: number };

/**
 * In-memory, bounded by a ring.
 *
 * The shape every other store in the gateway follows: an interface, an in-memory implementation for tests
 * and for `OMNIHILBRAS_DATA_DIR` being unset, and a local one for real use.
 */
export class InMemoryUsageStore implements UsageStore {
  private readonly records: UsageRecord[] = [];
  private readonly sequence = { value: 0 };
  private readonly maxRecords: number;

  constructor(options: InMemoryUsageStoreOptions = {}) {
    const max = options.maxRecords ?? defaultMaxUsageRecords;
    if (!Number.isInteger(max) || max < 1) throw new Error('maxRecords must be a positive integer.');
    this.maxRecords = max;
  }

  async record(entry: Omit<UsageRecord, 'id'>): Promise<UsageRecord> {
    // Normalized, not spread. The first version did `{ ...entry, id }`, which kept every extra key a
    // JavaScript caller passed — so `messages` survived into a record, and the in-memory store and the local
    // store disagreed about what a record is. `LocalUsageStore` normalized; this one did not. The divergence
    // between two implementations of one interface is exactly what this codebase already carries two
    // comments about, so it is not a gap worth reopening.
    const record = normalizeRecord({ ...entry, id: nextId(this.sequence) });
    this.records.unshift(record);
    // Trim on write, so the bound holds even if nothing ever calls `list`. A store bounded only on read is a
    // store that grows until the first read.
    if (this.records.length > this.maxRecords) this.records.length = this.maxRecords;
    return record;
  }

  async list(query: UsageQuery = {}): Promise<UsageRecord[]> {
    return selectUsageRecords(this.records, query);
  }

  async summary(query: UsageQuery = {}): Promise<UsageSummary> {
    const records = await this.list({ ...query, limit: this.maxRecords });
    return { totals: summarizeUsage(records), records, byKey: summarizeByKey(records) };
  }

  async size(): Promise<number> {
    return this.records.length;
  }

  async clear(): Promise<void> {
    this.records.length = 0;
  }

  async exportState(): Promise<UsageBackupState> {
    return { version: usageFileVersion, records: this.records.map((record) => ({ ...record })) };
  }

  /** Replaces every record, keeping the newest `maxRecords` — the same bound the load path applies. */
  async importState(state: UsageBackupState): Promise<void> {
    const next = parseUsageState(state);
    this.records.length = 0;
    this.records.push(...next.records.slice(0, this.maxRecords));
    this.sequence.value = highestSequence(this.records);
  }
}

/**
 * On-disk, one JSON file, bounded, written through the same hardened helper as every other secret.
 *
 * ## Why this uses `atomicWrite` and not a second mechanism
 *
 * `secure-store.ts` already does the things a usage file needs: a `0700` directory, a `0600` file, a
 * `chmod` after the rename so the mode does not depend on umask, a refusal to write through a symlink, and an
 * `fsync` so a crash cannot leave a half-written file that reads as "no usage" rather than as corruption.
 * Reimplementing any of that here would be a second, worse copy of a security control.
 *
 * ## Serialised writes
 *
 * `mutationQueue`, copied from `LocalConnectionStore`. Two requests finishing at once must not interleave a
 * read-modify-write of the file: the second would write a snapshot taken before the first committed, and one
 * record would vanish. Every mutation is chained, so the worst case is latency rather than a lost record.
 */
export class LocalUsageStore implements UsageStore {
  private readonly path: string;
  private readonly maxRecords: number;
  private records: UsageRecord[] = [];
  private sequence = 0;
  private mutationQueue: Promise<void> = Promise.resolve();
  private loaded = false;
  private usageDirty = false;
  private usageFlushTimer?: ReturnType<typeof setTimeout>;

  constructor(options: LocalUsageStoreOptions = {}) {
    this.path = options.path ?? join(options.directory ?? defaultConnectionDirectory(), 'usage.json');
    const max = options.maxRecords ?? defaultMaxUsageRecords;
    if (!Number.isInteger(max) || max < 1) throw new Error('maxRecords must be a positive integer.');
    this.maxRecords = max;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const text = await readOptionalText(this.path, maxUsageFileBytes);
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (isRecord(parsed) && Array.isArray(parsed.records)) {
          // Re-bounded on load: the file may have been written by an older build, or hand-edited, and a store
          // that trusts a file's length is a store whose bound is only true until the next write.
          this.records = parsed.records
            .filter(isUsageRecord)
            .slice(0, this.maxRecords)
            .map(normalizeRecord);
          // Continue past the highest id seen, so ids stay unique across a restart instead of restarting at 1.
          this.sequence = highestSequence(this.records);
        }
      } catch {
        // A corrupt file must not stop the gateway from serving requests. Usage is a report, and a missing
        // report is better than an unstartable gateway; the file is replaced on the next write.
        this.records = [];
      }
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await atomicWrite(this.path, `${JSON.stringify({ version: usageFileVersion, records: this.records })}\n`);
  }

  private withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation, operation);
    // The queue must not reject, or every later mutation inherits the rejection.
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async record(entry: Omit<UsageRecord, 'id'>): Promise<UsageRecord> {
    return this.withMutation(async () => {
      await this.ensureLoaded();
      this.sequence += 1;
      const record = normalizeRecord({ ...entry, id: `req_${this.sequence.toString(36)}` });
      this.records.unshift(record);
      if (this.records.length > this.maxRecords) this.records.length = this.maxRecords;
      // Usage is a report, not the answer. Writing and `fsync`ing the whole file per request put a
      // disk write on the hot path; keep the record in memory and coalesce the write.
      this.usageDirty = true;
      this.scheduleFlush();
      return record;
    });
  }

  private scheduleFlush() {
    if (this.usageFlushTimer) return;
    this.usageFlushTimer = setTimeout(() => {
      this.usageFlushTimer = undefined;
      void this.flush().catch(() => { this.usageDirty = true; });
    }, 250);
    this.usageFlushTimer.unref?.();
  }

  async flush(): Promise<void> {
    if (!this.usageDirty) return;
    await this.withMutation(async () => {
      if (!this.usageDirty) return;
      this.usageDirty = false;
      try {
        await this.persist();
      } catch (error) {
        this.usageDirty = true;
        throw error;
      }
    });
  }

  async list(query: UsageQuery = {}): Promise<UsageRecord[]> {
    await this.mutationQueue;
    await this.ensureLoaded();
    return selectUsageRecords(this.records, query);
  }

  async summary(query: UsageQuery = {}): Promise<UsageSummary> {
    await this.mutationQueue;
    await this.ensureLoaded();
    const records = selectUsageRecords(this.records, { ...query, limit: this.maxRecords });
    return { totals: summarizeUsage(records), records, byKey: summarizeByKey(records) };
  }

  async size(): Promise<number> {
    await this.mutationQueue;
    await this.ensureLoaded();
    return this.records.length;
  }

  async clear(): Promise<void> {
    await this.withMutation(async () => {
      await this.ensureLoaded();
      this.records = [];
      this.usageDirty = false;
      await this.persist();
    });
  }

  async exportState(): Promise<UsageBackupState> {
    await this.mutationQueue;
    await this.ensureLoaded();
    return { version: usageFileVersion, records: this.records.map((record) => ({ ...record })) };
  }

  /**
   * Replaces every record.
   *
   * Bounded on the way in, which is the one place this differs from `ApiKeyStore.importState` refusing a
   * too-large state: a usage file is a report, and refusing to restore a whole vault because this
   * installation keeps a shorter history would be trading a real restore for a bookkeeping bound. The
   * newest records are the ones kept, which is the end of the history a person looks at.
   */
  async importState(state: UsageBackupState): Promise<void> {
    const next = parseUsageState(state);
    return this.withMutation(async () => {
      await this.ensureLoaded();
      const previous = this.records;
      const previousSequence = this.sequence;
      this.records = next.records.slice(0, this.maxRecords);
      this.sequence = highestSequence(this.records);
      try {
        await this.persist();
      } catch (error) {
        this.records = previous;
        this.sequence = previousSequence;
        await this.persist().catch(() => undefined);
        throw error;
      }
    });
  }
}

const maxUsageFileBytes = 4 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A record from disk is only a record if every field is the right type.
 *
 * Deliberately strict: a partially-valid record that reaches the dashboard shows a blank provider or a `NaN`
 * latency, and the page's totals then disagree with its own rows. Dropping it is honest; repairing it would
 * be inventing.
 */
export function isUsageRecord(value: unknown): value is UsageRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.at === 'string' &&
    typeof value.model === 'string' &&
    (value.providerId === undefined || typeof value.providerId === 'string') &&
    (value.connectionId === undefined || typeof value.connectionId === 'string') &&
    typeof value.latencyMs === 'number' &&
    Number.isFinite(value.latencyMs) &&
    typeof value.outcome === 'string' &&
    ['success', 'failure', 'cancelled'].includes(value.outcome) &&
    typeof value.attempts === 'number' &&
    Number.isFinite(value.attempts) &&
    (value.requestId === undefined || typeof value.requestId === 'string') &&
    (value.actor === undefined || ['key', 'dashboard', 'anonymous'].includes(value.actor as string)) &&
    (value.apiKeyId === undefined || typeof value.apiKeyId === 'string') &&
    (value.apiKeyPrefix === undefined || typeof value.apiKeyPrefix === 'string') &&
    (value.workspaceId === undefined || typeof value.workspaceId === 'string') &&
    (value.incomplete === undefined || typeof value.incomplete === 'boolean') &&
    (value.toolContract === undefined || isToolContractCounts(value.toolContract)) &&
    (value.path === undefined || (Array.isArray(value.path) && value.path.every(isUsageAttempt)))
  );
}

function isToolContractCounts(value: unknown): value is ToolContractCounts {
  if (!isRecord(value)) return false;
  return ['declared', 'forwarded', 'stripped', 'dropped'].every(
    (key) => typeof value[key] === 'number' && Number.isFinite(value[key]) && (value[key] as number) >= 0,
  );
}

function isUsageAttempt(value: unknown): value is UsageAttempt {
  if (!isRecord(value)) return false;
  return (
    typeof value.dispatched === 'boolean' &&
    (value.outcome === 'abandoned' || ['success', 'failure', 'cancelled'].includes(value.outcome as string)) &&
    (value.connectionId === undefined || typeof value.connectionId === 'string') &&
    (value.providerId === undefined || typeof value.providerId === 'string') &&
    (value.errorCode === undefined || typeof value.errorCode === 'string')
  );
}

/** Drops unknown keys, so a file edited by hand cannot widen what the dashboard is shown. */
export function normalizeRecord(record: UsageRecord): UsageRecord {
  return {
    id: record.id,
    at: record.at,
    model: record.model,
    ...(typeof record.providerId === 'string' ? { providerId: record.providerId } : {}),
    ...(typeof record.connectionId === 'string' ? { connectionId: record.connectionId } : {}),
    outcome: record.outcome,
    ...(typeof record.errorCode === 'string' ? { errorCode: record.errorCode } : {}),
    ...(record.incomplete === true ? { incomplete: true } : {}),
    attempts: record.attempts,
    latencyMs: record.latencyMs,
    ...(typeof record.inputTokens === 'number' ? { inputTokens: record.inputTokens } : {}),
    ...(typeof record.outputTokens === 'number' ? { outputTokens: record.outputTokens } : {}),
    ...(typeof record.cacheReadTokens === 'number' ? { cacheReadTokens: record.cacheReadTokens } : {}),
    ...(typeof record.cacheWriteTokens === 'number' ? { cacheWriteTokens: record.cacheWriteTokens } : {}),
    ...(typeof record.reasoningTokens === 'number' ? { reasoningTokens: record.reasoningTokens } : {}),
    ...(record.tokensEstimated === true ? { tokensEstimated: true } : {}),
    ...(record.compression && typeof record.compression === 'object'
      ? {
          compression: {
            totalTokensSaved: Math.max(0, Number(record.compression.totalTokensSaved) || 0),
            totalBytesSaved: Math.max(0, Number(record.compression.totalBytesSaved) || 0),
            savers: Object.fromEntries(Object.entries(record.compression.savers ?? {}).map(([id, entry]) => [id, {
              kind: String(entry.kind),
              requests: Math.max(0, Number(entry.requests) || 0),
              tokensSaved: Math.max(0, Number(entry.tokensSaved) || 0),
              bytesBefore: Math.max(0, Number(entry.bytesBefore) || 0),
              bytesAfter: Math.max(0, Number(entry.bytesAfter) || 0),
              ...(entry.state === 'ran' || entry.state === 'skipped' ? { state: entry.state } : {}),
              ...(typeof entry.detail === 'string' ? { detail: entry.detail.slice(0, 200) } : {}),
            }])),
          },
        }
      : {}),
    ...(isToolContractCounts(record.toolContract) ? {
      toolContract: {
        declared: record.toolContract.declared,
        forwarded: record.toolContract.forwarded,
        stripped: record.toolContract.stripped,
        dropped: record.toolContract.dropped,
      },
    } : {}),
    ...(typeof record.requestId === 'string' ? { requestId: record.requestId } : {}),
    ...(record.actor === 'key' || record.actor === 'dashboard' || record.actor === 'anonymous' ? { actor: record.actor } : {}),
    ...(typeof record.apiKeyId === 'string' ? { apiKeyId: record.apiKeyId } : {}),
    ...(typeof record.apiKeyPrefix === 'string' ? { apiKeyPrefix: record.apiKeyPrefix } : {}),
    ...(typeof record.workspaceId === 'string' ? { workspaceId: record.workspaceId } : {}),
    ...(Array.isArray(record.path) ? { path: record.path.map(normalizeAttempt) } : {}),
  };
}

function normalizeAttempt(attempt: UsageAttempt): UsageAttempt {
  return {
    dispatched: attempt.dispatched,
    outcome: attempt.outcome,
    ...(typeof attempt.connectionId === 'string' ? { connectionId: attempt.connectionId } : {}),
    ...(typeof attempt.providerId === 'string' ? { providerId: attempt.providerId } : {}),
    ...(typeof attempt.errorCode === 'string' ? { errorCode: attempt.errorCode } : {}),
  };
}
