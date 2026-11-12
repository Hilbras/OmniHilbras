import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { atomicWrite, defaultStateDirectory } from './secure-store.js';

export type ProxyPool = {
  id: string;
  name: string;
  proxies: string[];
  strategy: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ProxyPoolInput = {
  id: string;
  name?: string;
  proxies?: string[];
  strategy?: string;
  enabled?: boolean;
};

export interface ProxyPoolStore {
  list(): Promise<ProxyPool[]>;
  get(id: string): Promise<ProxyPool | undefined>;
  save(input: ProxyPoolInput): Promise<ProxyPool>;
  remove(id: string): Promise<boolean>;
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function normalize(input: ProxyPoolInput, existing?: ProxyPool): ProxyPool {
  if (typeof input.id !== 'string' || !idPattern.test(input.id)) throw new Error('Proxy pool ids must be non-empty and contain only safe characters.');
  const name = input.name?.trim() || existing?.name || input.id;
  const now = new Date().toISOString();
  return {
    id: input.id,
    name,
    proxies: Array.isArray(input.proxies) ? input.proxies.filter((p) => typeof p === 'string') : existing?.proxies ?? [],
    strategy: input.strategy?.trim() || existing?.strategy || 'round-robin',
    enabled: input.enabled ?? existing?.enabled ?? true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export class InMemoryProxyPoolStore implements ProxyPoolStore {
  private readonly items = new Map<string, ProxyPool>();
  async list() { return [...this.items.values()].sort((a, b) => a.id.localeCompare(b.id)); }
  async get(id: string) { return this.items.get(id); }
  async save(input: ProxyPoolInput) {
    const next = normalize(input, this.items.get(input.id));
    this.items.set(next.id, next);
    return next;
  }
  async remove(id: string) { return this.items.delete(id); }
}

type File = { version: 1; proxyPools: ProxyPool[] };

export class LocalProxyPoolStore implements ProxyPoolStore {
  private readonly path: string;
  private items = new Map<string, ProxyPool>();
  private loaded = false;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: { directory?: string; path?: string } = {}) {
    this.path = options.path ?? join(options.directory ?? defaultStateDirectory(), 'proxy-pools.json');
  }

  private async ensureLoaded() {
    if (this.loaded) return;
    try {
      const raw: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (raw && typeof raw === 'object' && Array.isArray((raw as { proxyPools?: unknown }).proxyPools)) {
        for (const candidate of (raw as { proxyPools: unknown[] }).proxyPools) {
          try {
            const p = normalize(candidate as ProxyPoolInput, candidate as ProxyPool);
            this.items.set(p.id, p);
          } catch { /* skip */ }
        }
      }
    } catch { /* empty */ }
    this.loaded = true;
  }

  private persist() {
    return atomicWrite(this.path, `${JSON.stringify({ version: 1, proxyPools: [...this.items.values()] } satisfies File, null, 2)}\n`);
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
  async save(input: ProxyPoolInput) {
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
