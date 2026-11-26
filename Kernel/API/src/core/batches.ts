import { randomBytes } from 'node:crypto';
import { createStateDocument, type StateDocument } from './state-document.js';
import { defaultStateDirectory } from './secure-store.js';
import type { ChatRequest } from './index.js';

/**
 * Batches: many independent requests, one durable record.
 *
 * The gateway already has a job history and an idempotent usage record; a batch is the smallest thing
 * that turns them into work a caller can submit once and collect later. Requests run through the same
 * routing, budget gate and usage accounting as an ordinary turn — a batch is not a cheaper lane, it
 * is a deferred one.
 *
 * The record is bounded (items, results) and persisted, so a restart does not lose the answer to
 * "what did I submit". Processing itself is in-memory: a gateway restarted mid-batch marks the batch
 * interrupted rather than pretending it finished.
 */

export type BatchStatus = 'validating' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export type BatchItem = {
  customId: string;
  body: Record<string, unknown>;
};

export type BatchResult = {
  customId: string;
  ok: boolean;
  response?: unknown;
  error?: string;
};

export type BatchRecord = {
  id: string;
  status: BatchStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  apiKeyId?: string;
  workspaceId?: string;
  items: BatchItem[];
  results: BatchResult[];
  error?: string;
};

export type BatchStore = {
  list(limit?: number): Promise<BatchRecord[]>;
  get(id: string): Promise<BatchRecord | undefined>;
  create(record: Omit<BatchRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<BatchRecord>;
  update(id: string, change: Partial<Pick<BatchRecord, 'status' | 'results' | 'error' | 'completedAt'>>): Promise<BatchRecord | undefined>;
};

export class LocalBatchStore implements BatchStore {
  private readonly document: StateDocument;
  private records = new Map<string, BatchRecord>();
  private loaded?: Promise<void>;

  constructor(options: { directory?: string; path?: string; env?: Readonly<Record<string, string | undefined>> } = {}) {
    this.document = createStateDocument({
      name: 'batches',
      directory: options.directory ?? defaultStateDirectory(options.env),
      ...(options.path === undefined ? {} : { path: options.path }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
  }

  private async ensureLoaded(): Promise<void> {
    this.loaded ??= (async () => {
      const text = await this.document.read(32 * 1024 * 1024).catch(() => undefined);
      if (!text) return;
      try {
        const parsed = JSON.parse(text) as { batches?: unknown };
        if (Array.isArray(parsed.batches)) {
          for (const item of parsed.batches) if (isBatch(item)) this.records.set(item.id, item);
        }
        for (const record of this.records.values()) {
          if (record.status === 'validating' || record.status === 'in_progress') {
            record.status = 'interrupted';
            record.error = 'The gateway restarted before this batch finished.';
            record.updatedAt = new Date().toISOString();
          }
        }
      } catch { /* an unreadable file is empty */ }
    })();
    await this.loaded;
  }

  async list(limit = 50): Promise<BatchRecord[]> {
    await this.ensureLoaded();
    return [...this.records.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, Math.min(Math.max(limit, 1), 200)).map((record) => ({ ...record }));
  }

  async get(id: string): Promise<BatchRecord | undefined> {
    await this.ensureLoaded();
    const record = this.records.get(id);
    return record ? { ...record } : undefined;
  }

  async create(input: Omit<BatchRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<BatchRecord> {
    await this.ensureLoaded();
    const now = new Date().toISOString();
    const record: BatchRecord = { ...input, id: `batch_${randomBytes(9).toString('base64url')}`, createdAt: now, updatedAt: now };
    this.records.set(record.id, record);
    await this.persist();
    return { ...record };
  }

  async update(id: string, change: Partial<Pick<BatchRecord, 'status' | 'results' | 'error' | 'completedAt'>>): Promise<BatchRecord | undefined> {
    await this.ensureLoaded();
    const record = this.records.get(id);
    if (!record) return undefined;
    const next: BatchRecord = { ...record, ...change, updatedAt: new Date().toISOString() };
    this.records.set(id, next);
    await this.persist();
    return { ...next };
  }

  private persist() {
    return this.document.write(JSON.stringify({ version: 1, batches: [...this.records.values()] }));
  }
}

function isBatch(value: unknown): value is BatchRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.status === 'string' && typeof record.createdAt === 'string'
    && typeof record.updatedAt === 'string' && Array.isArray(record.items) && Array.isArray(record.results);
}

export const maxBatchItems = 1_000;

/** Validates the request bodies without accepting a shape the chat path would refuse later. */
export function parseBatchItems(value: unknown): { items: BatchItem[]; error?: string } {
  if (!Array.isArray(value) || value.length === 0) return { items: [], error: 'requests must be a non-empty array.' };
  if (value.length > maxBatchItems) return { items: [], error: `A batch may carry at most ${maxBatchItems} requests.` };
  const items: BatchItem[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== 'object' || candidate === null) return { items: [], error: 'Each request must be an object.' };
    const record = candidate as Record<string, unknown>;
    const customId = record.custom_id;
    const body = record.body;
    if (typeof customId !== 'string' || customId.length === 0 || customId.length > 64) return { items: [], error: 'custom_id must be a non-empty string of at most 64 characters.' };
    if (seen.has(customId)) return { items: [], error: `Duplicate custom_id: ${customId}.` };
    seen.add(customId);
    if (typeof body !== 'object' || body === null || typeof (body as Record<string, unknown>).model !== 'string' || !Array.isArray((body as Record<string, unknown>).messages)) {
      return { items: [], error: `Request ${customId} needs a model and messages.` };
    }
    items.push({ customId, body: body as Record<string, unknown> });
  }
  return { items };
}


/** A batch item's body, turned into the same ChatRequest the chat route builds. */
export function batchChatRequest(body: Record<string, unknown>): ChatRequest {
  if (typeof body.model !== 'string' || !Array.isArray(body.messages)) throw new Error('A batch request needs a model and messages.');
  const max = body.max_completion_tokens ?? body.max_tokens;
  const temperature = body.temperature;
  return {
    model: body.model,
    messages: body.messages as ChatRequest['messages'],
    ...(typeof max === 'number' && Number.isInteger(max) && max > 0 ? { maxOutputTokens: max } : {}),
    ...(typeof temperature === 'number' ? { temperature } : {}),
    ...(Array.isArray(body.tools) ? { tools: body.tools as ChatRequest['tools'] } : {}),
    stream: false,
  };
}
