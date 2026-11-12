import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { atomicWrite, defaultStateDirectory } from './secure-store.js';

export type ProviderNode = {
  id: string;
  name: string;
  providerId: string;
  connectionId: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ProviderNodeInput = {
  id: string;
  name?: string;
  providerId?: string;
  connectionId?: string;
  enabled?: boolean;
};

export interface ProviderNodeStore {
  list(): Promise<ProviderNode[]>;
  get(id: string): Promise<ProviderNode | undefined>;
  save(input: ProviderNodeInput): Promise<ProviderNode>;
  remove(id: string): Promise<boolean>;
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function normalize(input: ProviderNodeInput, existing?: ProviderNode): ProviderNode {
  if (typeof input.id !== 'string' || !idPattern.test(input.id)) throw new Error('Provider node ids must be non-empty and contain only safe characters.');
  const name = input.name?.trim() || existing?.name || input.id;
  const now = new Date().toISOString();
  return {
    id: input.id,
    name,
    providerId: input.providerId?.trim() || existing?.providerId || '',
    connectionId: input.connectionId?.trim() || existing?.connectionId || '',
    enabled: input.enabled ?? existing?.enabled ?? true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export class InMemoryProviderNodeStore implements ProviderNodeStore {
  private readonly items = new Map<string, ProviderNode>();
  async list() { return [...this.items.values()].sort((a, b) => a.id.localeCompare(b.id)); }
  async get(id: string) { return this.items.get(id); }
  async save(input: ProviderNodeInput) {
    const next = normalize(input, this.items.get(input.id));
    this.items.set(next.id, next);
    return next;
  }
  async remove(id: string) { return this.items.delete(id); }
}

type File = { version: 1; providerNodes: ProviderNode[] };

export class LocalProviderNodeStore implements ProviderNodeStore {
  private readonly path: string;
  private items = new Map<string, ProviderNode>();
  private loaded = false;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: { directory?: string; path?: string } = {}) {
    this.path = options.path ?? join(options.directory ?? defaultStateDirectory(), 'provider-nodes.json');
  }

  private async ensureLoaded() {
    if (this.loaded) return;
    try {
      const raw: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (raw && typeof raw === 'object' && Array.isArray((raw as { providerNodes?: unknown }).providerNodes)) {
        for (const candidate of (raw as { providerNodes: unknown[] }).providerNodes) {
          try {
            const n = normalize(candidate as ProviderNodeInput, candidate as ProviderNode);
            this.items.set(n.id, n);
          } catch { /* skip */ }
        }
      }
    } catch { /* empty */ }
    this.loaded = true;
  }

  private persist() {
    return atomicWrite(this.path, `${JSON.stringify({ version: 1, providerNodes: [...this.items.values()] } satisfies File, null, 2)}\n`);
  }

  private withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation, operation);
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async list() {
    await this.mutationQueue;
    await this.ensureLoaded();
    return [...this.items.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  async get(id: string) {
    await this.mutationQueue;
    await this.ensureLoaded();
    return this.items.get(id);
  }
  async save(input: ProviderNodeInput) {
    return this.withMutation(async () => {
      await this.ensureLoaded();
      const next = normalize(input, this.items.get(input.id));
      this.items.set(next.id, next);
      await this.persist();
      return next;
    });
  }
  async remove(id: string) {
    return this.withMutation(async () => {
      await this.ensureLoaded();
      const removed = this.items.delete(id);
      if (removed) await this.persist();
      return removed;
    });
  }
}
