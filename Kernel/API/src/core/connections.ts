import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertSafeProviderRequestUrl, type ModelImportPolicy, type ProviderCapabilities, type ProviderCredential, type ProviderId } from './index.js';;
import { atomicWrite, defaultStateDirectory, ensureSecureDirectory, isNodeError, readOptionalFile, readOptionalText } from './secure-store.js';
import { DEFAULT_TIMEOUT_MS } from './timeout-policy.js';
import type { ConnectionSecretStore } from './runtime.js';
/** The SDK's provider-keyed, read-only store. Aliased so the two are never confused at a call site. */
import { SecretStore as ProviderSecretStore } from './index.js';;

/**
 * What a provider's catalog said about one model, kept so the dashboard can filter on it
 * without asking the provider again. Everything is optional because catalogs differ: a
 * minimal OpenAI-compatible `/v1/models` states nothing beyond an id, and an absent field
 * must stay absent rather than defaulting to something the provider never claimed.
 *
 * Keys are short because this is written into a metadata file with a hard size cap, and
 * a full catalog runs to hundreds of entries per connection.
 */
export type ModelMeta = {
  /** The provider's own wire id, when it differs from the public id this entry is keyed by. */
  u?: string;
  /** Display name. */
  n?: string;
  /** Context window in tokens. */
  c?: number;
  /** Maximum output tokens the provider stated. */
  mo?: number;
  /** Declared input modalities, e.g. `['text', 'image']`. */
  i?: readonly string[];
  /** Declared output modalities. */
  o?: readonly string[];
  /**
   * Per 1M tokens in `modelMetaPriceOrder`. A `null` slot means the provider did not state that
   * dimension. Sparse arrays used to be dropped into the slots from the left, which made an
   * output-only price read as an input price — the fixed positions are the fix.
   */
  p?: readonly (number | null)[];
  /** Provider description of the model. */
  d?: string;
  /** Alternate ids the provider publishes. */
  a?: readonly string[];
  /** Release date, knowledge cutoff and expiry, when published. */
  cr?: string;
  kc?: string;
  ex?: string;
  /** Provider-stated capabilities, e.g. `tools` or `reasoning`. */
  cp?: ProviderCapabilities;
  /** Provider's model_type when published. */
  mt?: string;
  /** Provider's own status, canonical name and tokenizer. */
  st?: string;
  cs?: string;
  tk?: string;
  /** Parameter names the provider says it accepts. */
  sp?: readonly string[];
  /** Reasoning shape the provider published. */
  rs?: { de?: boolean; ma?: boolean; eff?: string; efforts?: readonly string[] };
  /** `provider`, `static-catalog` or `heuristic` — a heuristic fact is labelled as one. */
  src?: string;
};

/** Everything a provider's catalog told us, keyed by model id. */
export type ModelMetaMap = Record<string, ModelMeta>;

/** The four prices, in the order `ModelMeta.p` stores them. */
export const modelMetaPriceOrder = ['inputPer1M', 'outputPer1M', 'cacheReadPer1M', 'cacheWritePer1M'] as const;

export type ConnectionRecord = {
  id: string;
  providerId: ProviderId;
  /**
   * The **other** providers this one connection also serves, when they share its credential.
   *
   * The general mechanism for one account behind two cards. No card uses it today: Cline and ClinePass
   * were the case, and they are separate connections, grants and catalogs now. It remains because it is
   * still the expressible shape for a genuine shared account, and because credential lookup has to
   * honour records written while it was in use.
   */
  providers?: ProviderId[];
  /**
   * The connection whose stored credential this one uses, when it deliberately shares one.
   *
   * Unlike `providerAlias`, this is a per-record link: it names the exact account, it is visible on
   * the card, and it does not make every request for the provider follow a global map. The link is
   * carried only by a record with no credential of its own (`type: 'none'`); a save that stores a real
   * credential clears it, so a migration-era alias cannot keep serving the owner's token.
   */
  credentialConnectionId?: string;
  name: string;
  endpoint: string;
  priority: number;
  proxyPool: string;
  enabled: boolean;
  /** Allowance tier for routing preference; absent on older records. */
  quotaTier?: QuotaTier;
  /** Optional workspace this connection belongs to (multi-user foundation); absent means unscoped. */
  workspaceId?: string;
  hasCredential: boolean;
  /** Share traffic with the other balanced connections at the same priority, instead of always taking the first. */
  balance?: boolean;
  modelPolicy: ModelImportPolicy;
  modelIds: string[];
  customModelIds: string[];
  /** Catalog metadata for `modelIds`, when the provider stated any. */
  modelMeta?: ModelMetaMap;
  resilience: ResilienceSettings;
  /**
   * Who is accountable for this connection, and what it is for.
   *
   * Free text on purpose. A connection is a shared resource — a team's Kiro account is not owned by the
   * person who happened to sign in — and every attempt to model ownership as an enum (role, team id,
   * billing owner) fit one organisation and misdescribed the next. This records the two facts a reader
   * actually needs when a key stops working: **who to ask**, and **what traffic is expected to use it**.
   *
   * Optional, and absent means "not recorded" rather than "unowned": an existing connection keeps
   * working unchanged and the page shows the field as empty.
   */
  responsibility?: ConnectionResponsibility;
  createdAt: string;
  updatedAt: string;
  /** How many turns this connection has successfully served. Undefined until the first. */
  requestCount?: number;
  /** ISO timestamp of the last successful catalog read, or absent when it has never been read. */
  catalogRefreshedAt?: string;
  /** ISO timestamp of the last successfully served turn. Undefined until the first. */
  lastUsed?: string;
  /** The account identity the credential carries (an OAuth email), when it has one. */
  email?: string;
  /** The kind of credential this connection holds — for the account row's badge. Never the value. */
  credentialType?: 'oauth' | 'api-key' | 'none';
  /**
   * A vault-local, non-reversible fingerprint of the stored credential, for duplicate detection.
   *
   * An HMAC keyed by the vault's own master key, truncated: the same key in another vault produces a
   * different value, so this cannot be compared across vaults or against a precomputed table. It is
   * what lets a save recognise "this key is already account 2" without ever decrypting a credential to
   * compare, and it is metadata — never the secret, and never anything a secret can be recovered from.
   */
  credentialFingerprint?: string;
};

/** The ownership note a person writes on a connection. */
export type ConnectionResponsibility = {
  /** Who to contact about this credential — a person, a team, a mailbox. */
  owner?: string;
  /** What this connection is expected to serve, in the owner's words. */
  purpose?: string;
};

/** Per-connection limits applied to every request routed through it. */
export type ResilienceSettings = {
  /** Per-request budget for this connection. 0 keeps the shared default. */
  timeoutMs: number;
  /** First-token (TTFB) budget for streaming; 0 keeps the shared default. */
  ttfbMs?: number;
  /** Extra attempts after the first failure. Failures that cannot succeed on a retry are not repeated. */
  maxRetries: number;
  /** Requests allowed per minute. 0 disables the limit for this connection. */
  requestsPerMinute: number;
  /** Requests allowed in flight at once. 0 or absent disables the limit for this connection. */
  maxConcurrentRequests?: number;
  /**
   * Delay before a second connection is raced against the first. 0 disables
   * hedging. The hedge is only sent when another candidate can serve the model,
   * so a single connection never pays for it.
   */
  hedgeAfterMs: number;
};

/** A connection's allowance tier, used to prefer paid accounts over cheap/free ones when both can serve. */
export type QuotaTier = 'paid' | 'cheap' | 'free';
export const quotaTierOrder: Record<QuotaTier, number> = { paid: 0, cheap: 1, free: 2 };

export type ConnectionInput = {
  id?: string;
  providerId: ProviderId;
  name: string;
  endpoint: string;
  priority: number;
  proxyPool: string;
  enabled?: boolean;
  quotaTier?: QuotaTier;
  workspaceId?: string;
  /** Set by the store on every save; not part of a caller's input in practice. */
  credentialFingerprint?: string;
  modelPolicy?: ModelImportPolicy;
  modelIds?: string[];
  customModelIds?: string[];
  /** Other providers that share this record's credential — see `ConnectionRecord.providers`. */
  providers?: ProviderId[];
  /** The connection whose credential this record uses — see `ConnectionRecord.credentialConnectionId`. */
  credentialConnectionId?: string;
  modelMeta?: ModelMetaMap;
  /** Set when a catalog read succeeded; not a caller-supplied value. */
  catalogRefreshedAt?: string;
  resilience?: Partial<ResilienceSettings>;
  responsibility?: ConnectionResponsibility;
};

export const defaultResilienceSettings: ResilienceSettings = {
  /**
   * `DEFAULT_TIMEOUT_MS`, and it used to be zero — which meant *no deadline at all*.
   *
   * A connection saved without an explicit timeout inherited that zero, so by default a provider
   * that stopped responding held the request open indefinitely: the client hung, the browser spun,
   * and nothing in the gateway noticed. Both the deadline enforcement and `docs/SPEC-SDK.md` state
   * the opposite, so the code contradicted its own documented guarantee.
   *
   * The value comes from `timeout-policy.ts` so that "what does a timeout of 0 mean" is answered in
   * one place. Only connections saved *after* this change are affected, because an existing
   * connection's own settings win over the default.
   */
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxRetries: 1,
  /** Zero means no limit, which is right for a local single-user gateway. Deliberate. */
  requestsPerMinute: 0,
  hedgeAfterMs: 0,
};

export const resilienceLimits = {
  timeoutMs: { min: 0, max: 600_000 },
  ttfbMs: { min: 0, max: 600_000 },
  maxRetries: { min: 0, max: 5 },
  requestsPerMinute: { min: 0, max: 100_000 },
  maxConcurrentRequests: { min: 0, max: 1_000 },
  hedgeAfterMs: { min: 0, max: 30_000 },
} as const;

/**
 * @deprecated Declared and never used, and a trap: it extends the SDK's *provider*-keyed
 * `SecretStore`, so it looked like the gateway's writable credential store while having a different
 * key and a different shape. Use `ConnectionSecretStore` from `./runtime.js`, which is the one the
 * gateway actually depends on.
 */
export interface WritableSecretStore extends ProviderSecretStore {
  set(providerId: ProviderId, credential: ProviderCredential): Promise<void>;
  delete(providerId: ProviderId): Promise<boolean>;
}

/**
 * Credentials are addressed per connection rather than per provider, so one
 * provider can hold several. `providerId` stays optional on `get` because that
 * is where an environment credential is found.
 */
/**
 * @deprecated Use `ConnectionSecretStore` from `./runtime.js`. This was the same shape under a name that
 * described where it lived rather than what it does, which is why the service's dependency on it
 * had to be written as a `Pick` and read as a question about the local file store.
 */
export type ConnectionCredentialStore = ConnectionSecretStore;

export interface ConnectionStore extends ConnectionCredentialStore {
  list(): Promise<ConnectionRecord[]>;
  /** One record by connection id, without cloning the entire vault. */
  getRecord(connectionId: string): Promise<ConnectionRecord | undefined>;
  save(input: ConnectionInput, credential: ProviderCredential): Promise<ConnectionRecord>;
  /**
   * @param options.replace Set by a catalog rescan. The provider is the authority on what
   *   it serves, so a rescan **replaces** the discovered set rather than adding to it —
   *   otherwise a model the provider has withdrawn is kept forever, and the union marks it
   *   as a custom addition, which is how a stale id becomes impossible to remove. Adding
   *   is the default, because that is what the "add model" control means.
   */
  updateModels(connectionId: string, modelIds: string[], modelMeta?: ModelMetaMap, options?: { replace?: boolean }): Promise<ConnectionRecord | undefined>;
  /**
   * Removes model ids, and only ones this gateway added.
   *
   * `customModelIds` is the record of what the add-model control wrote, so that is the list which shrinks —
   * removing an id the *provider* reported would be undone by the next "Update models", which republishes the
   * provider's catalog, so pretending otherwise would be a removal that comes back. An **empty** `modelIds`
   * means every addition: the operator clearing their own list. It cannot mean "empty the catalog", because
   * that catalogue is the provider's answer and not the operator's to erase.
   *
   * Returns `undefined` when nothing was removed, which is what makes "there was nothing to remove" different
   * from "removed an empty set" for a caller that reports either.
   */
  removeModels(connectionId: string, modelIds: string[]): Promise<ConnectionRecord | undefined>;
  updateResilience(connectionId: string, resilience: Partial<ResilienceSettings>): Promise<ConnectionRecord | undefined>;
  /** Writes the ownership note; `undefined` clears it. */
  setResponsibility(connectionId: string, responsibility: ConnectionResponsibility | undefined): Promise<ConnectionRecord | undefined>;
  /** Pauses or resumes one connection. Metadata-only, like the note: no credential is re-validated. */
  setEnabled(connectionId: string, enabled: boolean): Promise<ConnectionRecord | undefined>;
  /** The vault-local fingerprint of a credential, for recognising one that is already saved. */
  credentialFingerprint(providerId: string, credential: ProviderCredential): Promise<string>;
  remove(connectionId: string): Promise<boolean>;
  /** Increments the connection’s successful-turn counter and stamps lastUsed. */
  recordUsage(connectionId: string): Promise<void>;
  /** Persists a coalesced usage counter now. Optional for stores that have nothing to flush. */
  flushUsage?(): Promise<void>;
  /**
   * Per account-and-model cooldowns, keyed `<connectionId>:<modelId>`.
   *
   * Read at startup and written on change, so an exhausted account stays stood down across a restart
   * — the reference implementation keeps its `modelLock_*` fields in the database for the same reason.
   */
  listCooldowns(): Promise<Record<string, ModelCooldown>>;
  /** Writes one cooldown; `undefined` clears it. Expired entries are dropped rather than accumulating. */
  setCooldown(key: string, cooldown: ModelCooldown | undefined): Promise<void>;
  /**
   * Backup support: the vault's whole configuration — every connection with its credential, the
   * provider strategies and the model aliases.
   *
   * Optional, as on `ApiKeyStore`, so an embedded store need not offer it. A section a store cannot
   * export is a section the backup leaves out and says it left out, rather than one it silently
   * pretends to carry.
   */
  exportState?(): Promise<ConnectionsBackupState>;
  /** Replaces the whole vault from a backup section, validating before it mutates. See `parseConnectionsBackupState`. */
  importState?(state: ConnectionsBackupState): Promise<void>;
}

/**
 * A connection as a backup carries it.
 *
 * The record's own configuration, less the fields the store derives, because carrying those is how a
 * backup starts lying about the machine it lands on:
 *
 * - `hasCredential`, `credentialType` and `email` are recomputed from the credential by `withPreview`,
 *   so a stored copy is a second answer to a question the credential already answers;
 * - `credentialFingerprint` is keyed by **this** vault's master key. A fingerprint copied from another
 *   vault names a credential this installation has never seen, and an in-memory store's fingerprint is
 *   an unkeyed hash of the same value — so a carried one could match a key the user pastes later and
 *   refuse it as a duplicate. Dropped; the next save mints one here;
 * - `requestCount` and `lastUsed` count traffic that happened on the source machine, which is usage, not
 *   configuration. Model cooldowns are the same kind of thing and are not carried either.
 */
export type BackupConnection = {
  connection: Omit<ConnectionRecord, 'hasCredential' | 'credentialFingerprint' | 'credentialType' | 'email' | 'requestCount' | 'lastUsed'>;
  /**
   * Absent when the connection has no credential at all.
   *
   * Absent, not skipped: the version-1 export dropped such a connection from the payload entirely, so a
   * keyless connection — the canonical one being Ollama — vanished on import. A connection is
   * configuration whether or not a secret sits behind it.
   */
  credential?: ProviderCredential;
};

/** One vault's configuration, as a backup section holds it. */
export type ConnectionsBackupState = {
  connections: BackupConnection[];
  strategies: Record<string, ProviderStrategy>;
  aliases: Record<string, ModelAlias>;
};

export type LocalConnectionStoreOptions = {
  directory?: string;
  fallback?: ProviderSecretStore;
  masterKey?: Uint8Array;
};

const metadataVersion = 1;
const secretEnvelopeVersion = 1;
/**
 * How large the metadata file may grow.
 *
 * It was a flat 256 KiB, and a real vault reached **262,137 bytes of the 262,144** — so the next
 * connection could not be added at all, and the refusal quoted a limit the person had no part in
 * choosing. Two things were wrong with it:
 *
 * - the payload was written **pretty-printed**, so indentation was ~42% of the budget (262 KiB of
 *   whitespace-bearing JSON is 148 KiB of actual data) for a file nothing reads by eye;
 * - the ceiling was sized for a handful of providers rather than a vault of 250 connections, several
 *   of which carry an aggregator's thousand-model catalogue.
 *
 * `OMNIHILBRAS_MAX_METADATA_BYTES` moves it without a release; a value that is not a positive integer
 * keeps the default rather than making the vault unopenable.
 */
export function resolveMaxMetadataBytes(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const fallback = 4 * 1024 * 1024;
  const raw = env.OMNIHILBRAS_MAX_METADATA_BYTES?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}
/** Catalog metadata is bounded so a large catalog cannot fill the metadata file. */
const maxModelMetaEntries = 2_000;
const maxSecretEnvelopeBytes = 1024 * 1024;
/**
 * How many connections this vault holds.
 *
 * It was a flat 100, and the catalogue alone is 56 cards: a person with two accounts on a handful of
 * providers crosses it without doing anything unusual — one vault measured here had **113**, and every
 * save past the limit was refused with a sentence that said nothing. The bound still exists (a vault is a
 * file, and an unbounded one is not a data structure, it is a leak), but it is now high enough not to be
 * a surprise, and `OMNIHILBRAS_MAX_CONNECTIONS` moves it without a release.
 */
export function resolveMaxConnections(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env.OMNIHILBRAS_MAX_CONNECTIONS?.trim();
  if (!raw) return 250;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return 250;
  return parsed;
}

/** A vault that has reached its bound. Typed, so the reason can travel to the person who hit it. */
export class ConnectionLimitError extends Error {
  constructor(message = 'This vault has reached its connection limit. Remove a connection, or raise OMNIHILBRAS_MAX_CONNECTIONS.') {
    super(message);
    this.name = 'ConnectionLimitError';
  }
}

const maxDiscoveredModelIds = 2_000;
const maxCustomModelIds = 2_000;
const maxConnectionModelIds = maxDiscoveredModelIds + maxCustomModelIds;
const credentialAad = Buffer.from('omnihilbras-credentials-v1');

export class ConnectionModelLimitError extends Error {
  constructor(message = 'The model catalog exceeds its configured limit.') {
    super(message);
    this.name = 'ConnectionModelLimitError';
  }
}

export class ConnectionMetadataLimitError extends Error {
  constructor(message = 'The local connection metadata exceeds the size limit.') {
    super(message);
    this.name = 'ConnectionMetadataLimitError';
  }
}

type EncryptedSecretEnvelope = {
  version: number;
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
};

/**
 * One account's cooling-down state for one model.
 *
 * `level` is how many consecutive refusals this pair has produced without an intervening success, and
 * it is what makes the wait grow. Both travel with the vault rather than living in memory: ours were
 * lost on every restart, and a restart happens on every release, so an account that had just been told
 * to wait was immediately eligible again and the first request after each restart re-hammered it.
 */
export type ModelCooldown = { until: number; level: number };

type MetadataEnvelope = {
  version: number;
  connections: ConnectionRecord[];
  /** How a provider's connections share traffic. Absent means the default, priority. */
  strategies?: Record<string, ProviderStrategy>;
  /** A requested model name mapped to the provider and model it should reach. */
  aliases?: Record<string, ModelAlias>;
  /** Per account-and-model cooldowns, keyed `<connectionId>:<modelId>`. Absent means nothing is cooling. */
  cooldowns?: Record<string, ModelCooldown>;
};

/** How connections of one provider are chosen. `priority` is the default, and it is what a file without a strategy means. */
/**
 * How a provider's connections share traffic.
 *
 * - `priority` — the default: the lowest priority number first, then by name;
 * - `round-robin` — balanced across every connection of the provider;
 * - `fastest` — same-priority connections ordered by measured round trip, unmeasured last.
 */
export type ProviderStrategy = 'priority' | 'round-robin' | 'fastest';

/** Where a requested model name is sent: a connected provider and the model id it publishes. */
export type ModelAlias = { providerId: string; model: string };
const providerStrategies: readonly ProviderStrategy[] = ['priority', 'round-robin', 'fastest'];

export function defaultConnectionDirectory(env: Readonly<Record<string, string | undefined>> = process.env) {
  return defaultStateDirectory(env);
}

export function parseMasterKey(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalizeMasterKey(decodeConfiguredMasterKey(normalized)) : undefined;
}

export class InMemoryConnectionStore implements ConnectionStore, ConnectionSecretStore {
  private readonly maxConnections = resolveMaxConnections();
  private readonly credentials = new Map<ProviderId, ProviderCredential>();
  private readonly connections = new Map<string, ConnectionRecord>();
  /** Held only for the life of the process, which is what "in memory" means; `LocalConnectionStore` persists. */
  private readonly modelCooldowns = new Map<string, ModelCooldown>();

  constructor(private readonly fallback?: ProviderSecretStore) {}

  async get(providerId: ProviderId) {
    return this.credentials.get(providerId) ?? this.fallback?.get(providerId);
  }

  async set(providerId: ProviderId, credential: ProviderCredential) {
    this.credentials.set(providerId, storedCredential(credential));
  }

  async delete(providerId: ProviderId) {
    return this.credentials.delete(providerId);
  }

  async list() {
    return [...this.connections.values()].map((connection) => this.withPreview(connection));
  }

  async getRecord(connectionId: string) {
    const connection = this.connections.get(connectionId);
    return connection ? this.withPreview(connection) : undefined;
  }

  /**
   * The record as the gateway's readers see it: whether a credential exists, and the two facts about
   * it that are preview data rather than secrets — an OAuth account's email and the credential's kind.
   * Shared by `list()` and `save()` so a saved record and a listed one cannot disagree, which is the
   * drift that made a test comparing the two fail the moment only one of them was decorated.
   */
  private withPreview(connection: ConnectionRecord): ConnectionRecord {
    const credential = this.credentials.get(connection.id);
    const email = credential?.type === 'oauth' && typeof credential.email === 'string' && credential.email ? credential.email : undefined;
    const record = cloneRecord({ ...connection, hasCredential: this.credentials.has(connection.id), ...(email ? { email } : {}), ...(credential ? { credentialType: credential.type } : {}) });
    // The fingerprint is credential-adjacent and exists for the store's duplicate check, which reads
    // records returned by `list()`. Keep it readable there and non-enumerable, so spreading a record
    // or serialising it over HTTP cannot carry it to a management reader.
    if (connection.credentialFingerprint) Object.defineProperty(record, 'credentialFingerprint', { value: connection.credentialFingerprint, enumerable: false, configurable: true });
    return record;
  }

  async save(input: ConnectionInput, credential: ProviderCredential) {
    const normalized = normalizeInput(input);
    const id = normalized.id ?? this.findIdForProvider(normalized.providerId) ?? normalized.providerId;
    const existing = this.connections.get(id);
    if (existing && existing.providerId !== normalized.providerId) throw new Error('Connection ID is already used by another provider.');
    if (!existing && this.connections.size >= this.maxConnections) throw new ConnectionLimitError();

    // The fingerprint rides with the record so a later save can recognise the same credential without
    // decrypting anything to compare.
    const fingerprint = credentialFingerprintFor(normalized.providerId, credential.type === 'none' ? 'none' : credential.value);
    const record = buildRecord({ ...normalized, id, credentialFingerprint: fingerprint }, existing, credential);
    this.connections.set(id, record);
    this.credentials.set(id, storedCredential(credential));
    return this.withPreview(record);
  }

  async updateModels(connectionId: string, modelIds: string[], modelMeta?: ModelMetaMap, options: { replace?: boolean } = {}) {
    const record = this.connections.get(connectionId);
    if (!record) return undefined;
    const merged = options.replace
      ? { modelIds: normalizeModelIds(modelIds, maxConnectionModelIds) }
      : mergeAddedModelIds(record, modelIds);
    // A rescan that found the same ids still learned new metadata, so the metadata is
    // not gated on the id list having changed.
    if (!merged && !modelMeta) return cloneRecord(record);
    const updated = { ...record, ...merged, ...(modelMeta ? { modelMeta } : {}), ...(options.replace ? { catalogRefreshedAt: new Date().toISOString() } : {}), updatedAt: new Date().toISOString() };
    this.connections.set(connectionId, updated);
    return cloneRecord(updated);
  }

  async removeModels(connectionId: string, modelIds: string[]) {
    const record = this.connections.get(connectionId);
    if (!record) return undefined;
    const removed = mergeRemovedModelIds(record, modelIds);
    if (!removed) return undefined;
    const updated = { ...record, ...removed, updatedAt: new Date().toISOString() };
    this.connections.set(connectionId, updated);
    return cloneRecord(updated);
  }

  async updateResilience(connectionId: string, resilience: Partial<ResilienceSettings>) {
    const record = this.connections.get(connectionId);
    if (!record) return undefined;
    const updated = { ...record, resilience: normalizeResilienceSettings({ ...record.resilience, ...resilience }) };
    this.connections.set(connectionId, updated);
    return cloneRecord(updated);
  }

  async setResponsibility(connectionId: string, responsibility: ConnectionResponsibility | undefined) {
    const record = this.connections.get(connectionId);
    if (!record) return undefined;
    const { responsibility: _previous, ...rest } = record;
    const updated = responsibility && Object.keys(responsibility).length > 0
      ? { ...rest, responsibility }
      : rest;
    this.connections.set(connectionId, updated);
    return cloneRecord(updated);
  }

  async setEnabled(connectionId: string, enabled: boolean) {
    const record = this.connections.get(connectionId);
    if (!record) return undefined;
    const updated = { ...record, enabled, updatedAt: new Date().toISOString() };
    this.connections.set(connectionId, updated);
    return cloneRecord(updated);
  }

  async credentialFingerprint(providerId: string, credential: ProviderCredential) {
    return credentialFingerprintFor(providerId, credential.type === 'none' ? 'none' : credential.value);
  }

  async remove(connectionId: string) {
    const record = this.connections.get(connectionId);
    if (!record) return false;
    this.connections.delete(connectionId);
    this.credentials.delete(connectionId);
    return true;
  }

  async recordUsage(connectionId: string) {
    const record = this.connections.get(connectionId);
    if (!record) return;
    record.requestCount = (record.requestCount ?? 0) + 1;
    record.lastUsed = new Date().toISOString();
  }

  async listCooldowns(): Promise<Record<string, ModelCooldown>> {
    const now = Date.now();
    const live: Record<string, ModelCooldown> = {};
    for (const [key, cooldown] of this.modelCooldowns) if (cooldown.until > now) live[key] = cooldown;
    return live;
  }

  async setCooldown(key: string, cooldown: ModelCooldown | undefined): Promise<void> {
    if (cooldown === undefined) this.modelCooldowns.delete(key);
    else this.modelCooldowns.set(key, cooldown);
  }

  /**
   * The connections and credentials this store holds. Empty strategy and alias maps, because this store
   * has neither — an in-memory vault keeps no strategies to export, and saying so is better than a
   * section that claims a configuration it cannot hold.
   */
  async exportState(): Promise<ConnectionsBackupState> {
    return {
      connections: [...this.connections.values()].map((record) => backupConnection(record, this.credentials.get(record.id))),
      strategies: {},
      aliases: {},
    };
  }

  /** Replaces every connection and credential. Validated first, so a malformed section changes nothing. */
  async importState(state: ConnectionsBackupState): Promise<void> {
    const next = parseConnectionsBackupState(state);
    this.connections.clear();
    this.credentials.clear();
    this.modelCooldowns.clear();
    for (const entry of next.connections) {
      this.connections.set(entry.connection.id, asStoredRecord(entry));
      if (entry.credential) this.credentials.set(entry.connection.id, storedCredential(entry.credential));
    }
  }

  private findIdForProvider(providerId: ProviderId) {
    return [...this.connections.values()]
      .find((connection) => connection.providerId === providerId || connection.providers?.includes(providerId))?.id;
  }
}

/** One record and the credential behind it, in the shape a backup carries. */
function backupConnection(record: ConnectionRecord, credential: ProviderCredential | undefined): BackupConnection {
  return { connection: backupRecord(record), ...(credential ? { credential: { ...credential } } : {}) };
}

/**
 * The record without the fields the store derives — see `BackupConnection` for why each one is left out.
 *
 * `credentialFingerprint` is non-enumerable on records that came through `list()`, so it has to be removed
 * by destructuring rather than by deleting a key: a spread would have carried it anyway, which is the trap
 * the record's own comment warns about.
 */
function backupRecord(record: ConnectionRecord): BackupConnection['connection'] {
  const { hasCredential: _hasCredential, credentialFingerprint: _fingerprint, credentialType: _credentialType, email: _email, requestCount: _requestCount, lastUsed: _lastUsed, ...configuration } = record;
  return configuration;
}

/** The inverse of `backupRecord`: the stored form, with `hasCredential` answered by the credential beside it. */
function asStoredRecord(entry: BackupConnection): ConnectionRecord {
  return { ...entry.connection, hasCredential: entry.credential !== undefined };
}

/**
 * Reads a backup's connection section, strictly.
 *
 * Every credential goes through `storedCredential` — the one function the save path also writes through —
 * so a payload this function accepts is one every store in the gateway can hold. Strict, too: per-record
 * tolerance belongs on load, where a hand-edited file must not make the vault unopenable, and not here,
 * where the input is a whole vault about to replace this one. An import that quietly skips a record it
 * cannot read is an import that reports success while losing a connection, which is the version-1
 * behaviour this replaces.
 */
export function parseConnectionsBackupState(value: unknown): ConnectionsBackupState {
  if (!isRecord(value) || !Array.isArray(value.connections)) throw new Error('The backup\'s connection section is not readable.');
  if (value.connections.length > resolveMaxConnections()) throw new ConnectionLimitError();
  const connections: BackupConnection[] = [];
  const seen = new Set<string>();
  for (const entry of value.connections) {
    if (!isRecord(entry) || !isRecord(entry.connection)) throw new Error('The backup contains an unreadable connection.');
    let credential: ProviderCredential | undefined;
    try {
      credential = entry.credential === undefined ? undefined : storedCredential(entry.credential);
    } catch (error) {
      throw new Error(`The backup contains an unreadable credential: ${error instanceof Error ? error.message : 'unknown'}.`);
    }
    const record = parseRecord({ ...entry.connection, hasCredential: credential !== undefined });
    if (seen.has(record.id)) throw new Error(`The backup contains two connections with the id ${record.id}.`);
    seen.add(record.id);
    connections.push(backupConnection(record, credential));
  }
  const strategies: Record<string, ProviderStrategy> = {};
  if (value.strategies !== undefined) {
    if (!isRecord(value.strategies)) throw new Error('The backup has an invalid provider strategy map.');
    for (const [providerId, strategy] of Object.entries(value.strategies)) {
      if (!providerStrategies.includes(strategy as ProviderStrategy)) throw new Error('The backup contains an unknown provider strategy.');
      strategies[providerId] = strategy as ProviderStrategy;
    }
  }
  const aliases: Record<string, ModelAlias> = {};
  if (value.aliases !== undefined) {
    if (!isRecord(value.aliases)) throw new Error('The backup has an invalid model alias map.');
    for (const [name, target] of Object.entries(value.aliases)) {
      if (!isRecord(target) || typeof target.providerId !== 'string' || typeof target.model !== 'string' || !target.model.trim()) throw new Error('The backup contains an invalid model alias.');
      aliases[name] = { providerId: target.providerId, model: target.model };
    }
  }
  return { connections, strategies, aliases };
}

/**
 * A record, built by `save`. It always has a credential record behind it — that is what `save` means —
 * so `hasCredential` is not a parameter.
 *
 * It used to be, and both callers passed `credential.type !== 'none'`. That made the *persisted* value
 * disagree with the one `list()` recomputes (`this.credentials.has(connection.id)`, which is true for any
 * stored credential including `none`), and the disagreement had a consequence no reader could see: on
 * load, the vault prunes credentials belonging to connections whose metadata says `hasCredential: false`
 * — so a keyless connection's credential was deleted on the first restart and the connection quietly
 * stopped being a routing candidate. Two spellings of one decision, and the one that won was the wrong one.
 */
/**
 * A vault-local fingerprint of a credential, for duplicate detection.
 *
 * Keyed by the vault's master key when one exists, so the value is meaningless outside this vault; an
 * in-memory store with no key still gets a stable hash, which is what its tests need. Truncated to 32
 * hex characters: this is an equality check, and a longer value would only be a longer thing to store.
 */
function credentialFingerprintFor(providerId: string, value: string, masterKey?: Uint8Array): string {
  const digest = masterKey
    ? createHmac('sha256', Buffer.from(masterKey)).update(`${providerId}\u0000${value}`).digest('hex')
    : createHash('sha256').update(`${providerId}\u0000${value}`).digest('hex');
  return digest.slice(0, 32);
}

function buildRecord(input: ConnectionInput, existing: ConnectionRecord | undefined, credential: ProviderCredential): ConnectionRecord {
  const normalized = normalizeInput(input);
  const now = new Date().toISOString();
  const modelLists = mergeModelLists(normalized.modelIds ?? existing?.modelIds, normalized.customModelIds ?? existing?.customModelIds);
  /**
   * A record that stores a credential of its own is not a linked record.
   *
   * This used to fall back to `existing.credentialConnectionId` unconditionally, so overwriting a
   * migration-era alias (`clinepass` → `cline`) with the card's own token kept the link: the new
   * credential was written under `clinepass`, and `CredentialManager` went on reading Cline's. The
   * card looked signed in and was served by another provider's account — the exact defect that made
   * Cline and ClinePass look like one provider. Only a `none` credential (a deliberate alias) may
   * carry a link, and an explicit `credentialConnectionId` on a real-credential save is ignored rather
   * than trusted, because the invariant belongs to the store and not to every caller remembering it.
   */
  const linkedConnectionId = credential.type === 'none'
    ? (normalized.credentialConnectionId ?? existing?.credentialConnectionId)
    : undefined;
  return {
    id: input.id!,
    providerId: normalized.providerId,
    ...(normalized.providers && normalized.providers.length > 0 ? { providers: normalized.providers } : {}),
    ...(linkedConnectionId ? { credentialConnectionId: linkedConnectionId } : {}),
    name: normalized.name,
    endpoint: normalized.endpoint,
    priority: normalized.priority,
    proxyPool: normalized.proxyPool,
    ...(normalized.quotaTier ?? existing?.quotaTier ? { quotaTier: normalized.quotaTier ?? existing?.quotaTier } : {}),
    ...(normalized.workspaceId ?? existing?.workspaceId ? { workspaceId: normalized.workspaceId ?? existing?.workspaceId } : {}),
    enabled: normalized.enabled ?? existing?.enabled ?? true,
    hasCredential: true,
    // Read from the **raw** input, not `normalized`: `normalizeInput` does not carry this field (it is
    // set by the store, not by a caller), so reading it off the normalized copy meant every save wrote
    // a record with no fingerprint — the duplicate check compared a hash against `undefined` and never
    // matched, which is why the same key could be added twice over HTTP while the manager's own tests
    // (which supply fingerprints directly) passed.
    ...(input.credentialFingerprint ?? existing?.credentialFingerprint ? { credentialFingerprint: input.credentialFingerprint ?? existing?.credentialFingerprint } : {}),
    // Same reasoning for the ownership note: a save that does not mention it must not erase it, which
    // is what happened while `buildRecord` read only from the normalized input.
    ...(input.responsibility ?? existing?.responsibility ? { responsibility: input.responsibility ?? existing?.responsibility } : {}),
    modelPolicy: normalized.modelPolicy ?? existing?.modelPolicy ?? 'all',
    modelIds: modelLists.modelIds,
    customModelIds: modelLists.customModelIds,
    // **`modelMeta` was silently dropped here (1.62.0).**
    //
    // `normalizeInput` accepted and normalized it, `parseRecord` read it back off disk, `cloneRecord`
    // copied it, and `updateModels` set it — but `buildRecord`, the function that builds the record every
    // save goes through, never copied it onto the result. Measured against both stores, which is how it was
    // found: `modelMeta` returned `undefined` for a connection saved with `{ m: { p: [3, 15] } }`.
    //
    // So `modelMetaFor()` in `connection-manager.ts` has been writing discovered prices — and display names,
    // context windows, modalities — into a field nothing read. A display name missing from the model list is
    // cosmetic; a **price** missing is the difference between "this connection costs nothing" and "this
    // connection's cost is unknown", and the dashboard could not tell those apart.
    //
    // The four places that handle `modelMeta` all agreed with each other and disagreed with the one that
    // mattered, which is why a full-file reading of the store found nothing wrong.
    ...(normalized.modelMeta ?? existing?.modelMeta ? { modelMeta: normalized.modelMeta ?? existing?.modelMeta } : {}),
    ...(normalized.catalogRefreshedAt ?? existing?.catalogRefreshedAt
      ? { catalogRefreshedAt: normalized.catalogRefreshedAt ?? existing?.catalogRefreshedAt }
      : {}),
    resilience: { ...defaultResilienceSettings, ...existing?.resilience, ...normalized.resilience },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export class LocalConnectionStore implements ConnectionStore, ConnectionSecretStore {
  private readonly directory: string;
  private readonly metadataPath: string;
  private readonly secretsPath: string;
  private readonly keyPath: string;
  private readonly fallback?: ProviderSecretStore;
  private readonly configuredMasterKey?: Buffer;
  private credentials = new Map<ProviderId, ProviderCredential>();
  private connections = new Map<string, ConnectionRecord>();
  private strategies = new Map<string, ProviderStrategy>();
  private aliasMap = new Map<string, ModelAlias>();
  /** Per account-and-model cooldowns, keyed `<connectionId>:<modelId>`. */
  private modelCooldowns = new Map<string, ModelCooldown>();
  private mutationQueue: Promise<void> = Promise.resolve();
  /** A usage counter changed but has not reached disk yet. */
  private usageDirty = false;
  private usageFlushTimer?: ReturnType<typeof setTimeout>;
  private loadPromise?: Promise<void>;
  /** Resolved once, so a save cannot disagree with the load about the bound. */
  private readonly maxConnections = resolveMaxConnections();
  /** The same, for the metadata file: a load and a save must agree on how big it may be. */
  private readonly maxMetadataBytes = resolveMaxMetadataBytes();

  constructor(options: LocalConnectionStoreOptions = {}) {
    this.directory = options.directory ?? defaultConnectionDirectory();
    this.metadataPath = join(this.directory, 'connections.json');
    this.secretsPath = join(this.directory, 'secrets.enc.json');
    this.keyPath = join(this.directory, 'secrets.key');
    this.fallback = options.fallback;
    if (options.masterKey) this.configuredMasterKey = normalizeMasterKey(options.masterKey);
  }

  /**
   * Credentials are stored per connection, so one provider can hold several.
   * The provider id is still consulted as a fallback: that is where an
   * environment credential lives, and for a single-connection provider the two
   * are the same string, which is what keeps existing vaults readable.
   */
  async get(connectionId: string, providerId?: ProviderId) {
    await this.mutationQueue;
    await this.ensureLoaded();
    return this.credentials.get(connectionId) ?? (providerId ? this.fallback?.get(providerId) : undefined);
  }

  async set(connectionId: string, credential: ProviderCredential) {
    return this.withMutation(async () => {
      await this.ensureLoaded();
      const previous = this.credentials.get(connectionId);
      this.credentials.set(connectionId, storedCredential(credential));
      try {
        await this.persistSecrets();
      } catch (error) {
        if (previous) this.credentials.set(connectionId, previous);
        else this.credentials.delete(connectionId);
        throw error;
      }
    });
  }

  async delete(connectionId: string) {
    return this.withMutation(async () => {
      await this.ensureLoaded();
      const previous = this.credentials.get(connectionId);
      const deleted = this.credentials.delete(connectionId);
      if (!deleted) return false;
      try {
        await this.persistSecrets();
      } catch (error) {
        if (previous) this.credentials.set(connectionId, previous);
        throw error;
      }
      return true;
    });
  }

  async list() {
    await this.mutationQueue;
    await this.ensureLoaded();
    return [...this.connections.values()]
      .map((connection) => this.withPreview(connection))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async getRecord(connectionId: string) {
    await this.mutationQueue;
    await this.ensureLoaded();
    const connection = this.connections.get(connectionId);
    return connection ? this.withPreview(connection) : undefined;
  }

  /**
   * The record as the gateway's readers see it: whether a credential exists, and the two facts about
   * it that are preview data rather than secrets — an OAuth account's email and the credential's kind.
   * Shared with `save()` so a saved record and a listed one cannot disagree. Both stores carry this
   * copy for the same reason every vendored file is duplicated: the vault and the in-memory store are
   * separate classes, and a fix to one that skipped the other is drift.
   */
  private withPreview(connection: ConnectionRecord): ConnectionRecord {
    const credential = this.credentials.get(connection.id);
    const email = credential?.type === 'oauth' && typeof credential.email === 'string' && credential.email ? credential.email : undefined;
    const record = cloneRecord({ ...connection, hasCredential: this.credentials.has(connection.id), ...(email ? { email } : {}), ...(credential ? { credentialType: credential.type } : {}) });
    // The fingerprint is credential-adjacent and exists for the store's duplicate check, which reads
    // records returned by `list()`. Keep it readable there and non-enumerable, so spreading a record
    // or serialising it over HTTP cannot carry it to a management reader.
    if (connection.credentialFingerprint) Object.defineProperty(record, 'credentialFingerprint', { value: connection.credentialFingerprint, enumerable: false, configurable: true });
    return record;
  }

  async save(input: ConnectionInput, credential: ProviderCredential) {
    return this.withMutation(async () => {
      const normalized = normalizeInput(input);
      await this.ensureLoaded();
      const id = normalized.id ?? this.findIdForProvider(normalized.providerId) ?? normalized.providerId;
      const existing = this.connections.get(id);
      if (existing && existing.providerId !== normalized.providerId) throw new Error('Connection ID is already used by another provider.');
      if (!existing && this.connections.size >= this.maxConnections) throw new ConnectionLimitError();

      // Keyed by the connection, so a provider can hold several without the
      // newest credential overwriting the others.
      const previousCredential = this.credentials.get(id);
      const previousConnections = new Map(this.connections);
      // Keyed by the vault's master key, so the value is meaningless in another vault.
      const masterKey = await this.getMasterKey();
      const fingerprint = credentialFingerprintFor(normalized.providerId, credential.type === 'none' ? 'none' : credential.value, masterKey);
      const record = buildRecord({ ...normalized, id, credentialFingerprint: fingerprint }, existing, credential);

      this.credentials.set(id, storedCredential(credential));
      this.connections.set(id, record);
      try {
        await this.persistSecrets();
        await this.persistMetadata();
      } catch (error) {
        this.connections = previousConnections;
        if (previousCredential) this.credentials.set(id, previousCredential);
        else this.credentials.delete(id);
        await this.persistSecrets().catch(() => undefined);
        await this.persistMetadata().catch(() => undefined);
        throw error;
      }
      return this.withPreview(record);
    });
  }

  async updateModels(connectionId: string, modelIds: string[], modelMeta?: ModelMetaMap, options: { replace?: boolean } = {}) {
    return this.withMutation(async () => {
      await this.ensureLoaded();
      const record = this.connections.get(connectionId);
      if (!record) return undefined;
      /**
       * A rescan replaces rather than adds. The provider is the authority on what it
       * serves, and the additive path also files every addition as a *custom* model — so a
       * union here means a withdrawn model is kept forever and becomes impossible to
       * remove. Adding stays the default, because that is what the "add model" control
       * means.
       */
      const merged = options.replace
        ? { modelIds: normalizeModelIds(modelIds, maxConnectionModelIds) }
        : mergeAddedModelIds(record, modelIds);
      if (!merged && !modelMeta) return cloneRecord(record);
      const previous = record;
      const updated = { ...record, ...merged, ...(modelMeta ? { modelMeta } : {}), ...(options.replace ? { catalogRefreshedAt: new Date().toISOString() } : {}), updatedAt: new Date().toISOString() };
      this.connections.set(connectionId, updated);
      try {
        await this.persistMetadata();
      } catch (error) {
        this.connections.set(connectionId, previous);
        await this.persistMetadata().catch(() => undefined);
        throw error;
      }
      return cloneRecord(updated);
    });
  }

  async removeModels(connectionId: string, modelIds: string[]) {
    return this.withMutation(async () => {
      await this.ensureLoaded();
      const record = this.connections.get(connectionId);
      if (!record) return undefined;
      const removed = mergeRemovedModelIds(record, modelIds);
      if (!removed) return undefined;
      const previous = record;
      const updated = { ...record, ...removed, updatedAt: new Date().toISOString() };
      this.connections.set(connectionId, updated);
      try {
        await this.persistMetadata();
      } catch (error) {
        this.connections.set(connectionId, previous);
        await this.persistMetadata().catch(() => undefined);
        throw error;
      }
      return cloneRecord(updated);
    });
  }

  async setResponsibility(connectionId: string, responsibility: ConnectionResponsibility | undefined) {
    return this.withMutation(async () => {
      await this.ensureLoaded();
      const record = this.connections.get(connectionId);
      if (!record) return undefined;
      const { responsibility: _previous, ...rest } = record;
      const updated = responsibility && Object.keys(responsibility).length > 0
        ? { ...rest, responsibility, updatedAt: new Date().toISOString() }
        : { ...rest, updatedAt: new Date().toISOString() };
      this.connections.set(connectionId, updated);
      try {
        await this.persistMetadata();
      } catch (error) {
        this.connections.set(connectionId, record);
        throw error;
      }
      return cloneRecord(updated);
    });
  }

  async credentialFingerprint(providerId: string, credential: ProviderCredential) {
    const masterKey = await this.getMasterKey();
    return credentialFingerprintFor(providerId, credential.type === 'none' ? 'none' : credential.value, masterKey);
  }

  async setEnabled(connectionId: string, enabled: boolean) {
    return this.withMutation(async () => {
      await this.ensureLoaded();
      const record = this.connections.get(connectionId);
      if (!record) return undefined;
      const updated = { ...record, enabled, updatedAt: new Date().toISOString() };
      this.connections.set(connectionId, updated);
      try {
        await this.persistMetadata();
      } catch (error) {
        this.connections.set(connectionId, record);
        throw error;
      }
      return this.withPreview(updated);
    });
  }

  async updateResilience(connectionId: string, resilience: Partial<ResilienceSettings>) {
    return this.withMutation(async () => {
      await this.ensureLoaded();
      const record = this.connections.get(connectionId);
      if (!record) return undefined;
      const previous = record;
      const updated = { ...record, resilience: normalizeResilienceSettings({ ...record.resilience, ...resilience }), updatedAt: new Date().toISOString() };
      this.connections.set(connectionId, updated);
      try {
        await this.persistMetadata();
      } catch (error) {
        this.connections.set(connectionId, previous);
        await this.persistMetadata().catch(() => undefined);
        throw error;
      }
      return cloneRecord(updated);
    });
  }

  /** The strategy for a provider's connections. Unset means priority. */
  async strategyFor(providerId: string): Promise<ProviderStrategy> {
    await this.ensureLoaded();
    return this.strategies.get(providerId) ?? 'priority';
  }

  async aliases(): Promise<Record<string, ModelAlias>> {
    await this.ensureLoaded();
    return Object.fromEntries(this.aliasMap);
  }

  /** Saves a model alias. Refused unless the target provider has a saved connection, so an alias cannot send traffic nowhere. */
  async setAlias(name: string, target: ModelAlias): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('An alias needs a name.');
    if (!target.model.trim()) throw new Error('An alias needs a model.');
    await this.withMutation(async () => {
      await this.ensureLoaded();
      const connected = [...this.connections.values()].some((connection) => connection.providerId === target.providerId);
      if (!connected) throw new Error(`The provider ${target.providerId} is not connected, so an alias to it cannot be used.`);
      const previous = new Map(this.aliasMap);
      this.aliasMap.set(trimmed, { providerId: target.providerId, model: target.model.trim() });
      try {
        await this.persistMetadata();
      } catch (error) {
        this.aliasMap = previous;
        throw error;
      }
    });
  }

  /** Every saved provider strategy, so routing can start with them in effect. */
  async allStrategies(): Promise<Array<[string, ProviderStrategy]>> {
    await this.ensureLoaded();
    return [...this.strategies.entries()];
  }

  async setStrategy(providerId: string, strategy: string): Promise<void> {
    if (!providerStrategies.includes(strategy as ProviderStrategy)) throw new Error(`The provider strategy must be one of ${providerStrategies.join(', ')}.`);
    await this.withMutation(async () => {
      await this.ensureLoaded();
      const previous = new Map(this.strategies);
      this.strategies.set(providerId, strategy as ProviderStrategy);
      try {
        await this.persistMetadata();
      } catch (error) {
        this.strategies = previous;
        throw error;
      }
    });
  }

  /**
   * The cooldowns this vault holds, with expired ones dropped on the way out.
   *
   * Pruning here rather than on a timer: an entry has meaning only until its `until`, so an expired one
   * is not state, it is a line in a file that would otherwise grow for the life of the installation.
   */
  async listCooldowns(): Promise<Record<string, ModelCooldown>> {
    await this.ensureLoaded();
    const now = Date.now();
    const live: Record<string, ModelCooldown> = {};
    for (const [key, cooldown] of this.modelCooldowns) if (cooldown.until > now) live[key] = cooldown;
    return live;
  }

  async setCooldown(key: string, cooldown: ModelCooldown | undefined): Promise<void> {
    await this.withMutation(async () => {
      await this.ensureLoaded();
      const previous = this.modelCooldowns.get(key);
      if (cooldown === undefined) this.modelCooldowns.delete(key);
      else this.modelCooldowns.set(key, cooldown);
      // Best-effort: a cooldown is an optimisation for the *next* request, and failing the request in
      // hand because the file could not be written would trade a real answer for bookkeeping.
      try {
        await this.persistMetadata();
      } catch (error) {
        if (previous === undefined) this.modelCooldowns.delete(key);
        else this.modelCooldowns.set(key, previous);
        throw error;
      }
    });
  }

  async remove(connectionId: string) {
    return this.withMutation(async () => {
      await this.ensureLoaded();
      const record = this.connections.get(connectionId);
      if (!record) return false;
      const previousCredential = this.credentials.get(connectionId);
      const previousConnections = new Map(this.connections);
      this.connections.delete(connectionId);
      this.credentials.delete(connectionId);
      try {
        await this.persistSecrets();
        await this.persistMetadata();
      } catch (error) {
        this.connections = previousConnections;
        if (previousCredential) this.credentials.set(connectionId, previousCredential);
        await this.persistSecrets().catch(() => undefined);
        await this.persistMetadata().catch(() => undefined);
        throw error;
      }
      return true;
    });
  }

  /**
   * This vault's whole configuration: connections with their credentials, strategies, aliases.
   *
   * Credentials are decrypted here because that is what makes a backup restorable, and the only place they
   * go is the encrypted envelope. What is *not* here is deliberate and documented on `BackupConnection`.
   */
  async exportState(): Promise<ConnectionsBackupState> {
    await this.mutationQueue;
    await this.ensureLoaded();
    return {
      connections: [...this.connections.values()].map((record) => backupConnection(record, this.credentials.get(record.id))),
      strategies: Object.fromEntries(this.strategies),
      aliases: Object.fromEntries(this.aliasMap),
    };
  }

  /**
   * Replaces every connection, credential, strategy and alias.
   *
   * Two files are written from the new state inside one mutation, so the vault cannot be observed
   * half-replaced, and a failure — the metadata size bound, a full disk, a refused symlink — restores the
   * previous maps and writes them back. `importBackup` needs that: it calls this once per store in turn,
   * and a store that failed part-way would leave an installation whose connections came from one machine
   * and whose tunnels came from another.
   *
   * Cooldowns are cleared rather than imported. Each one is keyed `<connectionId>:<modelId>` for an
   * account that this import has just replaced, so keeping them would stand down accounts that never
   * earned it — a cooldown is about what happened on the *source* machine, and the vault already drops an
   * expired one as meaningless.
   */
  async importState(state: ConnectionsBackupState): Promise<void> {
    const next = parseConnectionsBackupState(state);
    return this.withMutation(async () => {
      await this.ensureLoaded();
      const previous = {
        connections: this.connections,
        credentials: this.credentials,
        strategies: this.strategies,
        aliases: this.aliasMap,
        cooldowns: this.modelCooldowns,
      };
      const connections = new Map<string, ConnectionRecord>();
      const credentials = new Map<ProviderId, ProviderCredential>();
      for (const entry of next.connections) {
        connections.set(entry.connection.id, asStoredRecord(entry));
        if (entry.credential) credentials.set(entry.connection.id, storedCredential(entry.credential));
      }
      this.connections = connections;
      this.credentials = credentials;
      this.strategies = new Map(Object.entries(next.strategies));
      this.aliasMap = new Map(Object.entries(next.aliases));
      this.modelCooldowns = new Map();
      try {
        await this.persistSecrets();
        await this.persistMetadata();
      } catch (error) {
        this.connections = previous.connections;
        this.credentials = previous.credentials;
        this.strategies = previous.strategies;
        this.aliasMap = previous.aliases;
        this.modelCooldowns = previous.cooldowns;
        await this.persistSecrets().catch(() => undefined);
        await this.persistMetadata().catch(() => undefined);
        throw error;
      }
    });
  }

  async recordUsage(connectionId: string) {
    await this.withMutation(async () => {
      await this.ensureLoaded();
      const record = this.connections.get(connectionId);
      if (!record) return;
      record.requestCount = (record.requestCount ?? 0) + 1;
      record.lastUsed = new Date().toISOString();
      this.usageDirty = true;
      this.scheduleUsageFlush();
    });
  }

  /**
   * A usage counter is bookkeeping for the next read, not a fact the request waits for.
   *
   * Writing the whole metadata file and `fsync`ing it on every successful request was a disk write
   * on the hot path. The counters stay in memory and are coalesced here; a crash between flushes
   * loses the last window, which is the same trade the API-key counter already documents.
   */
  private scheduleUsageFlush() {
    if (this.usageFlushTimer) return;
    this.usageFlushTimer = setTimeout(() => {
      this.usageFlushTimer = undefined;
      void this.flushUsage().catch(() => {
        // Keep the dirty flag so the next request or shutdown retries rather than silently
        // dropping a counter.
        this.usageDirty = true;
      });
    }, 250);
    this.usageFlushTimer.unref?.();
  }

  async flushUsage() {
    if (!this.usageDirty) return;
    await this.withMutation(async () => {
      if (!this.usageDirty) return;
      this.usageDirty = false;
      try {
        await this.persistMetadata();
      } catch (error) {
        this.usageDirty = true;
        throw error;
      }
    });
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

  private findIdForProvider(providerId: ProviderId) {
    return [...this.connections.values()]
      .find((connection) => connection.providerId === providerId || connection.providers?.includes(providerId))?.id;
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
    await ensureSecureDirectory(this.directory);
    const [metadataText, secretText] = await Promise.all([
      readOptionalText(this.metadataPath, this.maxMetadataBytes),
      readOptionalText(this.secretsPath, maxSecretEnvelopeBytes),
    ]);
    const parsedMetadata = parseMetadata(metadataText);
    this.connections = parsedMetadata.connections;
    this.strategies = parsedMetadata.strategies;
    this.aliasMap = parsedMetadata.aliases;
    this.modelCooldowns = parsedMetadata.cooldowns;
    this.credentials = secretText ? await this.decryptSecrets(secretText) : new Map<ProviderId, ProviderCredential>();
    // Credentials are keyed by connection id, so a stored key that matches no
    // credential-bearing connection is an orphan. For a single-connection
    // provider the two are the same string, which is why an existing vault
    // still resolves after this change.
    const listedConnectionIds = new Set([...this.connections.values()].filter((connection) => connection.hasCredential).map((connection) => connection.id));
    let discardedOrphans = false;
    for (const key of this.credentials.keys()) {
      if (!listedConnectionIds.has(key)) {
        this.credentials.delete(key);
        discardedOrphans = true;
      }
    }
    if (discardedOrphans) await this.persistSecrets();
    for (const connection of this.connections.values()) {
      if (!this.credentials.has(connection.id)) connection.hasCredential = false;
    }
  }

  private async persistMetadata() {
    const strategies = Object.fromEntries(this.strategies);
    const aliases = Object.fromEntries(this.aliasMap);
    const now = Date.now();
    const cooldowns = Object.fromEntries([...this.modelCooldowns].filter(([, cooldown]) => cooldown.until > now));
    // Compact, not `null, 2`: the indentation was ~42% of a budget that a real vault ran out of, for a
    // file nothing reads by eye. `jq .` is one command away when a person does want to look.
    const payload = JSON.stringify({ version: metadataVersion, connections: [...this.connections.values()], ...(this.strategies.size > 0 ? { strategies } : {}), ...(this.aliasMap.size > 0 ? { aliases } : {}), ...(Object.keys(cooldowns).length > 0 ? { cooldowns } : {}) } satisfies MetadataEnvelope) + '\n';
    const bytes = Buffer.byteLength(payload, 'utf8');
    if (bytes > this.maxMetadataBytes) {
      const kib = (value: number) => `${Math.round(value / 1024)} KiB`;
      throw new ConnectionMetadataLimitError(
        `The connection metadata exceeds its size limit: ${kib(bytes)} of the ${kib(this.maxMetadataBytes)} allowed. Remove a connection, or raise OMNIHILBRAS_MAX_METADATA_BYTES.`,
      );
    }
    await atomicWrite(this.metadataPath, payload);
  }

  private async persistSecrets() {
    const masterKey = await this.getMasterKey();
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const derivedKey = scryptSync(masterKey, salt, 32);
    const cipher = createCipheriv('aes-256-gcm', derivedKey, iv);
    cipher.setAAD(credentialAad);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(Object.fromEntries(this.credentials)), 'utf8'), cipher.final()]);
    const envelope: EncryptedSecretEnvelope = {
      version: secretEnvelopeVersion,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
    await atomicWrite(this.secretsPath, JSON.stringify(envelope) + '\n');
  }

  private async decryptSecrets(value: string) {
    const envelope = parseEncryptedSecretEnvelope(value);
    const masterKey = await this.getMasterKey();
    const salt = decodeBase64(envelope.salt, 16, 'secret salt');
    const iv = decodeBase64(envelope.iv, 12, 'secret IV');
    const authTag = decodeBase64(envelope.authTag, 16, 'secret authentication tag');
    const ciphertext = decodeBase64(envelope.ciphertext, undefined, 'secret ciphertext');
    if (ciphertext.length === 0) throw new Error('Encrypted credential file is empty.');
    const decipher = createDecipheriv('aes-256-gcm', scryptSync(masterKey, salt, 32), iv);
    decipher.setAAD(credentialAad);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return parseCredentials(JSON.parse(plaintext) as unknown);
  }

  private async getMasterKey() {
    if (this.configuredMasterKey) return this.configuredMasterKey;
    const configured = parseMasterKey(process.env.OMNIHILBRAS_MASTER_KEY);
    if (configured) return configured;
    await ensureSecureDirectory(this.directory);
    const existing = await readOptionalFile(this.keyPath, 128);
    if (existing) {
      const text = existing.toString('utf8').trim();
      if (!text) throw new Error('Local credential key file is empty.');
      return normalizeMasterKey(Buffer.from(text, 'base64'));
    }

    const generated = randomBytes(32);
    try {
      await writeFile(this.keyPath, `${generated.toString('base64')}\n`, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
    }
    await chmod(this.keyPath, 0o600);
    const created = await readFile(this.keyPath, 'utf8');
    return normalizeMasterKey(Buffer.from(created.trim(), 'base64'));
  }
}

function normalizeInput(input: ConnectionInput): ConnectionInput {
  const providerId = input.providerId.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(providerId)) throw new Error('providerId contains unsupported characters.');
  if (input.id !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(input.id)) throw new Error('connection id contains unsupported characters.');
  if (input.credentialConnectionId !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(input.credentialConnectionId)) throw new Error('credentialConnectionId contains unsupported characters.');
  const name = input.name.trim();
  if (!name || name.length > 120 || /[\r\n\0]/.test(name)) throw new Error('Connection name must be between 1 and 120 characters.');
  const endpoint = input.endpoint.trim();
  assertSafeProviderRequestUrl(endpoint, providerId);
  if (endpoint.length > 2048) throw new Error('Connection endpoint is too long.');
  if (!Number.isInteger(input.priority) || input.priority < 1 || input.priority > 1000) throw new Error('Connection priority must be an integer from 1 to 1000.');
  const proxyPool = input.proxyPool.trim();
  if (proxyPool.length > 128 || /[\r\n\0]/.test(proxyPool)) throw new Error('Proxy pool name is invalid.');
  if (input.quotaTier !== undefined && !Object.hasOwn(quotaTierOrder, input.quotaTier)) throw new Error('Quota tier must be paid, cheap or free.');
  if (input.workspaceId !== undefined && (typeof input.workspaceId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(input.workspaceId))) throw new Error('workspaceId contains unsupported characters.');
  if (input.modelPolicy !== undefined && input.modelPolicy !== 'free' && input.modelPolicy !== 'all') throw new Error('Model import policy is invalid.');
  const modelIds = input.modelIds === undefined ? undefined : normalizeModelIds(input.modelIds);
  const customModelIds = input.customModelIds === undefined ? undefined : normalizeModelIds(input.customModelIds);
  const modelMeta = input.modelMeta === undefined ? undefined : normalizeModelMeta(input.modelMeta);
  return {
    id: input.id,
    providerId,
    name,
    endpoint,
    priority: input.priority,
    proxyPool,
    ...(input.quotaTier === undefined ? {} : { quotaTier: input.quotaTier }),
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
    ...(modelMeta ? { modelMeta } : {}),
    ...(input.catalogRefreshedAt ? { catalogRefreshedAt: input.catalogRefreshedAt } : {}),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    ...(input.modelPolicy === undefined ? {} : { modelPolicy: input.modelPolicy }),
    ...(input.providers === undefined || input.providers.length === 0 ? {} : { providers: input.providers }),
    ...(input.credentialConnectionId === undefined ? {} : { credentialConnectionId: input.credentialConnectionId }),
    ...(modelIds === undefined ? {} : { modelIds }),
    ...(customModelIds === undefined ? {} : { customModelIds }),
    ...(input.resilience === undefined ? {} : { resilience: normalizeResilienceSettings(input.resilience) }),
  };
}

export function normalizeResilienceSettings(value: Partial<ResilienceSettings>): ResilienceSettings {
  const read = (field: keyof ResilienceSettings, label: string) => {
    const raw = value[field];
    if (raw === undefined) return undefined;
    const limit = resilienceLimits[field];
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < limit.min || raw > limit.max) {
      throw new Error(`resilience.${label} must be an integer from ${limit.min} to ${limit.max}.`);
    }
    return raw;
  };
  const timeoutMs = read('timeoutMs', 'timeoutMs');
  const ttfbMs = read('ttfbMs', 'ttfbMs');
  const maxRetries = read('maxRetries', 'maxRetries');
  const requestsPerMinute = read('requestsPerMinute', 'requestsPerMinute');
  const maxConcurrentRequests = read('maxConcurrentRequests', 'maxConcurrentRequests');
  const hedgeAfterMs = read('hedgeAfterMs', 'hedgeAfterMs');
  return {
    timeoutMs: timeoutMs ?? defaultResilienceSettings.timeoutMs,
    maxRetries: maxRetries ?? defaultResilienceSettings.maxRetries,
    requestsPerMinute: requestsPerMinute ?? defaultResilienceSettings.requestsPerMinute,
    ...(maxConcurrentRequests === undefined ? {} : { maxConcurrentRequests }),
    hedgeAfterMs: hedgeAfterMs ?? defaultResilienceSettings.hedgeAfterMs,
    ...(ttfbMs === undefined ? {} : { ttfbMs }),
  };
}

function normalizeModelIds(values: string[], limit = maxConnectionModelIds) {
  if (!Array.isArray(values)) throw new Error('Model IDs must be an array.');
  const modelIds: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') throw new Error('Model IDs must be strings.');
    const modelId = value.trim();
    if (!isSafeModelId(modelId)) throw new Error('Model ID contains unsupported characters.');
    if (seen.has(modelId)) continue;
    seen.add(modelId);
    modelIds.push(modelId);
    if (modelIds.length > limit) throw new ConnectionModelLimitError();
  }
  return modelIds;
}

function mergeModelLists(modelIds: string[] | undefined, customModelIds: string[] | undefined) {
  const custom = normalizeModelIds(customModelIds ?? [], maxCustomModelIds);
  const all = normalizeModelIds([...(modelIds ?? []), ...custom], maxConnectionModelIds);
  return { modelIds: all, customModelIds: custom };
}

function mergeAddedModelIds(record: ConnectionRecord, additions: string[]) {
  const normalizedAdditions = normalizeModelIds(additions, maxCustomModelIds);
  const existing = new Set(record.modelIds);
  const newAdditions = normalizedAdditions.filter((modelId) => !existing.has(modelId));
  if (newAdditions.length === 0) return undefined;
  return {
    modelIds: normalizeModelIds([...record.modelIds, ...newAdditions], maxConnectionModelIds),
    customModelIds: normalizeModelIds([...record.customModelIds, ...newAdditions], maxCustomModelIds),
  };
}

/**
 * The inverse of `mergeAddedModelIds`: the record without the ids named, and without ones it never added.
 *
 * Only ids in `customModelIds` can be removed, so an id the provider reported is left alone even when it is
 * named — a removal the next rescan would undo is not a removal. The union beside it shrinks too, because the
 * served list is what the page and the router read; leaving the id there would make the removal invisible and
 * look exactly like the button doing nothing.
 */
function mergeRemovedModelIds(record: ConnectionRecord, removals: string[]) {
  const named = removals.length === 0
    // No ids named: every addition. Read off `customModelIds` rather than the served list, so "clear my
    // additions" cannot empty a catalogue the provider publishes.
    ? new Set(record.customModelIds)
    : new Set(normalizeModelIds(removals, maxCustomModelIds));
  const customModelIds = record.customModelIds.filter((id) => !named.has(id));
  if (customModelIds.length === record.customModelIds.length) return undefined;
  return { customModelIds, modelIds: record.modelIds.filter((id) => !named.has(id)) };
}

function isSafeModelId(value: string) {
  // A leading `@` is legitimate: Cline publishes preset ids such as
  // `@preset/cline-mistral-k5-20261023-large4-zdr-r1`. The rule used to require a leading
  // alphanumeric, which rejected 5 of Cline's 436 models and — because normalization throws on the
  // first bad id — failed the **entire** connection save. The user saw "The local connection could
  // not be saved" and a working sign-in was discarded. Still refuses whitespace, quotes, control
  // characters and path traversal, which is what the check is for.
  return value.length > 0 && value.length <= 256 && /^[a-z0-9~@][a-z0-9._:/~@-]*$/i.test(value) && !value.includes('..');
}

function parseMetadata(value: string | undefined) {
  if (!value) return { connections: new Map<string, ConnectionRecord>(), strategies: new Map<string, ProviderStrategy>(), aliases: new Map<string, ModelAlias>(), cooldowns: new Map<string, ModelCooldown>() };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('Local connection metadata is not valid JSON.');
  }
  if (!isRecord(parsed) || parsed.version !== metadataVersion || !Array.isArray(parsed.connections) || parsed.connections.length > resolveMaxConnections()) {
    throw new Error('Local connection metadata has an unsupported format.');
  }
  const connections = new Map<string, ConnectionRecord>();
  for (const item of parsed.connections) {
    const record = parseRecord(item);
    if (connections.has(record.id)) throw new Error('Local connection metadata contains duplicate IDs.');
    connections.set(record.id, record);
  }
  const strategies = new Map<string, ProviderStrategy>();
  if (parsed.strategies !== undefined) {
    if (!isRecord(parsed.strategies)) throw new Error('Local connection metadata has an invalid strategy map.');
    for (const [providerId, strategy] of Object.entries(parsed.strategies)) {
      if (!providerStrategies.includes(strategy as ProviderStrategy)) throw new Error('Local connection metadata contains an unknown provider strategy.');
      strategies.set(providerId, strategy as ProviderStrategy);
    }
  }
  const aliases = new Map<string, ModelAlias>();
  if (parsed.aliases !== undefined) {
    if (!isRecord(parsed.aliases)) throw new Error('Local connection metadata has an invalid alias map.');
    for (const [name, value] of Object.entries(parsed.aliases)) {
      if (!isRecord(value) || typeof value.providerId !== 'string' || typeof value.model !== 'string' || !value.model.trim()) throw new Error('Local connection metadata contains an invalid model alias.');
      aliases.set(name, { providerId: value.providerId, model: value.model });
    }
  }
  const cooldowns = new Map<string, ModelCooldown>();
  if (parsed.cooldowns !== undefined) {
    if (!isRecord(parsed.cooldowns)) throw new Error('Local connection metadata has an invalid cooldown map.');
    for (const [key, value] of Object.entries(parsed.cooldowns)) {
      // A malformed cooldown is dropped rather than fatal. It is bookkeeping about the *next* request;
      // refusing to open the vault over one would turn a stale entry into an unusable installation, and
      // the entries are rebuilt by the next refusal anyway.
      if (!isRecord(value) || typeof value.until !== 'number' || !Number.isFinite(value.until)) continue;
      const level = typeof value.level === 'number' && Number.isFinite(value.level) && value.level > 0 ? Math.floor(value.level) : 0;
      cooldowns.set(key, { until: value.until, level });
    }
  }
  return { connections, strategies, aliases, cooldowns };
}

function parseRecord(value: unknown): ConnectionRecord {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.providerId !== 'string' || typeof value.name !== 'string' || typeof value.endpoint !== 'string' || typeof value.priority !== 'number' || !Number.isInteger(value.priority) || typeof value.proxyPool !== 'string' || typeof value.enabled !== 'boolean' || typeof value.hasCredential !== 'boolean' || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') {
    throw new Error('Local connection metadata contains an invalid record.');
  }
  if (value.modelPolicy !== undefined && value.modelPolicy !== 'free' && value.modelPolicy !== 'all') throw new Error('Local connection metadata contains an invalid model policy.');
  if (value.modelIds !== undefined && !Array.isArray(value.modelIds)) throw new Error('Local connection metadata contains an invalid model list.');
  if (value.customModelIds !== undefined && !Array.isArray(value.customModelIds)) throw new Error('Local connection metadata contains an invalid custom model list.');
  const modelIds = value.modelIds === undefined ? [] : normalizeModelIds(value.modelIds, maxConnectionModelIds);
  const customModelIds = value.customModelIds === undefined ? [] : normalizeModelIds(value.customModelIds, maxCustomModelIds);
  const modelLists = mergeModelLists(modelIds, customModelIds);
  const input = normalizeInput({
    id: value.id,
    providerId: value.providerId,
    name: value.name,
    endpoint: value.endpoint,
    priority: value.priority,
    proxyPool: value.proxyPool,
    ...(typeof value.quotaTier === 'string' && Object.hasOwn(quotaTierOrder, value.quotaTier) ? { quotaTier: value.quotaTier as QuotaTier } : {}),
    ...(typeof value.workspaceId === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value.workspaceId) ? { workspaceId: value.workspaceId } : {}),
    enabled: value.enabled,
    ...(typeof value.credentialFingerprint === 'string' && value.credentialFingerprint ? { credentialFingerprint: value.credentialFingerprint } : {}),
    modelPolicy: value.modelPolicy === undefined ? 'all' : value.modelPolicy,
    ...(Array.isArray(value.providers) ? { providers: value.providers.filter((id): id is ProviderId => typeof id === 'string') } : {}),
    ...(typeof value.credentialConnectionId === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value.credentialConnectionId)
      ? { credentialConnectionId: value.credentialConnectionId }
      : {}),
    modelIds: modelLists.modelIds,
    customModelIds: modelLists.customModelIds,
    ...(value.modelMeta === undefined ? {} : { modelMeta: value.modelMeta as ModelMetaMap }),
    ...(typeof value.catalogRefreshedAt === 'string' && !Number.isNaN(Date.parse(value.catalogRefreshedAt)) ? { catalogRefreshedAt: value.catalogRefreshedAt } : {}),
    ...(value.resilience === undefined ? {} : { resilience: value.resilience as Partial<ResilienceSettings> }),
  });
  return {
    id: input.id!,
    providerId: input.providerId,
    ...(input.providers && input.providers.length > 0 ? { providers: input.providers } : {}),
    ...(input.credentialConnectionId ? { credentialConnectionId: input.credentialConnectionId } : {}),
    name: input.name,
    endpoint: input.endpoint,
    priority: input.priority,
    proxyPool: input.proxyPool,
    ...(input.quotaTier === undefined ? {} : { quotaTier: input.quotaTier }),
    enabled: value.enabled,
    hasCredential: value.hasCredential,
    // Both are written to the metadata and were never read back: `normalizeInput` carries neither
    // (the fingerprint is the store's, the note is its own operation), so building the record from the
    // normalized copy dropped them on the first restart. A fingerprint lost on reload disables the
    // duplicate check for every saved account, which is a failure no live session would show.
    ...(typeof value.credentialFingerprint === 'string' && value.credentialFingerprint ? { credentialFingerprint: value.credentialFingerprint } : {}),
    ...(isRecord(value.responsibility) && (typeof value.responsibility.owner === 'string' || typeof value.responsibility.purpose === 'string')
      ? {
          responsibility: {
            ...(typeof value.responsibility.owner === 'string' && value.responsibility.owner ? { owner: value.responsibility.owner } : {}),
            ...(typeof value.responsibility.purpose === 'string' && value.responsibility.purpose ? { purpose: value.responsibility.purpose } : {}),
          },
        }
      : {}),
    modelPolicy: input.modelPolicy ?? 'all',
    // Usage counters are written to the metadata; without these two lines they were never read back,
    // so every restart reset a connection to “never used” while the file still held the count.
    ...(typeof value.requestCount === 'number' && Number.isFinite(value.requestCount) && value.requestCount >= 0
      ? { requestCount: Math.floor(value.requestCount) }
      : {}),
    ...(typeof value.lastUsed === 'string' && value.lastUsed ? { lastUsed: value.lastUsed } : {}),
    ...(input.modelMeta ? { modelMeta: input.modelMeta } : {}),
    ...(input.catalogRefreshedAt ? { catalogRefreshedAt: input.catalogRefreshedAt } : {}),
    modelIds: input.modelIds ?? [],
    customModelIds: input.customModelIds ?? [],
    resilience: normalizeResilienceSettings(input.resilience ?? {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function parseCredentials(value: unknown) {
  if (!isRecord(value)) throw new Error('Encrypted credential payload has an unsupported format.');
  const credentials = new Map<ProviderId, ProviderCredential>();
  for (const [providerId, credential] of Object.entries(value)) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(providerId)) {
      throw new Error('Encrypted credential payload contains an invalid credential.');
    }
    /**
     * The rules live in `storedCredential`, which the writer also uses, so the two cannot disagree —
     * which is exactly how they disagreed twice: a `{ type: 'none' }` written and refused on read, and
     * an OAuth credential that kept three of its nine declared fields. The context is added here rather
     * than there because only this function knows the failure is in the encrypted payload.
     */
    try {
      credentials.set(providerId, storedCredential(credential));
    } catch (error) {
      throw new Error(`Encrypted credential payload contains an invalid credential: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }
  return credentials;
}

function parseEncryptedSecretEnvelope(value: string): EncryptedSecretEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('Encrypted credential file is not valid JSON.');
  }
  if (!isRecord(parsed) || parsed.version !== secretEnvelopeVersion || typeof parsed.salt !== 'string' || typeof parsed.iv !== 'string' || typeof parsed.authTag !== 'string' || typeof parsed.ciphertext !== 'string') {
    throw new Error('Encrypted credential file has an unsupported format.');
  }
  return parsed as EncryptedSecretEnvelope;
}

function decodeConfiguredMasterKey(value: string) {
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  return Buffer.from(value, 'base64');
}

function normalizeMasterKey(value: Uint8Array) {
  const key = Buffer.from(value);
  if (key.length !== 32) throw new Error('Local credential master key must be 32 bytes.');
  return key;
}

function decodeBase64(value: string, expectedLength: number | undefined, label: string) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error(`Encrypted credential ${label} is invalid.`);
  const decoded = Buffer.from(value, 'base64');
  if (expectedLength !== undefined && decoded.length !== expectedLength) throw new Error(`Encrypted credential ${label} has an invalid length.`);
  return decoded;
}

/**
 * Every optional field the `oauth` variant declares. **One list**, because two lists that "happen to
 * agree" is what this function replaces.
 */
const oauthStringFields = ['refreshToken', 'expiresAt', 'email', 'orgId', 'orgName', 'accountId', 'oauthClientId', 'oauthClientSecret', 'kiroAuthMethod', 'region', 'machineId', 'name'] as const;

/**
 * The credential shape, decided in one place — for the writer and the reader alike.
 *
 * Two shipped defects came from this file keeping two copies of that decision, and both were silent:
 *
 * - **`{ type: 'none' }` was written and then refused on read.** The reader demanded a non-empty string
 *   `value` *before* it looked at `type`, and the writer validated nothing. Because the reader is the
 *   loader, one such credential made every connection in the vault unreadable.
 * - **An OAuth credential lost every field outside `refreshToken` / `expiresAt` / `email`.** This
 *   function used to be `cloneCredential`, and it built the object that gets *stored*, so the fields
 *   were dropped at save time — not on reload. Measured before the fix: a credential carrying
 *   `oauthClientId` read back with `oauthClientId: undefined` **in the same process**.
 *   `Kernel/SDK/kiro/adapter/index.ts` stores that pair and refuses to renew without it, so a Kiro
 *   session could not be renewed from the moment it was saved.
 *
 * Normalising through one function makes a round trip exact by construction.
 * `Kernel/API/test/connection-credential-round-trip.test.js` populates every field the type declares,
 * so a tenth one cannot be added without that test failing.
 */
function storedCredential(value: unknown): ProviderCredential {
  if (!isRecord(value)) throw new Error('a credential must be an object');
  if (value.type === 'none') {
    // A `none` credential carrying a secret is a contradiction, not a shape to tolerate.
    if (value.value !== undefined) throw new Error('a none credential cannot carry a value');
    return { type: 'none' };
  }
  if (typeof value.value !== 'string' || !value.value || /[\r\n\0]/.test(value.value)) {
    throw new Error('a credential needs a non-empty value with no control characters');
  }
  if (value.type === 'api-key') {
    const key: Record<string, unknown> = { type: 'api-key', value: value.value };
    // The web client's device fingerprints, carried on the key because they are per-device facts about
    // the same session. Validated like every other declared field: present means a non-empty string.
    for (const field of ['deviceId', 'shumeiDeviceId', 'did']) {
      const candidate = value[field];
      if (candidate === undefined) continue;
      if (typeof candidate !== 'string' || !candidate || /[\r\n\0]/.test(candidate)) {
        throw new Error(`api-key.${field} must be a non-empty string with no control characters`);
      }
      key[field] = candidate;
    }
    return key as ProviderCredential;
  }
  if (value.type !== 'oauth') throw new Error(`unknown credential type ${JSON.stringify(value.type)}`);

  const oauth: Record<string, unknown> = { type: 'oauth', value: value.value };
  for (const field of oauthStringFields) {
    const candidate = value[field];
    if (candidate === undefined) continue;
    if (typeof candidate !== 'string' || !candidate) throw new Error(`oauth.${field} must be a non-empty string`);
    oauth[field] = candidate;
  }
  if (value.kiroLogin !== undefined) {
    if (value.kiroLogin !== 'social') throw new Error("oauth.kiroLogin must be 'social'");
    oauth.kiroLogin = 'social';
  }
  return oauth as ProviderCredential;
}

function cloneRecord(record: ConnectionRecord): ConnectionRecord {
  return {
    ...record,
    modelIds: [...record.modelIds],
    customModelIds: [...record.customModelIds],
    ...(record.modelMeta ? { modelMeta: cloneModelMeta(record.modelMeta) } : {}),
    resilience: { ...record.resilience },
  };
}

/** A deep-enough copy that a caller cannot mutate stored metadata through a record. */
function cloneModelMeta(meta: ModelMetaMap): ModelMetaMap {
  const copy: ModelMetaMap = {};
  for (const [id, entry] of Object.entries(meta)) {
    // Copy every declared field, not the five this function knew before the catalog was enriched: a
    // clone that drops a field silently is indistinguishable from the provider never having stated it.
    const next: ModelMeta = { ...entry };
    if (entry.i) next.i = [...entry.i];
    if (entry.o) next.o = [...entry.o];
    if (entry.p) next.p = [...entry.p];
    if (entry.a) next.a = [...entry.a];
    if (entry.sp) next.sp = [...entry.sp];
    if (entry.cp) next.cp = { ...entry.cp };
    if (entry.rs?.efforts) next.rs = { ...entry.rs, efforts: [...entry.rs.efforts] };
    copy[id] = next;
  }
  return copy;
}

/**
 * Validates catalog metadata read back from disk.
 *
 * This is untrusted input like everything else in the file, and it is the one field that
 * can grow without bound, so every string, array and number is checked. Anything that
 * does not fit is dropped rather than failing the whole load: stale metadata from an
 * older build must not make a vault unreadable.
 */
function normalizeModelMeta(value: unknown): ModelMetaMap | undefined {
  if (!isRecord(value)) return undefined;
  const out: ModelMetaMap = {};
  let kept = 0;
  const text = (raw: unknown, limit: number) => typeof raw === 'string' && raw.trim() && raw.length <= limit ? raw.trim() : undefined;
  const list = (raw: unknown, limit: number) => {
    if (!Array.isArray(raw) || raw.length > limit) return undefined;
    const values = raw.filter((item): item is string => typeof item === 'string' && item.length <= 64 && /^[a-z0-9._:+/-]{1,64}$/i.test(item));
    return values.length ? [...new Set(values.map((item) => item.toLowerCase()))] : undefined;
  };
  for (const [id, raw] of Object.entries(value)) {
    if (kept >= maxModelMetaEntries) break;
    if (!id || id.length > 256 || !isRecord(raw)) continue;
    const entry: ModelMeta = {};
    const name = text(raw.n, 200);
    if (name) entry.n = name;
    if (typeof raw.c === 'number' && Number.isInteger(raw.c) && raw.c > 0 && raw.c <= 10_000_000) entry.c = raw.c;
    if (typeof raw.mo === 'number' && Number.isInteger(raw.mo) && raw.mo > 0 && raw.mo <= 10_000_000) entry.mo = raw.mo;
    const i = list(raw.i, 8);
    const o = list(raw.o, 8);
    if (i) entry.i = i;
    if (o) entry.o = o;
    if (Array.isArray(raw.p) && raw.p.length <= modelMetaPriceOrder.length) {
      // A missing slot stays null. Filtering first would shift a later price into an earlier dimension.
      const prices = raw.p.map((item) => (typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= 1_000_000 ? item : null));
      if (prices.some((item) => item !== null)) entry.p = prices;
    }
    const fields: Array<[keyof ModelMeta, number]> = [
      ['u', 256], ['d', 2000], ['cr', 40], ['kc', 40], ['ex', 40], ['st', 40], ['cs', 200], ['tk', 80], ['src', 24],
    ];
    for (const [key, limit] of fields) {
      const parsed = text(raw[key as string], limit);
      if (parsed) (entry as Record<string, unknown>)[key] = parsed;
    }
    const aliases = list(raw.a, 16);
    if (aliases) entry.a = aliases;
    const modelType = text(raw.mt, 64);
    if (modelType) entry.mt = modelType;
    if (isRecord(raw.cp)) {
      const caps: NonNullable<ModelMeta['cp']> = {};
      for (const key of ['chat', 'streaming', 'models', 'embeddings', 'images', 'audio', 'search', 'tools', 'reasoning', 'vision', 'pdf', 'audioInput', 'videoInput', 'imageOutput', 'audioOutput'] as const) {
        // A provider-stated `false` is a fact too: `narrowedToolCaps` uses `tools: false` to stop
        // advertising tools on one model of a tool-capable provider. Dropping it here made that
        // narrowing unreachable after any save or restart.
        if (typeof raw.cp[key] === 'boolean') caps[key] = raw.cp[key];
      }
      if (Object.keys(caps).length) entry.cp = caps;
    }
    const params = list(raw.sp, 64);
    if (params) entry.sp = params;
    if (isRecord(raw.rs)) {
      const reason: NonNullable<ModelMeta['rs']> = {};
      if (typeof raw.rs.de === 'boolean') reason.de = raw.rs.de;
      if (typeof raw.rs.ma === 'boolean') reason.ma = raw.rs.ma;
      const effort = text(raw.rs.eff, 40);
      if (effort) reason.eff = effort;
      const efforts = list(raw.rs.efforts, 16);
      if (efforts) reason.efforts = efforts;
      if (Object.keys(reason).length) entry.rs = reason;
    }
    if (Object.keys(entry).length > 0) {
      out[id] = entry;
      kept++;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
