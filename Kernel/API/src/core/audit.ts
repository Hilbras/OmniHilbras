import { randomUUID } from 'node:crypto';
import { createStateDocument, type StateDocument } from './state-document.js';

/**
 * Who changed what, through which management request.
 *
 * This is deliberately small and content-free: an id, a timestamp, the actor's key id or `dashboard`,
 * the HTTP method and path, the status, and the request id the gateway already stamps. It never carries
 * a request body, a credential, a prompt or a connection record. A management write is audited at the
 * HTTP boundary, so a route added later is covered without a second call site; the cost is that the
 * action is the method and path rather than a provider-specific verb, which is the honest granularity
 * of a boundary this wide.
 */
export type AuditRecord = {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string;
  outcome: number;
  requestId?: string;
};

export interface AuditStore {
  record(input: Omit<AuditRecord, 'id' | 'at'>): Promise<AuditRecord>;
  list(limit?: number): Promise<AuditRecord[]>;
  exportState?(): Promise<AuditFile>;
  importState?(state: AuditFile): Promise<void>;
}

export type AuditFile = { version: 1; records: AuditRecord[] };

const maxAuditRecords = 5000;
const version = 1;

export class LocalAuditStore implements AuditStore {
  private readonly document: StateDocument;
  private records: AuditRecord[] = [];
  private loaded = false;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: { directory?: string; path?: string } = {}) {
    this.document = createStateDocument({ directory: options.directory, name: 'audit', ...(options.path ? { path: options.path } : {}) });
  }

  private async ensureLoaded() {
    if (this.loaded) return;
    const text = await this.document.read();
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { records?: unknown }).records)) {
          this.records = (parsed as { records: unknown[] }).records.filter(isRecord as (value: unknown) => value is AuditRecord).slice(-maxAuditRecords);
        }
      } catch {
        // A corrupt audit file is an empty audit trail, not an unstartable gateway.
      }
    }
    this.loaded = true;
  }

  private persist() {
    return this.document.write(`${JSON.stringify({ version, records: this.records } satisfies AuditFile)}\n`);
  }

  async record(input: Omit<AuditRecord, 'id' | 'at'>) {
    const entry: AuditRecord = { id: `audit_${randomUUID()}`, at: new Date().toISOString(), ...input };
    const run = this.mutationQueue.then(async () => {
      await this.ensureLoaded();
      this.records.push(entry);
      if (this.records.length > maxAuditRecords) this.records = this.records.slice(-maxAuditRecords);
      await this.persist();
      return entry;
    });
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async list(limit = 100) {
    await this.mutationQueue;
    await this.ensureLoaded();
    const bounded = Math.max(1, Math.min(Math.floor(limit), maxAuditRecords));
    return this.records.slice(-bounded).reverse();
  }

  async exportState(): Promise<AuditFile> {
    await this.mutationQueue;
    await this.ensureLoaded();
    return { version, records: [...this.records] };
  }

  async importState(state: AuditFile) {
    if (!state || state.version !== version || !Array.isArray(state.records)) throw new Error('The backup\'s audit section is not readable.');
    const records = state.records.filter(isRecord).slice(-maxAuditRecords);
    const run = this.mutationQueue.then(async () => {
      await this.ensureLoaded();
      this.records = records;
      await this.persist();
    });
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}

function isRecord(value: unknown): value is AuditRecord {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === 'string'
    && typeof entry.at === 'string'
    && typeof entry.actor === 'string'
    && typeof entry.action === 'string'
    && typeof entry.target === 'string'
    && typeof entry.outcome === 'number';
}