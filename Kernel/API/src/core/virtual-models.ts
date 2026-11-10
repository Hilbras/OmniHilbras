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
}
