import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { atomicWrite, defaultStateDirectory } from './secure-store.js';

export type Mitm = {
  id: string;
  name: string;
  port: number;
  enabled: boolean;
  certPath: string;
  createdAt: string;
  updatedAt: string;
};

export type MitmInput = {
  id: string;
  name?: string;
  port?: number;
  enabled?: boolean;
  certPath?: string;
};

export interface MitmStore {
  list(): Promise<Mitm[]>;
  get(id: string): Promise<Mitm | undefined>;
  save(input: MitmInput): Promise<Mitm>;
  remove(id: string): Promise<boolean>;
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function normalize(input: MitmInput, existing?: Mitm): Mitm {
  if (typeof input.id !== 'string' || !idPattern.test(input.id)) throw new Error('MITM ids must be non-empty and contain only safe characters.');
  const name = input.name?.trim() || existing?.name || input.id;
  const port = typeof input.port === 'number' && Number.isFinite(input.port) ? input.port : existing?.port ?? 8080;
  const now = new Date().toISOString();
  return {
    id: input.id,
    name,
    port,
    enabled: input.enabled ?? existing?.enabled ?? false,
    certPath: input.certPath?.trim() || existing?.certPath || '',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export class InMemoryMitmStore implements MitmStore {
  private readonly items = new Map<string, Mitm>();
  async list() { return [...this.items.values()].sort((a, b) => a.id.localeCompare(b.id)); }
  async get(id: string) { return this.items.get(id); }
  async save(input: MitmInput) {
    const next = normalize(input, this.items.get(input.id));
    this.items.set(next.id, next);
    return next;
  }
  async remove(id: string) { return this.items.delete(id); }
}

type File = { version: 1; mitm: Mitm[] };

export class LocalMitmStore implements MitmStore {
  private readonly path: string;
  private items = new Map<string, Mitm>();
  private loaded = false;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: { directory?: string; path?: string } = {}) {
    this.path = options.path ?? join(options.directory ?? defaultStateDirectory(), 'mitm.json');
  }

  private async ensureLoaded() {
    if (this.loaded) return;
    try {
      const raw: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (raw && typeof raw === 'object' && Array.isArray((raw as { mitm?: unknown }).mitm)) {
        for (const candidate of (raw as { mitm: unknown[] }).mitm) {
          try {
            const m = normalize(candidate as MitmInput, candidate as Mitm);
            this.items.set(m.id, m);
          } catch { /* skip */ }
        }
      }
    } catch { /* empty */ }
    this.loaded = true;
  }

  private persist() {
    return atomicWrite(this.path, `${JSON.stringify({ version: 1, mitm: [...this.items.values()] } satisfies File, null, 2)}\n`);
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
  async save(input: MitmInput) {
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
