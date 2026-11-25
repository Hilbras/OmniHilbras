import { createStateDocument, type StateDocument } from './state-document.js';

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

/**
 * A tunnel as a caller may see it.
 *
 * `token` is omitted rather than blanked, so a caller cannot tell a stored token from a stored empty
 * one, and `hasToken` says what the management UI actually needs to know. The audit found the route
 * returning the whole record — the token is enough to run `cloudflared` elsewhere and attach to the
 * operator's named tunnel.
 */
export type PublicTunnel = Omit<Tunnel, 'token'> & { hasToken: boolean };

export function publicTunnel(tunnel: Tunnel): PublicTunnel {
  const { token, ...rest } = tunnel;
  return { ...rest, hasToken: typeof token === 'string' && token.length > 0 };
}

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
  /** Encrypted-backup support, in this store's own file shape. Optional, like `ApiKeyStore`'s pair. */
  exportState?(): Promise<TunnelsBackupState>;
  /** Replaces every tunnel. Validates before it mutates; see `parseTunnelState`. */
  importState?(state: TunnelsBackupState): Promise<void>;
}

/** The store's own file shape, so a backup is the file it already writes rather than a second format. */
export type TunnelsBackupState = TunnelsFile;

/**
 * Reads a backup's tunnel section — strictly, where the load path is tolerant.
 *
 * **This section carries a credential in clear**: `token` is a cloudflared token, and holding one is
 * enough to attach to the operator's named tunnel. It is exported because a tunnel without its token is a
 * tunnel that does not work after a restore, and it goes only into the encrypted envelope. It must never
 * be logged, echoed in an error, or returned to a browser — `publicTunnel` is the shape a caller sees.
 */
export function parseTunnelState(value: unknown): TunnelsBackupState {
  if (!isRecord(value) || !Array.isArray(value.tunnels)) throw new Error('The backup\'s tunnel section is not readable.');
  const tunnels = new Map<string, Tunnel>();
  for (const candidate of value.tunnels) {
    if (!isStoredTunnel(candidate)) throw new Error('The backup contains an unreadable tunnel.');
    tunnels.set(candidate.id, normalize(candidate, candidate));
  }
  return { version: 1, tunnels: [...tunnels.values()] };
}

/** Every field the writer puts on a record. A backup is read strictly, so one missing field is refused. */
function isStoredTunnel(value: unknown): value is Tunnel {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.provider === 'string'
    && typeof value.token === 'string'
    && typeof value.publicUrl === 'string'
    && typeof value.enabled === 'boolean'
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  async exportState(): Promise<TunnelsBackupState> { return { version: 1, tunnels: [...this.items.values()] }; }
  async importState(state: TunnelsBackupState) {
    const next = parseTunnelState(state);
    this.items.clear();
    for (const tunnel of next.tunnels) this.items.set(tunnel.id, tunnel);
  }
}

type TunnelsFile = { version: 1; tunnels: Tunnel[] };

export class LocalTunnelStore implements TunnelStore {
  private readonly document: StateDocument;
  private items = new Map<string, Tunnel>();
  private loaded = false;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: { directory?: string; path?: string } = {}) {
    this.document = createStateDocument({ directory: options.directory, name: 'tunnels', ...(options.path ? { path: options.path } : {}) });
  }

  private async ensureLoaded() {
    if (this.loaded) return;
    try {
      const text = await this.document.read();
      const raw: unknown = text ? JSON.parse(text) : undefined;
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
    return this.document.write(`${JSON.stringify({ version: 1, tunnels: [...this.items.values()] } satisfies TunnelsFile, null, 2)}\n`);
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

  async exportState(): Promise<TunnelsBackupState> {
    await this.mutationQueue;
    await this.ensureLoaded();
    return { version: 1, tunnels: [...this.items.values()] };
  }

  /** Replaces every tunnel in one write; the previous map is put back if that write fails. */
  async importState(state: TunnelsBackupState): Promise<void> {
    const next = parseTunnelState(state);
    return this.withMutation(async () => {
      await this.ensureLoaded();
      const previous = this.items;
      this.items = new Map(next.tunnels.map((tunnel) => [tunnel.id, tunnel] as const));
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
