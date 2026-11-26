import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createStateDocument, type StateDocument } from './state-document.js';
import { defaultStateDirectory } from './secure-store.js';
import { isPrivateHostname } from './index.js';

/**
 * Signed webhooks for work that finishes after the response.
 *
 * Batch completion, video completion and a budget crossing a threshold are facts a caller learns
 * later. Polling was the documented limit; this delivers the fact instead, with the three properties
 * a receiver needs to trust it: an HMAC over the exact body, a timestamp inside the signed material
 * so a replay has a window, and retries with backoff so a transient failure is not a lost event.
 *
 * The destination check is the security half. A webhook URL is an outbound request chosen by an
 * operator, which makes it an SSRF surface: only `https`, no private/loopback/link-local literal, and
 * an explicit allowlist for a deliberately local receiver.
 */

export type WebhookEvent = 'batch.completed' | 'video.completed' | 'budget.threshold' | 'test';

export type Webhook = {
  id: string;
  url: string;
  secret: string;
  events: WebhookEvent[];
  enabled: boolean;
  createdAt: string;
};

export type WebhookDelivery = {
  id: string;
  webhookId: string;
  event: WebhookEvent;
  at: string;
  status: 'delivered' | 'failed' | 'dropped';
  attempts: number;
  detail?: string;
};

const events: readonly WebhookEvent[] = ['batch.completed', 'video.completed', 'budget.threshold', 'test'];

export function isWebhookEvent(value: unknown): value is WebhookEvent {
  return typeof value === 'string' && (events as readonly string[]).includes(value);
}

/** Whether a destination may be called. `allowLocal` is the operator's explicit override. */
export function webhookDestinationAllowed(url: string, allowLocal = false): { allowed: boolean; reason?: string } {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { allowed: false, reason: 'url is not absolute' }; }
  if (parsed.protocol !== 'https:') return { allowed: false, reason: 'webhooks must use https' };
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (allowLocal) return { allowed: true };
  if (isPrivateHostname(hostname)) return { allowed: false, reason: 'destination resolves to a private or loopback address' };
  return { allowed: true };
}

export function webhookSignature(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function verifyWebhookSignature(secret: string, timestamp: string, body: string, signature: string): boolean {
  const expected = webhookSignature(secret, timestamp, body);
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class LocalWebhookStore {
  private readonly document: StateDocument;
  private hooks: Webhook[] = [];
  private loaded?: Promise<void>;

  constructor(options: { directory?: string; path?: string; env?: Readonly<Record<string, string | undefined>> } = {}) {
    this.document = createStateDocument({
      name: 'webhooks',
      directory: options.directory ?? defaultStateDirectory(options.env),
      ...(options.path === undefined ? {} : { path: options.path }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
  }

  private async ensureLoaded(): Promise<void> {
    this.loaded ??= (async () => {
      const text = await this.document.read(1_000_000).catch(() => undefined);
      if (!text) return;
      try {
        const parsed = JSON.parse(text) as { hooks?: unknown };
        if (Array.isArray(parsed.hooks)) this.hooks = parsed.hooks.filter(isWebhook);
      } catch { /* an unreadable registry is empty, not fatal */ }
    })();
    await this.loaded;
  }

  async list(): Promise<Webhook[]> {
    await this.ensureLoaded();
    return this.hooks.map((hook) => ({ ...hook }));
  }

  async save(input: { url: string; events?: WebhookEvent[]; enabled?: boolean; allowLocal?: boolean }): Promise<Webhook> {
    await this.ensureLoaded();
    const destination = webhookDestinationAllowed(input.url, input.allowLocal === true);
    if (!destination.allowed) throw new Error(destination.reason ?? 'destination is not allowed');
    const hook: Webhook = {
      id: `wh_${randomBytes(9).toString('base64url')}`,
      url: input.url,
      secret: `whsec_${randomBytes(24).toString('base64url')}`,
      events: input.events && input.events.length > 0 ? input.events : ['test'],
      enabled: input.enabled !== false,
      createdAt: new Date().toISOString(),
    };
    this.hooks.push(hook);
    await this.persist();
    return { ...hook };
  }

  async remove(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const before = this.hooks.length;
    this.hooks = this.hooks.filter((hook) => hook.id !== id);
    if (this.hooks.length === before) return false;
    await this.persist();
    return true;
  }

  private persist() {
    return this.document.write(JSON.stringify({ version: 1, hooks: this.hooks }));
  }
}

function isWebhook(value: unknown): value is Webhook {
  if (typeof value !== 'object' || value === null) return false;
  const hook = value as Record<string, unknown>;
  return typeof hook.id === 'string' && typeof hook.url === 'string' && typeof hook.secret === 'string'
    && typeof hook.enabled === 'boolean' && typeof hook.createdAt === 'string'
    && Array.isArray(hook.events) && hook.events.every(isWebhookEvent);
}

export type WebhookDispatcherOptions = {
  store: LocalWebhookStore;
  allowLocal?: boolean;
  /** Max attempts, including the first. */
  attempts?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
  deadLetterLimit?: number;
};

/** Delivers events to matching hooks. Delivery is best effort and never blocks a request. */
export class WebhookDispatcher {
  private readonly deliveries: WebhookDelivery[] = [];
  private readonly attempts: number;
  private readonly retryDelayMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: WebhookDispatcherOptions) {
    this.attempts = Math.max(1, options.attempts ?? 3);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 500);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Recent deliveries, newest first, bounded. */
  list(limit = 50): WebhookDelivery[] {
    return this.deliveries.slice(0, Math.max(0, Math.min(limit, 200)));
  }

  async deliver(event: WebhookEvent, payload: unknown): Promise<WebhookDelivery[]> {
    const hooks = (await this.options.store.list()).filter((hook) => hook.enabled && hook.events.includes(event));
    const results: WebhookDelivery[] = [];
    for (const hook of hooks) {
      const allowed = webhookDestinationAllowed(hook.url, this.options.allowLocal === true);
      if (!allowed.allowed) {
        results.push(this.record({ webhookId: hook.id, event, status: 'dropped', attempts: 1, detail: allowed.reason }));
        continue;
      }
      const body = JSON.stringify({ event, sentAt: new Date().toISOString(), data: payload });
      let attempts = 0;
      let detail: string | undefined;
      let delivered = false;
      while (attempts < this.attempts && !delivered) {
        attempts += 1;
        const timestamp = String(Math.floor(Date.now() / 1000));
        try {
          const response = await this.fetchImpl(hook.url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-omnihilbras-event': event,
              'x-omnihilbras-timestamp': timestamp,
              'x-omnihilbras-signature': `sha256=${webhookSignature(hook.secret, timestamp, body)}`,
            },
            body,
            signal: AbortSignal.timeout(8_000),
          });
          if (response.ok) { delivered = true; break; }
          detail = `HTTP ${response.status}`;
        } catch (error) {
          detail = error instanceof Error ? error.message : 'request failed';
        }
        if (attempts < this.attempts) await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * attempts));
      }
      results.push(this.record({ webhookId: hook.id, event, status: delivered ? 'delivered' : 'failed', attempts, ...(detail === undefined ? {} : { detail }) }));
    }
    return results;
  }

  private record(input: Omit<WebhookDelivery, 'id' | 'at'>): WebhookDelivery {
    const delivery: WebhookDelivery = { id: `dl_${randomBytes(6).toString('base64url')}`, at: new Date().toISOString(), ...input };
    this.deliveries.unshift(delivery);
    if (this.deliveries.length > (this.options.deadLetterLimit ?? 200)) this.deliveries.length = this.options.deadLetterLimit ?? 200;
    return delivery;
  }
}
