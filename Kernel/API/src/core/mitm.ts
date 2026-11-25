import { createStateDocument, type StateDocument } from './state-document.js';

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
  /** Encrypted-backup support, in this store's own file shape. Optional, like `ApiKeyStore`'s pair. */
  exportState?(): Promise<MitmBackupState>;
  /** Replaces every entry. Validates before it mutates; see `parseMitmState`. */
  importState?(state: MitmBackupState): Promise<void>;
}

/** The store's own file shape, so a backup is the file it already writes rather than a second format. */
export type MitmBackupState = MitmFile;

/**
 * Reads a backup's MITM section — strictly, where the load path is tolerant: a corrupt file is an empty
 * list and one bad record is skipped, but neither applies to a whole section being swapped in. Every record
 * goes through the same `normalize` the writer uses.
 */
export function parseMitmState(value: unknown): MitmBackupState {
  if (!isRecord(value) || !Array.isArray(value.mitm)) throw new Error('The backup\'s MITM section is not readable.');
  const mitm = new Map<string, Mitm>();
  for (const candidate of value.mitm) {
    if (!isStoredMitm(candidate)) throw new Error('The backup contains an unreadable MITM entry.');
    mitm.set(candidate.id, normalize(candidate, candidate));
  }
  return { version: 1, mitm: [...mitm.values()] };
}

/** Every field the writer puts on a record. A backup is read strictly, so one missing field is refused. */
function isStoredMitm(value: unknown): value is Mitm {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.port === 'number'
    && typeof value.enabled === 'boolean'
    && typeof value.certPath === 'string'
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  async exportState(): Promise<MitmBackupState> { return { version: 1, mitm: [...this.items.values()] }; }
  async importState(state: MitmBackupState) {
    const next = parseMitmState(state);
    this.items.clear();
    for (const entry of next.mitm) this.items.set(entry.id, entry);
  }
}

type MitmFile = { version: 1; mitm: Mitm[] };

export class LocalMitmStore implements MitmStore {
  private readonly document: StateDocument;
  private items = new Map<string, Mitm>();
  private loaded = false;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: { directory?: string; path?: string } = {}) {
    this.document = createStateDocument({ directory: options.directory, name: 'mitm', ...(options.path ? { path: options.path } : {}) });
  }

  private async ensureLoaded() {
    if (this.loaded) return;
    try {
      const text = await this.document.read();
      const raw: unknown = text ? JSON.parse(text) : undefined;
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
    return this.document.write(`${JSON.stringify({ version: 1, mitm: [...this.items.values()] } satisfies MitmFile, null, 2)}\n`);
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

  async exportState(): Promise<MitmBackupState> {
    await this.mutationQueue;
    await this.ensureLoaded();
    return { version: 1, mitm: [...this.items.values()] };
  }

  /** Replaces every entry in one write; the previous map is put back if that write fails. */
  async importState(state: MitmBackupState): Promise<void> {
    const next = parseMitmState(state);
    return this.withMutation(async () => {
      await this.ensureLoaded();
      const previous = this.items;
      this.items = new Map(next.mitm.map((entry) => [entry.id, entry] as const));
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
