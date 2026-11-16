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
  /** Encrypted-backup support, in this store's own file shape. Optional, like `ApiKeyStore`'s pair. */
  exportState?(): Promise<ProviderNodesBackupState>;
  /** Replaces every node. Validates before it mutates; see `parseProviderNodeState`. */
  importState?(state: ProviderNodesBackupState): Promise<void>;
}

/** The store's own file shape, so a backup is the file it already writes rather than a second format. */
export type ProviderNodesBackupState = ProviderNodesFile;

/**
 * Reads a backup's provider-node section — strictly, where the load path is tolerant: a corrupt file is an
 * empty list and one bad record is skipped, but neither applies to a whole section being swapped in. Every
 * record goes through the same `normalize` the writer uses.
 */
export function parseProviderNodeState(value: unknown): ProviderNodesBackupState {
  if (!isRecord(value) || !Array.isArray(value.providerNodes)) throw new Error('The backup\'s provider node section is not readable.');
  const providerNodes = new Map<string, ProviderNode>();
  for (const candidate of value.providerNodes) {
    if (!isStoredProviderNode(candidate)) throw new Error('The backup contains an unreadable provider node.');
    providerNodes.set(candidate.id, normalize(candidate, candidate));
  }
  return { version: 1, providerNodes: [...providerNodes.values()] };
}

/** Every field the writer puts on a record. A backup is read strictly, so one missing field is refused. */
function isStoredProviderNode(value: unknown): value is ProviderNode {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.providerId === 'string'
    && typeof value.connectionId === 'string'
    && typeof value.enabled === 'boolean'
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  async exportState(): Promise<ProviderNodesBackupState> { return { version: 1, providerNodes: [...this.items.values()] }; }
  async importState(state: ProviderNodesBackupState) {
    const next = parseProviderNodeState(state);
    this.items.clear();
    for (const node of next.providerNodes) this.items.set(node.id, node);
  }
}

type ProviderNodesFile = { version: 1; providerNodes: ProviderNode[] };

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
    return atomicWrite(this.path, `${JSON.stringify({ version: 1, providerNodes: [...this.items.values()] } satisfies ProviderNodesFile, null, 2)}\n`);
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

  async exportState(): Promise<ProviderNodesBackupState> {
    await this.mutationQueue;
    await this.ensureLoaded();
    return { version: 1, providerNodes: [...this.items.values()] };
  }

  /** Replaces every node in one write; the previous map is put back if that write fails. */
  async importState(state: ProviderNodesBackupState): Promise<void> {
    const next = parseProviderNodeState(state);
    return this.withMutation(async () => {
      await this.ensureLoaded();
      const previous = this.items;
      this.items = new Map(next.providerNodes.map((node) => [node.id, node] as const));
      try {
        await this.persist();
      } catch (error) {
        this.items = previous;
        await this.persist().catch(() => undefined);
        throw error;
      }
    });
  }
}
