/**
 * OTLP/HTTP JSON export, written by hand so the published CLI keeps its dependency-free bundle.
 *
 * The OpenTelemetry GenAI conventions are still Development status (no release to pin), so this
 * emits a documented subset under `gen_ai.*` and keeps everything the gateway itself knows under
 * `omnihilbras.*`. **Prompts, messages and tool arguments are never attributes** — a trace that
 * carries a conversation is a privacy liability and is not needed to answer "where did the time and
 * the money go". `OMNIHILBRAS_OTEL_CONTENT=1` opts in, and the test asserts the default.
 *
 * The exporter fails open: a collector that is down drops spans and increments a counter. A gateway
 * request must never wait on telemetry.
 */

export type OtelSpanAttribute = string | number | boolean;

export type OtelSpan = {
  name: string;
  traceId: string;
  startMs: number;
  endMs: number;
  attributes: Record<string, OtelSpanAttribute>;
};

export type OtelConfig = {
  endpoint: string;
  headers?: Record<string, string>;
  serviceName?: string;
  sampleRate?: number;
};

export function otelConfigFromEnv(env: Readonly<Record<string, string | undefined>>): OtelConfig | undefined {
  const endpoint = env.OMNIHILBRAS_OTEL_ENDPOINT?.trim();
  if (!endpoint) return undefined;
  let headers: Record<string, string> | undefined;
  if (env.OMNIHILBRAS_OTEL_HEADERS) {
    try {
      const parsed = JSON.parse(env.OMNIHILBRAS_OTEL_HEADERS) as unknown;
      if (parsed && typeof parsed === 'object') headers = Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    } catch {
      // A malformed header bag must not stop the gateway; the collector will answer 401 and the
      // drop counter says so.
    }
  }
  const rate = Number(env.OMNIHILBRAS_OTEL_SAMPLE_RATE ?? '1');
  return {
    endpoint,
    ...(headers ? { headers } : {}),
    serviceName: env.OMNIHILBRAS_OTEL_SERVICE_NAME?.trim() || 'omnihilbras',
    sampleRate: Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : 1,
  };
}

function attributeValue(value: OtelSpanAttribute) {
  if (typeof value === 'number') return { intValue: String(Math.round(value)) };
  if (typeof value === 'boolean') return { boolValue: value };
  return { stringValue: value };
}

export class OtelExporter {
  private readonly queue: OtelSpan[] = [];
  private timer?: NodeJS.Timeout;
  private flushing?: Promise<void>;
  /** Spans dropped because the queue was full or the collector failed. Reported, never hidden. */
  dropped = 0;
  private readonly maxQueue = 512;

  constructor(private readonly config: OtelConfig) {}

  /** Records one span, sampling it and scheduling a flush. Never throws. */
  record(span: OtelSpan): void {
    const rate = this.config.sampleRate ?? 1;
    if (rate <= 0) return;
    if (rate < 1 && Math.random() > rate) return;
    if (this.queue.length >= this.maxQueue) { this.dropped += 1; return; }
    this.queue.push(span);
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 2_000);
    this.timer.unref?.();
  }

  /** Posts everything queued. Errors are counted rather than thrown. */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.flushing) { await this.flushing; return; }
    if (this.queue.length === 0) return;
    const spans = this.queue.splice(0, this.queue.length);
    const body = JSON.stringify({
      resourceSpans: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: this.config.serviceName ?? 'omnihilbras' } },
            { key: 'telemetry.sdk.name', value: { stringValue: 'omnihilbras-otlp-json' } },
          ],
        },
        scopeSpans: [{
          scope: { name: 'omnihilbras.gateway' },
          spans: spans.map((span) => ({
            traceId: span.traceId.padEnd(32, '0').slice(0, 32),
            spanId: traceIdToSpanId(span.traceId),
            name: span.name,
            kind: 2,
            startTimeUnixNano: String(span.startMs * 1_000_000),
            endTimeUnixNano: String(span.endMs * 1_000_000),
            attributes: Object.entries(span.attributes).map(([key, value]) => ({ key, value: attributeValue(value) })),
          })),
        }],
      }],
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    timeout.unref?.();
    this.flushing = fetch(this.config.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.config.headers ?? {}) },
      body,
      signal: controller.signal,
    }).then((response) => {
      if (!response.ok) this.dropped += spans.length;
    }).catch(() => {
      this.dropped += spans.length;
    }).finally(() => {
      clearTimeout(timeout);
      this.flushing = undefined;
    });
    await this.flushing;
  }
}

/** A trace id is 32 hex characters; the span id is derived from it so one request is one trace. */
function traceIdToSpanId(traceId: string): string {
  const cleaned = traceId.replace(/[^a-f0-9]/gi, '').toLowerCase();
  return (cleaned.slice(0, 16) || '0'.repeat(16)).padEnd(16, '0');
}

/** The one mapping from a usage record to a span. Counts and identifiers only. */
export function spanFromUsage(record: {
  requestId?: string;
  providerId?: string;
  model: string;
  outcome: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  attempts: number;
  apiKeyId?: string;
  workspaceId?: string;
  at: string;
}): OtelSpan | undefined {
  if (!record.requestId) return undefined;
  const end = Date.parse(record.at);
  const start = Number.isNaN(end) ? Date.now() : end - Math.max(0, record.latencyMs);
  return {
    name: 'gen_ai.chat',
    traceId: record.requestId,
    startMs: start,
    endMs: Number.isNaN(end) ? Date.now() : end,
    attributes: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': record.model,
      ...(record.providerId === undefined ? {} : { 'gen_ai.provider.name': record.providerId }),
      'omnihilbras.outcome': record.outcome,
      'omnihilbras.attempts': record.attempts,
      ...(record.inputTokens === undefined ? {} : { 'gen_ai.usage.input_tokens': record.inputTokens }),
      ...(record.outputTokens === undefined ? {} : { 'gen_ai.usage.output_tokens': record.outputTokens }),
      ...(record.cacheReadTokens === undefined ? {} : { 'gen_ai.usage.cache_read.input_tokens': record.cacheReadTokens }),
      ...(record.cacheWriteTokens === undefined ? {} : { 'gen_ai.usage.cache_creation.input_tokens': record.cacheWriteTokens }),
      ...(record.apiKeyId === undefined ? {} : { 'omnihilbras.api_key.id': record.apiKeyId }),
      ...(record.workspaceId === undefined ? {} : { 'omnihilbras.workspace.id': record.workspaceId }),
    },
  };
}
