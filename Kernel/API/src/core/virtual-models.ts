import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { atomicWrite, defaultStateDirectory } from './secure-store.js';

/**
 * A virtual model is one public ID mapped to one or more saved account/upstream-model pairs.
 *
 * The `oh/` prefix is not decoration: it keeps a virtual ID from colliding with a concrete model ID that
 * a provider may already answer to, and it makes a request that depends on local routing obvious in a log.
 */
export type VirtualModelStrategy = 'priority' | 'round-robin' | 'fastest';

export type VirtualModelTarget = {
  connectionId: string;
  upstreamModelId: string;
  /** Lower runs first. */
  priority: number;
  enabled: boolean;
};

export type VirtualModel = {
  id: string;
  name: string;
  enabled: boolean;
  strategy: VirtualModelStrategy;
  targets: VirtualModelTarget[];
  createdAt: string;
  updatedAt: string;
};

export type VirtualModelInput = {
  id: string;
  name?: string;
  enabled?: boolean;
  strategy?: VirtualModelStrategy;
  targets: Array<{
    connectionId: string;
    upstreamModelId: string;
    priority?: number;
    enabled?: boolean;
  }>;
};

export interface VirtualModelStore {
  list(): Promise<VirtualModel[]>;
  get(id: string): Promise<VirtualModel | undefined>;
  save(input: VirtualModelInput): Promise<VirtualModel>;
  remove(id: string): Promise<boolean>;
  /** Encrypted-backup support, in this store's own file shape. Optional, like `ApiKeyStore`'s pair. */
  exportState?(): Promise<VirtualModelsBackupState>;
  /** Replaces every virtual model. Validates before it mutates; see `parseVirtualModelState`. */
  importState?(state: VirtualModelsBackupState): Promise<void>;
}

/** The store's own file shape, so a backup is the file it already writes rather than a second format. */
export type VirtualModelsBackupState = VirtualModelsFile;

/**
 * Reads a backup's virtual-model section — strictly, where the load path is tolerant: a corrupt file is an
 * empty catalog and one malformed record stays out until rewritten, but neither applies to a whole section
 * being swapped in. Every record goes through the same `normalizeVirtualModelInput` the writer uses, so an
 * imported model is one a save would have produced.
 */
export function parseVirtualModelState(value: unknown): VirtualModelsBackupState {
  if (!isRecord(value) || !Array.isArray(value.models)) throw new Error('The backup\'s virtual model section is not readable.');
  const models = new Map<string, VirtualModel>();
  for (const candidate of value.models) {
    if (!isStoredVirtualModel(candidate)) throw new Error('The backup contains an unreadable virtual model.');
    const model = normalizeVirtualModelInput(candidate as VirtualModelInput, candidate as VirtualModel);
    models.set(model.id, model);
  }
  return { version: 1, models: [...models.values()] };
}

/** Every field the writer puts on a record. A backup is read strictly, so one missing field is refused. */
function isStoredVirtualModel(value: unknown): value is VirtualModel {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.enabled === 'boolean'
    && typeof value.strategy === 'string'
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string'
    && Array.isArray(value.targets)
    && value.targets.every((target) => isRecord(target)
      && typeof target.connectionId === 'string'
      && typeof target.upstreamModelId === 'string'
      && typeof target.priority === 'number'
      && typeof target.enabled === 'boolean');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const virtualIdPattern = /^oh\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const strategies = new Set<VirtualModelStrategy>(['priority', 'round-robin', 'fastest']);

export function assertVirtualModelId(id: string) {
  if (typeof id !== 'string' || !virtualIdPattern.test(id)) {
    throw new Error('Virtual model ids must start with "oh/" and contain a non-empty model name.');
  }
  if (id.endsWith('/') || id.includes('//')) throw new Error('Virtual model ids must not contain an empty path segment.');
}

export function normalizeVirtualModelInput(input: VirtualModelInput, existing?: VirtualModel): VirtualModel {
  assertVirtualModelId(input.id);
  const name = input.name?.trim() || input.id.slice('oh/'.length);
  if (!name) throw new Error('A virtual model needs a name.');
  if (input.strategy !== undefined && !strategies.has(input.strategy)) throw new Error('strategy must be priority, round-robin or fastest.');
  const enabled = input.enabled ?? existing?.enabled ?? true;
  const targets = (Array.isArray(input.targets) ? input.targets : []).map((target) => {
    if (!target || typeof target.connectionId !== 'string' || !target.connectionId.trim()) throw new Error('Every target needs a connectionId.');
    if (typeof target.upstreamModelId !== 'string' || !target.upstreamModelId.trim()) throw new Error('Every target needs an upstreamModelId.');
    const priority = target.priority ?? 1;
    if (!Number.isInteger(priority) || priority < 0 || priority > 1_000) throw new Error('Target priority must be an integer from 0 to 1000.');
    return {
      connectionId: target.connectionId.trim(),
      upstreamModelId: target.upstreamModelId.trim(),
      priority,
      enabled: target.enabled ?? true,
    };
  });
  const seen = new Set<string>();
  for (const target of targets) {
    const key = `${target.connectionId}\u0000${target.upstreamModelId}`;
    if (seen.has(key)) throw new Error('A virtual model cannot list the same connection and upstream model twice.');
    seen.add(key);
  }
  if (enabled && !targets.some((target) => target.enabled)) throw new Error('An enabled virtual model needs at least one enabled target.');
  const now = new Date().toISOString();
  return {
    id: input.id,
    name,
    enabled,
    strategy: input.strategy ?? existing?.strategy ?? 'priority',
    targets,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

/** A store for tests and embedded services that do not persist. */
export class InMemoryVirtualModelStore implements VirtualModelStore {
  private readonly models = new Map<string, VirtualModel>();

  async list() {
    return [...this.models.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  async get(id: string) {
    return this.models.get(id);
  }

  async save(input: VirtualModelInput) {
    const next = normalizeVirtualModelInput(input, this.models.get(input.id));
    this.models.set(next.id, next);
    return next;
  }

  async remove(id: string) {
    return this.models.delete(id);
  }
  async exportState(): Promise<VirtualModelsBackupState> { return { version: 1, models: [...this.models.values()] }; }
  async importState(state: VirtualModelsBackupState) {
    const next = parseVirtualModelState(state);
    this.models.clear();
    for (const model of next.models) this.models.set(model.id, model);
  }
}

type VirtualModelsFile = { version: 1; models: VirtualModel[] };

/** Durable store; mutations are serialised so two saves cannot overwrite each other. */
export class LocalVirtualModelStore implements VirtualModelStore {
  private readonly path: string;
  private models = new Map<string, VirtualModel>();
  private loaded = false;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: { directory?: string; path?: string } = {}) {
    this.path = options.path ?? join(options.directory ?? defaultStateDirectory(), 'virtual-models.json');
  }

  private async ensureLoaded() {
    if (this.loaded) return;
    try {
      const raw: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (raw && typeof raw === 'object' && Array.isArray((raw as { models?: unknown }).models)) {
        for (const candidate of (raw as { models: unknown[] }).models) {
          try {
            const model = normalizeVirtualModelInput(candidate as VirtualModelInput, candidate as VirtualModel);
            this.models.set(model.id, model);
          } catch {
            // One malformed record must not hide the rest of the file; it stays out until rewritten.
          }
        }
      }
    } catch {
      // A missing or corrupt file is an empty catalog, not an unstartable gateway.
    }
    this.loaded = true;
  }

  private persist() {
    return atomicWrite(this.path, `${JSON.stringify({ version: 1, models: [...this.models.values()] } satisfies VirtualModelsFile, null, 2)}\n`);
  }

  private withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation, operation);
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async list() {
    await this.mutationQueue;
    await this.ensureLoaded();
    return [...this.models.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  async get(id: string) {
    await this.mutationQueue;
    await this.ensureLoaded();
    return this.models.get(id);
  }

  async save(input: VirtualModelInput) {
    return this.withMutation(async () => {
      await this.ensureLoaded();
      const next = normalizeVirtualModelInput(input, this.models.get(input.id));
      this.models.set(next.id, next);
      await this.persist();
      return next;
    });
  }

  async remove(id: string) {
    return this.withMutation(async () => {
      await this.ensureLoaded();
      const removed = this.models.delete(id);
      if (removed) await this.persist();
      return removed;
    });
  }

  async exportState(): Promise<VirtualModelsBackupState> {
    await this.mutationQueue;
    await this.ensureLoaded();
    return { version: 1, models: [...this.models.values()] };
  }

  /** Replaces every virtual model in one write; the previous map is put back if that write fails. */
  async importState(state: VirtualModelsBackupState): Promise<void> {
    const next = parseVirtualModelState(state);
    return this.withMutation(async () => {
      await this.ensureLoaded();
      const previous = this.models;
      this.models = new Map(next.models.map((model) => [model.id, model] as const));
      try {
        await this.persist();
      } catch (error) {
        this.models = previous;
        await this.persist().catch(() => undefined);
        throw error;
      }
    });
  }
}
