import { createStateDocument, type StateDocument } from './state-document.js';

export type Workspace = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceInput = {
  id: string;
  name?: string;
  description?: string;
  enabled?: boolean;
};

export interface WorkspaceStore {
  list(): Promise<Workspace[]>;
  get(id: string): Promise<Workspace | undefined>;
  save(input: WorkspaceInput): Promise<Workspace>;
  remove(id: string): Promise<boolean>;
  /** Encrypted-backup support, in this store's own file shape. Optional, like `ApiKeyStore`'s pair. */
  exportState?(): Promise<WorkspacesBackupState>;
  /** Replaces every workspace. Validates before it mutates; see `parseWorkspaceState`. */
  importState?(state: WorkspacesBackupState): Promise<void>;
}

/** The store's own file shape, so a backup is the file it already writes rather than a second format. */
export type WorkspacesBackupState = WorkspacesFile;

/**
 * Reads a backup's workspace section — strictly, where the load path is tolerant: a corrupt file is an
 * empty list rather than an unstartable gateway, and one bad record is skipped rather than hiding the
 * rest, but neither applies to a whole section being swapped in. Every record goes through the same
 * `normalize` the writer uses.
 */
export function parseWorkspaceState(value: unknown): WorkspacesBackupState {
  if (!isRecord(value) || !Array.isArray(value.workspaces)) throw new Error('The backup\'s workspace section is not readable.');
  const workspaces = new Map<string, Workspace>();
  for (const candidate of value.workspaces) {
    if (!isStoredWorkspace(candidate)) throw new Error('The backup contains an unreadable workspace.');
    workspaces.set(candidate.id, normalize(candidate, candidate));
  }
  return { version: 1, workspaces: [...workspaces.values()] };
}

/** Every field the writer puts on a record. A backup is read strictly, so one missing field is refused. */
function isStoredWorkspace(value: unknown): value is Workspace {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.description === 'string'
    && typeof value.enabled === 'boolean'
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function normalize(input: WorkspaceInput, existing?: Workspace): Workspace {
  if (typeof input.id !== 'string' || !idPattern.test(input.id)) throw new Error('Workspace ids must be non-empty and contain only safe characters.');
  const name = input.name?.trim() || existing?.name || input.id;
  if (!name) throw new Error('A workspace needs a name.');
  const now = new Date().toISOString();
  return {
    id: input.id,
    name,
    description: input.description?.trim() ?? existing?.description ?? '',
    enabled: input.enabled ?? existing?.enabled ?? true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export class InMemoryWorkspaceStore implements WorkspaceStore {
  private readonly items = new Map<string, Workspace>();
  async list() { return [...this.items.values()].sort((a, b) => a.id.localeCompare(b.id)); }
  async get(id: string) { return this.items.get(id); }
  async save(input: WorkspaceInput) {
    const next = normalize(input, this.items.get(input.id));
    this.items.set(next.id, next);
    return next;
  }
  async remove(id: string) { return this.items.delete(id); }
  async exportState(): Promise<WorkspacesBackupState> { return { version: 1, workspaces: [...this.items.values()] }; }
  async importState(state: WorkspacesBackupState) {
    const next = parseWorkspaceState(state);
    this.items.clear();
    for (const workspace of next.workspaces) this.items.set(workspace.id, workspace);
  }
}

type WorkspacesFile = { version: 1; workspaces: Workspace[] };

export class LocalWorkspaceStore implements WorkspaceStore {
  private readonly document: StateDocument;
  private items = new Map<string, Workspace>();
  private loaded = false;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: { directory?: string; path?: string } = {}) {
    this.document = createStateDocument({ directory: options.directory, name: 'workspaces', ...(options.path ? { path: options.path } : {}) });
  }

  private async ensureLoaded() {
    if (this.loaded) return;
    try {
      const text = await this.document.read();
      const raw: unknown = text ? JSON.parse(text) : undefined;
      if (raw && typeof raw === 'object' && Array.isArray((raw as { workspaces?: unknown }).workspaces)) {
        for (const candidate of (raw as { workspaces: unknown[] }).workspaces) {
          try {
            const ws = normalize(candidate as WorkspaceInput, candidate as Workspace);
            this.items.set(ws.id, ws);
          } catch { /* skip */ }
        }
      }
    } catch { /* empty */ }
    this.loaded = true;
  }

  private persist() {
    return this.document.write(`${JSON.stringify({ version: 1, workspaces: [...this.items.values()] } satisfies WorkspacesFile, null, 2)}\n`);
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
  async save(input: WorkspaceInput) {
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

  async exportState(): Promise<WorkspacesBackupState> {
    await this.mutationQueue;
    await this.ensureLoaded();
    return { version: 1, workspaces: [...this.items.values()] };
  }

  /** Replaces every workspace in one write; the previous map is put back if that write fails. */
  async importState(state: WorkspacesBackupState): Promise<void> {
    const next = parseWorkspaceState(state);
    return this.withMutation(async () => {
      await this.ensureLoaded();
      const previous = this.items;
      this.items = new Map(next.workspaces.map((workspace) => [workspace.id, workspace] as const));
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
