import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { atomicWrite, defaultStateDirectory, ensureSecureDirectory, readOptionalText } from './secure-store.js';

/** Public metadata for a gateway key. The secret itself is never stored or returned again. */
export type ApiKeyRecord = {
  id: string;
  name: string;
  /** Displayable leading characters, for example `ohk_a1b2c3d4`. */
  prefix: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
};

/** A freshly minted key. `key` is returned exactly once, at creation time. */
export type CreatedApiKey = {
  record: ApiKeyRecord;
  key: string;
};

export interface ApiKeyStore {
  list(): Promise<ApiKeyRecord[]>;
  create(name: string): Promise<CreatedApiKey>;
  setEnabled(id: string, enabled: boolean): Promise<ApiKeyRecord | undefined>;
  remove(id: string): Promise<boolean>;
  /** Resolves the record for an exact key match, or `undefined` when unknown or paused. */
  authenticate(key: string): Promise<ApiKeyRecord | undefined>;
  isEnforced(): Promise<boolean>;
  setEnforced(value: boolean): Promise<boolean>;
  /**
   * Resolves once nothing this store was asked to write is still in flight.
   *
   * Optional because most implementations have nothing to flush — an in-memory store has no pending
   * work. It is on the interface rather than checked for by type because a store that defers a
   * write and cannot be asked when it finished is the defect this exists to prevent, so the
   * capability is declared and `GatewayService.close()` relies on it.
   */
  close?(): Promise<void>;
}

export type LocalApiKeyStoreOptions = {
  directory?: string;
  /** How often `lastUsedAt` may be written to disk. 0 flushes on every authenticated call. */
  lastUsedFlushIntervalMs?: number;
};

type StoredApiKey = ApiKeyRecord & { keyHash: string };

type ApiKeyFile = {
  version: number;
  requireApiKey: boolean;
  keys: StoredApiKey[];
};

const fileVersion = 1;
const maxKeys = 50;
const maxNameLength = 80;
const maxFileBytes = 256 * 1024;
const defaultLastUsedFlushIntervalMs = 30_000;
const keyPrefix = 'ohk_';
const keySecretBytes = 32;
const keyPattern = /^ohk_[A-Za-z0-9_-]{43}$/;
const idPrefix = 'key_';

export class ApiKeyLimitError extends Error {
  constructor(message = 'The local API key limit has been reached.') {
    super(message);
    this.name = 'ApiKeyLimitError';
  }
}

export class InMemoryApiKeyStore implements ApiKeyStore {
  private keys = new Map<string, StoredApiKey>();
  private enforced = true;

  async list() {
    return [...this.keys.values()].map((stored) => toRecord(stored)).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async create(name: string) {
    const normalizedName = normalizeName(name);
    if (this.keys.size >= maxKeys) throw new ApiKeyLimitError();
    const secret = `${keyPrefix}${randomBytes(keySecretBytes).toString('base64url')}`;
    const now = new Date().toISOString();
    const stored: StoredApiKey = {
      id: `${idPrefix}${randomBytes(9).toString('base64url')}`,
      name: normalizedName,
      prefix: secret.slice(0, keyPrefix.length + 8),
      keyHash: hashKey(secret),
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    this.keys.set(stored.id, stored);
    return { record: toRecord(stored), key: secret };
  }

  async setEnabled(id: string, enabled: boolean) {
    const existing = this.keys.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, enabled, updatedAt: new Date().toISOString() };
    this.keys.set(id, updated);
    return toRecord(updated);
  }

  async remove(id: string) {
    return this.keys.delete(id);
  }

  async authenticate(key: string) {
    return matchKey(this.keys.values(), key);
  }

  async isEnforced() {
    return this.enforced;
  }

  async setEnforced(value: boolean) {
    this.enforced = value;
    return value;
  }
}

export class LocalApiKeyStore implements ApiKeyStore {
  private readonly directory: string;
  private readonly filePath: string;
  private readonly lastUsedFlushIntervalMs: number;
  private keys = new Map<string, StoredApiKey>();
  private enforced = true;
  private mutationQueue: Promise<void> = Promise.resolve();
  private loadPromise?: Promise<void>;
  private lastUsedFlushAt = 0;

  constructor(options: LocalApiKeyStoreOptions = {}) {
    this.directory = options.directory ?? defaultStateDirectory();
    this.filePath = join(this.directory, 'api-keys.json');
    this.lastUsedFlushIntervalMs = options.lastUsedFlushIntervalMs ?? defaultLastUsedFlushIntervalMs;
  }

  /**
   * Waits until no write is in flight, and never rejects.
   *
   * `authenticate` records `lastUsedAt` with a bare `void`, and that is deliberate: authentication
   * runs on every request, so awaiting a disk write would put I/O on the hot path. The cost of that
   * decision is that `authenticate` resolves while its own write is still queued, so the store needs
   * a way for a caller to find out when the disk has caught up. Without one, two things go wrong and
   * both are silent:
   *
   * - a shutdown that calls `process.exit` drops the last `lastUsedAt` it was told to record;
   * - anything that removes the store's directory — a test's cleanup, an operator clearing state —
   *   races the pending write, which recreates the file mid-removal and fails with `ENOTEMPTY`.
   *   That second one is not theoretical: it is the only reason the gateway suite failed in CI.
   *
   * The loop drains until the queue stops advancing, because awaiting a snapshot of the queue only
   * covers work already queued at that moment. It assumes the caller has stopped accepting requests
   * first — `GatewayService.close()` does exactly that, closing the server before draining — so
   * there is no traffic to re-fill the queue and the loop terminates.
   *
   * Errors are swallowed for the same reason `touchLastUsed` swallows them: a failure to record
   * when a key was last used must not fail the request that used it, and by the time a caller
   * drains there is no request left to fail.
   */
  async close(): Promise<void> {
    let queued: Promise<void>;
    do {
      queued = this.mutationQueue;
      await queued;
    } while (this.mutationQueue !== queued);
  }

  async list() {
    await this.mutationQueue;
    await this.ensureLoaded();
    return [...this.keys.values()].map((stored) => toRecord(stored)).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async create(name: string) {
    return this.withMutation(async () => {
      const normalizedName = normalizeName(name);
      await this.ensureLoaded();
      if (this.keys.size >= maxKeys) throw new ApiKeyLimitError();
      const secret = `${keyPrefix}${randomBytes(keySecretBytes).toString('base64url')}`;
      const now = new Date().toISOString();
      const stored: StoredApiKey = {
        id: `${idPrefix}${randomBytes(9).toString('base64url')}`,
        name: normalizedName,
        prefix: secret.slice(0, keyPrefix.length + 8),
        keyHash: hashKey(secret),
        enabled: true,
        createdAt: now,
        updatedAt: now,
      };
      const previous = new Map(this.keys);
      this.keys.set(stored.id, stored);
      try {
        await this.persist();
      } catch (error) {
        this.keys = previous;
        await this.persist().catch(() => undefined);
        throw error;
      }
      return { record: toRecord(stored), key: secret };
    });
  }

  async setEnabled(id: string, enabled: boolean) {
    return this.withMutation(async () => {
      await this.ensureLoaded();
      const existing = this.keys.get(id);
      if (!existing) return undefined;
      const updated = { ...existing, enabled, updatedAt: new Date().toISOString() };
      this.keys.set(id, updated);
      try {
        await this.persist();
      } catch (error) {
        this.keys.set(id, existing);
        await this.persist().catch(() => undefined);
        throw error;
      }
      return toRecord(updated);
    });
  }

  async remove(id: string) {
    return this.withMutation(async () => {
      await this.ensureLoaded();
      if (!this.keys.has(id)) return false;
      const previous = new Map(this.keys);
      this.keys.delete(id);
      try {
        await this.persist();
      } catch (error) {
        this.keys = previous;
        await this.persist().catch(() => undefined);
        throw error;
      }
      return true;
    });
  }

  async authenticate(key: string) {
    await this.mutationQueue;
    await this.ensureLoaded();
    const matched = matchKey(this.keys.values(), key);
    // Best-effort usage tracking: a failed audit write must never fail a request.
    if (matched) void this.touchLastUsed(matched.id);
    return matched;
  }

  async isEnforced() {
    await this.ensureLoaded();
    return this.enforced;
  }

  async setEnforced(value: boolean) {
    return this.withMutation(async () => {
      await this.ensureLoaded();
      const previous = this.enforced;
      this.enforced = value;
      try {
        await this.persist();
      } catch (error) {
        this.enforced = previous;
        await this.persist().catch(() => undefined);
        throw error;
      }
      return value;
    });
  }

  private async touchLastUsed(id: string) {
    const now = Date.now();
    if (now - this.lastUsedFlushAt < this.lastUsedFlushIntervalMs) return;
    this.lastUsedFlushAt = now;
    await this.withMutation(async () => {
      await this.ensureLoaded();
      const existing = this.keys.get(id);
      if (!existing) return;
      this.keys.set(id, { ...existing, lastUsedAt: new Date().toISOString() });
      await this.persist().catch(() => undefined);
    }).catch(() => undefined);
  }

  private async withMutation<T>(operation: () => Promise<T>) {
    const previous = this.mutationQueue;
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.mutationQueue = current;
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.mutationQueue === current) this.mutationQueue = Promise.resolve();
    }
  }

  private async ensureLoaded() {
    if (!this.loadPromise) {
      this.loadPromise = this.load().catch((error: unknown) => {
        this.loadPromise = undefined;
        throw error;
      });
    }
    await this.loadPromise;
  }

  private async load() {
    const text = await readOptionalText(this.filePath, maxFileBytes);
    const parsed = parseApiKeyFile(text);
    this.keys = parsed.keys;
    this.enforced = parsed.requireApiKey;
  }

  private async persist() {
    const payload = JSON.stringify({ version: fileVersion, requireApiKey: this.enforced, keys: [...this.keys.values()] } satisfies ApiKeyFile, null, 2) + '\n';
    if (Buffer.byteLength(payload, 'utf8') > maxFileBytes) throw new ApiKeyLimitError('The local API key store exceeds the size limit.');
    await ensureSecureDirectory(this.directory);
    await atomicWrite(this.filePath, payload);
  }
}

export function isApiKeySecret(value: string) {
  return keyPattern.test(value);
}

function matchKey(keys: Iterable<StoredApiKey>, key: string) {
  if (typeof key !== 'string' || !keyPattern.test(key)) return undefined;
  const candidate = Buffer.from(hashKey(key), 'hex');
  let matched: StoredApiKey | undefined;
  // Every stored key is compared so a match cannot be found by response timing.
  for (const stored of keys) {
    const expected = Buffer.from(stored.keyHash, 'hex');
    if (expected.length === candidate.length && timingSafeEqual(candidate, expected) && stored.enabled && !matched) matched = stored;
  }
  return matched ? toRecord(matched) : undefined;
}

function hashKey(key: string) {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

function normalizeName(name: string) {
  if (typeof name !== 'string') throw new Error('API key name must be a string.');
  const normalized = name.trim();
  if (!normalized || normalized.length > maxNameLength || /[\r\n\0]/.test(normalized)) throw new Error(`API key name must be between 1 and ${maxNameLength} characters.`);
  return normalized;
}

function toRecord(stored: StoredApiKey): ApiKeyRecord {
  return {
    id: stored.id,
    name: stored.name,
    prefix: stored.prefix,
    enabled: stored.enabled,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    ...(stored.lastUsedAt === undefined ? {} : { lastUsedAt: stored.lastUsedAt }),
  };
}

function parseApiKeyFile(text: string | undefined) {
  if (!text) return { requireApiKey: true, keys: new Map<string, StoredApiKey>() };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error('Local API key store is not valid JSON.');
  }
  if (!isRecord(parsed) || parsed.version !== fileVersion || typeof parsed.requireApiKey !== 'boolean' || !Array.isArray(parsed.keys) || parsed.keys.length > maxKeys) {
    throw new Error('Local API key store has an unsupported format.');
  }
  const keys = new Map<string, StoredApiKey>();
  for (const item of parsed.keys) {
    const stored = parseStoredKey(item);
    keys.set(stored.id, stored);
  }
  return { requireApiKey: parsed.requireApiKey, keys };
}

function parseStoredKey(value: unknown): StoredApiKey {
  if (!isRecord(value) || typeof value.id !== 'string' || !/^key_[A-Za-z0-9_-]{1,32}$/.test(value.id) || typeof value.name !== 'string' || typeof value.prefix !== 'string' || !value.prefix.startsWith(keyPrefix) || typeof value.keyHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.keyHash) || typeof value.enabled !== 'boolean' || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') {
    throw new Error('Local API key store contains an invalid key.');
  }
  if (value.lastUsedAt !== undefined && typeof value.lastUsedAt !== 'string') throw new Error('Local API key store contains an invalid key.');
  return {
    id: value.id,
    name: normalizeName(value.name),
    prefix: value.prefix,
    keyHash: value.keyHash,
    enabled: value.enabled,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.lastUsedAt === undefined ? {} : { lastUsedAt: value.lastUsedAt }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
