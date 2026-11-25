import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';
import { ProviderError } from '@omnihilbras/sdk-shared/errors';
import type {
  CredentialValidation,
  ProviderCredential,
  ProviderQuota,
  ProviderRequestContext,
  ProviderResourceQuota,
} from '../lib/types.js';

/** Vengetic's own adapter. Its base URL and id live here, not in a dashboard card. */
export const vengeticProviderId = "vengetic";

/**
 * The docs publish the `GET /v1/usage` call but not its JSON shape. Only fields this code can interpret
 * are reported; an unrecognized shape is a typed refusal, never a guessed quota or a confident zero.
 */
const RESOURCE_LABELS: ReadonlyArray<readonly [string, RegExp]> = [
  ['Requests / minute', /(^|[_-])rpm$|requests?_?per_?minute/i],
  ['Tokens / minute', /(^|[_-])tpm$|tokens?_?per_?minute/i],
  ['Requests / day', /(^|[_-])rpd$|requests?_?per_?day/i],
  ['Concurrency', /concurr/i],
];

function resourceFrom(value: unknown, resetsAt: unknown): ProviderResourceQuota | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const numeric = (key: string) => {
    const raw = row[key];
    if (typeof raw !== 'number' && typeof raw !== 'string') return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  const limit = numeric('limit') ?? numeric('max') ?? numeric('quota');
  const used = numeric('used');
  const remaining = numeric('remaining') ?? numeric('left');
  if (limit === undefined || (used === undefined && remaining === undefined)) return undefined;
  const resolvedUsed = used ?? Math.max(0, limit - (remaining as number));
  const resolvedRemaining = remaining ?? Math.max(0, limit - resolvedUsed);
  const reset = typeof resetsAt === 'string' && resetsAt && !Number.isNaN(Date.parse(resetsAt))
    ? new Date(resetsAt).toISOString()
    : undefined;
  return { used: resolvedUsed, limit, remaining: resolvedRemaining, ...(reset ? { resetsAt: reset } : {}) };
}

export class VengeticAdapter extends OpenAICompatibleAdapter {
  constructor(options: OpenAICompatibleAdapterOptions = {}) {
    super({
      id: "vengetic",
      name: "Vengetic",
      baseUrl: "https://api.vengetic.biz.id/v1",
      auth: { header: 'Authorization', prefix: 'Bearer' },
    }, options);
  }

  /**
   * Vengetic's `/v1/models` requires the caller's key — verified: no key and a bogus key both get 401.
   * An authenticated catalog read is therefore a real, non-billable check of a candidate key, so the
   * dashboard's Check button can answer before the connection is saved. This override is deliberately
   * provider-specific: the same shortcut would be dishonest for a provider with a public catalog.
   */
  async validateCredential(credential: ProviderCredential | undefined, context: ProviderRequestContext = {}): Promise<CredentialValidation> {
    const startedAt = performance.now();
    const value = credential && 'value' in credential ? credential.value : undefined;
    if (typeof value !== 'string' || !value) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'Enter a Vengetic API key.', {
        providerId: vengeticProviderId,
        publicMessage: 'Enter a Vengetic API key. Create one at vengetic.biz.id.',
      });
    }
    const models = await this.listModels({ ...context, credential });
    if (!Array.isArray(models) || models.length === 0) {
      throw new ProviderError('PROVIDER_UNAVAILABLE', 'Vengetic returned an empty model catalog.', {
        providerId: vengeticProviderId,
        publicMessage: 'The key was accepted, but Vengetic listed no models. No quota or capability can be claimed.',
      });
    }
    return { status: 'valid', checkedAt: new Date().toISOString(), latencyMs: Math.round(performance.now() - startedAt) };
  }

  /** Real limits from `/v1/usage`, when the key has `usage:read` and the shape is understood. */
  async quota(context: ProviderRequestContext = {}): Promise<ProviderQuota> {
    const credential = context.credential;
    const value = credential && 'value' in credential ? credential.value : undefined;
    if (typeof value !== 'string' || !value) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'Connect Vengetic to read its usage.', {
        providerId: vengeticProviderId,
        publicMessage: 'Connect Vengetic to read its usage.',
      });
    }
    const { data } = await this.transport.request<Record<string, unknown>>({
      method: 'GET',
      providerId: vengeticProviderId,
      url: this.url('/usage'),
      headers: this.requestHeaders(credential, 'application/json'),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const top = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {};
    const nested = [top.usage, top.quota, top.limits].find((part) => part && typeof part === 'object' && !Array.isArray(part));
    const rows = (nested && typeof nested === 'object' ? nested : top) as Record<string, unknown>;
    const resources: Record<string, ProviderResourceQuota> = {};
    for (const [, pattern] of RESOURCE_LABELS) {
      for (const [name, raw] of Object.entries(rows)) {
        if (!pattern.test(name)) continue;
        const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
        const resetsAt = record.resetsAt ?? record.reset_at ?? record.resets_at;
        const label = RESOURCE_LABELS.find(([, re]) => re.test(name))?.[0] ?? name;
        const parsed = resourceFrom(raw, resetsAt);
        if (parsed) resources[label] = parsed;
      }
    }
    if (Object.keys(resources).length === 0) {
      throw new ProviderError('NOT_SUPPORTED', 'Vengetic returned a usage body this gateway cannot interpret.', {
        providerId: vengeticProviderId,
        publicMessage: 'Vengetic did not report recognizable limits. No quota is shown rather than a guessed one.',
      });
    }
    return { plan: typeof top.plan === 'string' ? top.plan : 'Vengetic', resources };
  }
}
