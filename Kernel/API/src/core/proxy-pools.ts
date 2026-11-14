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


/** The schemes an outbound proxy may use. Anything else is a mistake, not a proxy. */
const proxySchemes = new Set(['http:', 'https:', 'socks5:', 'socks5h:', 'socks4:']);

/**
 * One proxy entry, validated on the way in.
 *
 * The first version filtered only by `typeof p === 'string'`, so a typo, a bare hostname, or a stray
 * scheme were all stored and later handed to the outbound path. The error names the host and the
 * problem and never the value: a proxy URL routinely carries `user:pass@`, and an error message is a
 * log line.
 */
export function validateProxyEntry(entry: unknown): string {
  if (typeof entry !== 'string' || !entry.trim()) throw new Error('Proxy entries must be non-empty strings.');
  const value = entry.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('A proxy entry is not a URL. Expected http://host:port, optionally with user:pass@.');
  }
  if (!proxySchemes.has(parsed.protocol)) {
    throw new Error(`A proxy entry uses "${parsed.protocol}" for host "${parsed.hostname}", which is not a proxy scheme. Expected http, https, socks4, socks5 or socks5h.`);
  }
  if (!parsed.hostname) throw new Error('A proxy entry has no host.');
  return value;
}

/**
 * The same entry with any credential replaced.
 *
 * Storing `user:pass@host` is legitimate — a paid proxy needs it — but returning it to a caller is not,
 * and the audit found the management route returning the pool verbatim.
 */
export function redactProxyEntry(entry: string): string {
  try {
    const parsed = new URL(entry);
    if (!parsed.username && !parsed.password) return entry;
    const port = parsed.port ? `:${parsed.port}` : '';
    return `${parsed.protocol}//***:***@${parsed.hostname}${port}`;
  } catch {
    return '<unparseable>';
  }
}

/** A pool as a caller may see it: the entries are real, their credentials are not. */
export function publicProxyPool(pool: ProxyPool): ProxyPool {
  return { ...pool, proxies: pool.proxies.map(redactProxyEntry) };
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function normalize(input: ProxyPoolInput, existing?: ProxyPool): ProxyPool {
  if (typeof input.id !== 'string' || !idPattern.test(input.id)) throw new Error('Proxy pool ids must be non-empty and contain only safe characters.');
  const name = input.name?.trim() || existing?.name || input.id;
  const now = new Date().toISOString();
  return {
    id: input.id,
    name,
    proxies: Array.isArray(input.proxies) ? input.proxies.map(validateProxyEntry) : existing?.proxies ?? [],
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
