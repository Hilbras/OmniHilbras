import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { assertSafeProviderRequestUrl, type ModelImportPolicy, type ProviderCredential, type ProviderId, type SecretStore } from '@omnihilbras/sdk';

export type ConnectionRecord = {
  id: string;
  providerId: ProviderId;
  name: string;
  endpoint: string;
  priority: number;
  proxyPool: string;
  enabled: boolean;
  hasCredential: boolean;
  modelPolicy: ModelImportPolicy;
  modelIds: string[];
  customModelIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type ConnectionInput = {
  id?: string;
  providerId: ProviderId;
  name: string;
  endpoint: string;
  priority: number;
  proxyPool: string;
  enabled?: boolean;
  modelPolicy?: ModelImportPolicy;
  modelIds?: string[];
  customModelIds?: string[];
};

export interface WritableSecretStore extends SecretStore {
  set(providerId: ProviderId, credential: ProviderCredential): Promise<void>;
  delete(providerId: ProviderId): Promise<boolean>;
}

export interface ConnectionStore extends WritableSecretStore {
  list(): Promise<ConnectionRecord[]>;
  save(input: ConnectionInput, credential: ProviderCredential): Promise<ConnectionRecord>;
  updateModels(connectionId: string, modelIds: string[]): Promise<ConnectionRecord | undefined>;
  remove(connectionId: string): Promise<boolean>;
}

export type LocalConnectionStoreOptions = {
  directory?: string;
  fallback?: SecretStore;
  masterKey?: Uint8Array;
};

const metadataVersion = 1;
const secretEnvelopeVersion = 1;
const maxMetadataBytes = 256 * 1024;
const maxSecretEnvelopeBytes = 1024 * 1024;
const maxConnections = 100;
const credentialAad = Buffer.from('omnihilbras-credentials-v1');

type EncryptedSecretEnvelope = {
  version: number;
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
};

type MetadataEnvelope = {
  version: number;
  connections: ConnectionRecord[];
};

export function defaultConnectionDirectory(env: Readonly<Record<string, string | undefined>> = process.env) {
  const configHome = env.XDG_CONFIG_HOME?.trim();
  return join(configHome || join(homedir(), '.config'), 'omnihilbras');
}

export function parseMasterKey(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalizeMasterKey(decodeConfiguredMasterKey(normalized)) : undefined;
}

export class InMemoryConnectionStore implements ConnectionStore {
  private readonly credentials = new Map<ProviderId, ProviderCredential>();
  private readonly connections = new Map<string, ConnectionRecord>();

  constructor(private readonly fallback?: SecretStore) {}

  async get(providerId: ProviderId) {
    return this.credentials.get(providerId) ?? this.fallback?.get(providerId);
  }

  async set(providerId: ProviderId, credential: ProviderCredential) {
    this.credentials.set(providerId, cloneCredential(credential));
  }

  async delete(providerId: ProviderId) {
    return this.credentials.delete(providerId);
  }

  async list() {
    return [...this.connections.values()].map((connection) => cloneRecord({ ...connection, hasCredential: this.credentials.has(connection.providerId) }));
  }

  async save(input: ConnectionInput, credential: ProviderCredential) {
    const normalized = normalizeInput(input);
    const id = normalized.id ?? this.findIdForProvider(normalized.providerId) ?? normalized.providerId;
    const existing = this.connections.get(id);
    if (existing && existing.providerId !== normalized.providerId) throw new Error('Connection ID is already used by another provider.');
    if (!existing && this.connections.size >= maxConnections) throw new Error('The local connection limit has been reached.');

    const now = new Date().toISOString();
    const modelLists = mergeModelLists(normalized.modelIds ?? existing?.modelIds, normalized.customModelIds ?? existing?.customModelIds);
    const record: ConnectionRecord = {
      id,
      providerId: normalized.providerId,
      name: normalized.name,
      endpoint: normalized.endpoint,
      priority: normalized.priority,
      proxyPool: normalized.proxyPool,
      enabled: normalized.enabled ?? existing?.enabled ?? true,
      hasCredential: credential.type === 'api-key',
      modelPolicy: normalized.modelPolicy ?? existing?.modelPolicy ?? 'all',
      modelIds: modelLists.modelIds,
      customModelIds: modelLists.customModelIds,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.connections.set(id, record);
    this.credentials.set(normalized.providerId, cloneCredential(credential));
    return cloneRecord(record);
  }

  async updateModels(connectionId: string, modelIds: string[]) {
    const record = this.connections.get(connectionId);
    if (!record) return undefined;
    const merged = mergeAddedModelIds(record, modelIds);
    if (!merged) return cloneRecord(record);
    const updated = { ...record, ...merged, updatedAt: new Date().toISOString() };
    this.connections.set(connectionId, updated);
    return cloneRecord(updated);
  }

  async remove(connectionId: string) {
    const record = this.connections.get(connectionId);
    if (!record) return false;
    this.connections.delete(connectionId);
    this.credentials.delete(record.providerId);
    return true;
  }

  private findIdForProvider(providerId: ProviderId) {
    return [...this.connections.values()].find((connection) => connection.providerId === providerId)?.id;
  }
}

export class LocalConnectionStore implements ConnectionStore {
  private readonly directory: string;
  private readonly metadataPath: string;
  private readonly secretsPath: string;
  private readonly keyPath: string;
  private readonly fallback?: SecretStore;
  private readonly configuredMasterKey?: Buffer;
  private credentials = new Map<ProviderId, ProviderCredential>();
  private connections = new Map<string, ConnectionRecord>();
  private mutationQueue: Promise<void> = Promise.resolve();
  private loadPromise?: Promise<void>;

  constructor(options: LocalConnectionStoreOptions = {}) {
    this.directory = options.directory ?? defaultConnectionDirectory();
    this.metadataPath = join(this.directory, 'connections.json');
    this.secretsPath = join(this.directory, 'secrets.enc.json');
    this.keyPath = join(this.directory, 'secrets.key');
    this.fallback = options.fallback;
    if (options.masterKey) this.configuredMasterKey = normalizeMasterKey(options.masterKey);
  }

  async get(providerId: ProviderId) {
    await this.mutationQueue;
    await this.ensureLoaded();
    return this.credentials.get(providerId) ?? this.fallback?.get(providerId);
  }

  async set(providerId: ProviderId, credential: ProviderCredential) {
    return this.withMutation(async () => {
      await this.ensureLoaded();
      const previous = this.credentials.get(providerId);
      this.credentials.set(providerId, cloneCredential(credential));
      try {
        await this.persistSecrets();
      } catch (error) {
        if (previous) this.credentials.set(providerId, previous);
        else this.credentials.delete(providerId);
        throw error;
      }
    });
  }

  async delete(providerId: ProviderId) {
    return this.withMutation(async () => {
      await this.ensureLoaded();
      const previous = this.credentials.get(providerId);
      const deleted = this.credentials.delete(providerId);
      if (!deleted) return false;
      try {
        await this.persistSecrets();
      } catch (error) {
        if (previous) this.credentials.set(providerId, previous);
        throw error;
      }
      return true;
    });
  }

  async list() {
    await this.mutationQueue;
    await this.ensureLoaded();
    return [...this.connections.values()]
      .map((connection) => cloneRecord({ ...connection, hasCredential: this.credentials.has(connection.providerId) }))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async save(input: ConnectionInput, credential: ProviderCredential) {
    return this.withMutation(async () => {
      const normalized = normalizeInput(input);
      await this.ensureLoaded();
      const id = normalized.id ?? this.findIdForProvider(normalized.providerId) ?? normalized.providerId;
      const existing = this.connections.get(id);
      if (existing && existing.providerId !== normalized.providerId) throw new Error('Connection ID is already used by another provider.');
      if (!existing && this.connections.size >= maxConnections) throw new Error('The local connection limit has been reached.');

      const previousCredential = this.credentials.get(normalized.providerId);
      const previousConnections = new Map(this.connections);
      const now = new Date().toISOString();
      const modelLists = mergeModelLists(normalized.modelIds ?? existing?.modelIds, normalized.customModelIds ?? existing?.customModelIds);
      const record: ConnectionRecord = {
        id,
        providerId: normalized.providerId,
        name: normalized.name,
        endpoint: normalized.endpoint,
        priority: normalized.priority,
        proxyPool: normalized.proxyPool,
        enabled: normalized.enabled ?? existing?.enabled ?? true,
        hasCredential: credential.type === 'api-key',
        modelPolicy: normalized.modelPolicy ?? existing?.modelPolicy ?? 'all',
        modelIds: modelLists.modelIds,
        customModelIds: modelLists.customModelIds,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      this.credentials.set(normalized.providerId, cloneCredential(credential));
      this.connections.set(id, record);
      try {
        await this.persistSecrets();
        await this.persistMetadata();
      } catch (error) {
        this.connections = previousConnections;
        if (previousCredential) this.credentials.set(normalized.providerId, previousCredential);
        else this.credentials.delete(normalized.providerId);
        await this.persistSecrets().catch(() => undefined);
        await this.persistMetadata().catch(() => undefined);
        throw error;
      }
      return cloneRecord(record);
    });
  }

  async updateModels(connectionId: string, modelIds: string[]) {
    return this.withMutation(async () => {
      await this.ensureLoaded();
      const record = this.connections.get(connectionId);
      if (!record) return undefined;
      const merged = mergeAddedModelIds(record, modelIds);
      if (!merged) return cloneRecord(record);
      const previous = record;
      const updated = { ...record, ...merged, updatedAt: new Date().toISOString() };
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

  async remove(connectionId: string) {
    return this.withMutation(async () => {
      await this.ensureLoaded();
      const record = this.connections.get(connectionId);
      if (!record) return false;
      const previousCredential = this.credentials.get(record.providerId);
      const previousConnections = new Map(this.connections);
      this.connections.delete(connectionId);
      this.credentials.delete(record.providerId);
      try {
        await this.persistSecrets();
        await this.persistMetadata();
      } catch (error) {
        this.connections = previousConnections;
        if (previousCredential) this.credentials.set(record.providerId, previousCredential);
        await this.persistSecrets().catch(() => undefined);
        await this.persistMetadata().catch(() => undefined);
        throw error;
      }
      return true;
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
    return [...this.connections.values()].find((connection) => connection.providerId === providerId)?.id;
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
      readOptionalText(this.metadataPath, maxMetadataBytes),
      readOptionalText(this.secretsPath, maxSecretEnvelopeBytes),
    ]);
    this.connections = parseMetadata(metadataText);
    this.credentials = secretText ? await this.decryptSecrets(secretText) : new Map<ProviderId, ProviderCredential>();
    const listedProviders = new Set([...this.connections.values()].filter((connection) => connection.hasCredential).map((connection) => connection.providerId));
    let discardedOrphans = false;
    for (const providerId of this.credentials.keys()) {
      if (!listedProviders.has(providerId)) {
        this.credentials.delete(providerId);
        discardedOrphans = true;
      }
    }
    if (discardedOrphans) await this.persistSecrets();
    for (const connection of this.connections.values()) {
      if (!this.credentials.has(connection.providerId)) connection.hasCredential = false;
    }
  }

  private async persistMetadata() {
    const payload = JSON.stringify({ version: metadataVersion, connections: [...this.connections.values()] } satisfies MetadataEnvelope, null, 2) + '\n';
    if (Buffer.byteLength(payload, 'utf8') > maxMetadataBytes) throw new Error('Local connection metadata exceeds the size limit.');
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
    const existing = await readOptionalBuffer(this.keyPath, 128);
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
  const name = input.name.trim();
  if (!name || name.length > 120 || /[\r\n\0]/.test(name)) throw new Error('Connection name must be between 1 and 120 characters.');
  const endpoint = input.endpoint.trim();
  assertSafeProviderRequestUrl(endpoint, providerId);
  if (endpoint.length > 2048) throw new Error('Connection endpoint is too long.');
  if (!Number.isInteger(input.priority) || input.priority < 1 || input.priority > 1000) throw new Error('Connection priority must be an integer from 1 to 1000.');
  const proxyPool = input.proxyPool.trim();
  if (proxyPool.length > 128 || /[\r\n\0]/.test(proxyPool)) throw new Error('Proxy pool name is invalid.');
  if (input.modelPolicy !== undefined && input.modelPolicy !== 'free' && input.modelPolicy !== 'all') throw new Error('Model import policy is invalid.');
  const modelIds = input.modelIds === undefined ? undefined : normalizeModelIds(input.modelIds);
  const customModelIds = input.customModelIds === undefined ? undefined : normalizeModelIds(input.customModelIds);
  return { id: input.id, providerId, name, endpoint, priority: input.priority, proxyPool, ...(input.enabled === undefined ? {} : { enabled: input.enabled }), ...(input.modelPolicy === undefined ? {} : { modelPolicy: input.modelPolicy }), ...(modelIds === undefined ? {} : { modelIds }), ...(customModelIds === undefined ? {} : { customModelIds }) };
}

function normalizeModelIds(values: string[]) {
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
    if (modelIds.length > 2_000) throw new Error('The model list is too large.');
  }
  return modelIds;
}

function mergeModelLists(modelIds: string[] | undefined, customModelIds: string[] | undefined) {
  const custom = normalizeModelIds(customModelIds ?? []);
  const all = normalizeModelIds([...(modelIds ?? []), ...custom]);
  return { modelIds: all, customModelIds: custom };
}

function mergeAddedModelIds(record: ConnectionRecord, additions: string[]) {
  const normalizedAdditions = normalizeModelIds(additions);
  const existing = new Set(record.modelIds);
  const newAdditions = normalizedAdditions.filter((modelId) => !existing.has(modelId));
  if (newAdditions.length === 0) return undefined;
  return {
    modelIds: normalizeModelIds([...record.modelIds, ...newAdditions]),
    customModelIds: normalizeModelIds([...record.customModelIds, ...newAdditions]),
  };
}

function isSafeModelId(value: string) {
  return value.length > 0 && value.length <= 256 && /^[a-z0-9~][a-z0-9._:/~-]*$/i.test(value);
}

function parseMetadata(value: string | undefined) {
  if (!value) return new Map<string, ConnectionRecord>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('Local connection metadata is not valid JSON.');
  }
  if (!isRecord(parsed) || parsed.version !== metadataVersion || !Array.isArray(parsed.connections) || parsed.connections.length > maxConnections) {
    throw new Error('Local connection metadata has an unsupported format.');
  }
  const connections = new Map<string, ConnectionRecord>();
  for (const item of parsed.connections) {
    const record = parseRecord(item);
    if (connections.has(record.id)) throw new Error('Local connection metadata contains duplicate IDs.');
    connections.set(record.id, record);
  }
  return connections;
}

function parseRecord(value: unknown): ConnectionRecord {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.providerId !== 'string' || typeof value.name !== 'string' || typeof value.endpoint !== 'string' || typeof value.priority !== 'number' || !Number.isInteger(value.priority) || typeof value.proxyPool !== 'string' || typeof value.enabled !== 'boolean' || typeof value.hasCredential !== 'boolean' || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') {
    throw new Error('Local connection metadata contains an invalid record.');
  }
  if (value.modelPolicy !== undefined && value.modelPolicy !== 'free' && value.modelPolicy !== 'all') throw new Error('Local connection metadata contains an invalid model policy.');
  if (value.modelIds !== undefined && !Array.isArray(value.modelIds)) throw new Error('Local connection metadata contains an invalid model list.');
  if (value.customModelIds !== undefined && !Array.isArray(value.customModelIds)) throw new Error('Local connection metadata contains an invalid custom model list.');
  const modelIds = value.modelIds === undefined ? [] : normalizeModelIds(value.modelIds);
  const customModelIds = value.customModelIds === undefined ? [] : normalizeModelIds(value.customModelIds);
  const modelLists = mergeModelLists(modelIds, customModelIds);
  const input = normalizeInput({ id: value.id, providerId: value.providerId, name: value.name, endpoint: value.endpoint, priority: value.priority, proxyPool: value.proxyPool, enabled: value.enabled, modelPolicy: value.modelPolicy === undefined ? 'all' : value.modelPolicy, modelIds: modelLists.modelIds, customModelIds: modelLists.customModelIds });
  return { id: input.id!, providerId: input.providerId, name: input.name, endpoint: input.endpoint, priority: input.priority, proxyPool: input.proxyPool, enabled: value.enabled, hasCredential: value.hasCredential, modelPolicy: input.modelPolicy ?? 'all', modelIds: input.modelIds ?? [], customModelIds: input.customModelIds ?? [], createdAt: value.createdAt, updatedAt: value.updatedAt };
}

function parseCredentials(value: unknown) {
  if (!isRecord(value)) throw new Error('Encrypted credential payload has an unsupported format.');
  const credentials = new Map<ProviderId, ProviderCredential>();
  for (const [providerId, credential] of Object.entries(value)) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(providerId) || !isRecord(credential) || credential.type !== 'api-key' || typeof credential.value !== 'string' || !credential.value || /[\r\n\0]/.test(credential.value)) {
      throw new Error('Encrypted credential payload contains an invalid credential.');
    }
    credentials.set(providerId, { type: 'api-key', value: credential.value });
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

async function ensureSecureDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Local credential directory is not a regular directory.');
  await chmod(directory, 0o700);
}

async function atomicWrite(filePath: string, value: string) {
  await ensureSecureDirectory(dirname(filePath));
  const existing = await lstat(filePath).catch((error: unknown) => {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing?.isSymbolicLink()) throw new Error('Refusing to write through a symbolic link.');
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(value, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function readOptionalText(filePath: string, maxBytes: number) {
  const value = await readOptionalBuffer(filePath, maxBytes);
  return value?.toString('utf8');
}

async function readOptionalBuffer(filePath: string, maxBytes: number) {
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('Local credential file is not a regular file.');
  if (info.size > maxBytes) throw new Error('Local credential file is too large.');
  return readFile(filePath);
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

function cloneCredential(credential: ProviderCredential): ProviderCredential {
  return credential.type === 'api-key' ? { type: 'api-key', value: credential.value } : { type: 'none' };
}

function cloneRecord(record: ConnectionRecord): ConnectionRecord {
  return { ...record, modelIds: [...record.modelIds], customModelIds: [...record.customModelIds] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
