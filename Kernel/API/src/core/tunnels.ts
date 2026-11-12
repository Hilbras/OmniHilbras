import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { atomicWrite, defaultStateDirectory } from './secure-store.js';

export type Tunnel = {
  id: string;
  name: string;
  provider: string;
  token: string;
  publicUrl: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type TunnelInput = {
  id: string;
  name?: string;
  provider?: string;
  token?: string;
  publicUrl?: string;
  enabled?: boolean;
};

export interface TunnelStore {
  list(): Promise<Tunnel[]>;
  get(id: string): Promise<Tunnel | undefined>;
  save(input: TunnelInput): Promise<Tunnel>;
  remove(id: string): Promise<boolean>;
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function normalize(input: TunnelInput, existing?: Tunnel): Tunnel {
  if (typeof input.id !== 'string' || !idPattern.test(input.id)) throw new Error('Tunnel ids must be non-empty and contain only safe characters.');
  const name = input.name?.trim() || existing?.name || input.id;
  const now = new Date().toISOString();
  return {
    id: input.id,
    name,
    provider: input.provider?.trim() || existing?.provider || 'cloudflare',
    token: input.token ?? existing?.token ?? '',
    publicUrl: input.publicUrl?.trim() || existing?.publicUrl || '',
    enabled: input.enabled ?? existing?.enabled ?? false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export class InMemoryTunnelStore implements TunnelStore {
  private readonly items = new Map<string, Tunnel>();
  async list() { return [...this.items.values()].sort((a, b) => a.id.localeCompare(b.id)); }
  async get(id: string) { return this.items.get(id); }
  async save(input: TunnelInput) {
    const next = normalize(input, this.items.get(input.id));
    this.items.set(next.id, next);
    return next;
  }
  async remove(id: string) { return this.items.delete(id); }
}

type File = { version: 1; tunnels: Tunnel[] };

export class LocalTunnelStore implements TunnelStore {
  private readonly path: string;
  private items = new Map<string, Tunnel>();
  private loaded = false;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: { directory?: string; path?: string } = {}) {
    this.path = options.path ?? join(options.directory ?? defaultStateDirectory(), 'tunnels.json');
  }

  private async ensureLoaded() {
    if (this.loaded) return;
    try {
      const raw: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (raw && typeof raw === 'object' && Array.isArray((raw as { tunnels?: unknown }).tunnels)) {
        for (const candidate of (raw as { tunnels: unknown[] }).tunnels) {
          try {
            const t = normalize(candidate as TunnelInput, candidate as Tunnel);
            this.items.set(t.id, t);
          } catch { /* skip */ }
        }
      }
    } catch { /* empty */ }
    this.loaded = true;
  }

  private persist() {
    return atomicWrite(this.path, `${JSON.stringify({ version: 1, tunnels: [...this.items.values()] } satisfies File, null, 2)}\n`);
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
  async save(input: TunnelInput) {
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
