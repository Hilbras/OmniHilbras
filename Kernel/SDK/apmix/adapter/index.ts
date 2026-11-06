import { ProviderError } from '../lib/errors.js';
import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '../lib/openai-compatible.js';
import { FetchHttpTransport, type HttpTransport } from '../lib/transport.js';
import type { ProviderQuota, ProviderRequestContext, ProviderResourceQuota } from '../lib/types.js';

export const apmixProviderId = 'apmix';

/**
 * The usage report, in both shapes this gateway family has been seen to answer.
 *
 * **The allowance shape** (dumped raw from the live apmix account, 2026-11): a structured pool —
 * `plan`, `allowance`, `used`, `remaining`, optional daily and weekly limits, and a `resets_at`.
 * **The balance shape** (the reference's BeatAPI measurement, the same gateway family): a USD credit
 * balance with no ceiling — `credit_balance` and its aliases — beside an optional concurrency cap.
 * A balance is not a quota: it renders as a wallet row with no bar, figures as stated.
 */
type ApmixUsageResponse = {
  plan?: unknown;
  allowance?: unknown;
  used?: unknown;
  remaining?: unknown;
  resets_at?: unknown;
  limits?: { daily?: unknown; daily_used?: unknown; weekly?: unknown; weekly_used?: unknown } | null;
  credit_balance?: unknown;
  balance_usd?: unknown;
  balance?: unknown;
  remaining_balance?: unknown;
  concurrency?: { limit?: unknown; active?: unknown } | null;
};

function finiteNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

function resetTime(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  return undefined;
}

function row(used: unknown, total: unknown, remaining: unknown, resetsAt: unknown): ProviderResourceQuota {
  const limit = Math.max(0, Math.round(finiteNumber(total, 0)));
  const spent = Math.max(0, Math.round(finiteNumber(used, 0)));
  // The provider's own remaining wins when it is present; falling back to `limit - used` keeps a
  // response that omits the field from reading as an exhausted one.
  const left = remaining == null ? Math.max(0, limit - spent) : Math.max(0, Math.round(finiteNumber(remaining, 0)));
  const resets = resetTime(resetsAt);
  return { used: spent, limit, remaining: left, ...(resets ? { resetsAt: resets } : {}) };
}

function parseUsage(data: ApmixUsageResponse): ProviderQuota {
  const resources: Record<string, ProviderResourceQuota> = {};
  const plan = typeof data.plan === 'string' && data.plan ? data.plan : 'APMix';

  // The allowance pool. A zero allowance with zero used is the free plan's honest state: the row
  // states the figures, and a zero limit draws no bar rather than an invented one.
  if (data.allowance !== undefined || data.remaining !== undefined || data.used !== undefined) {
    resources['Allowance'] = row(data.used, data.allowance, data.remaining, data.resets_at);
  }
  const limits = data.limits ?? {};
  if (finiteNumber(limits.daily, 0) > 0) {
    resources['Daily limit'] = row(limits.daily_used, limits.daily, undefined, data.resets_at);
  }
  if (finiteNumber(limits.weekly, 0) > 0) {
    resources['Weekly limit'] = row(limits.weekly_used, limits.weekly, undefined, data.resets_at);
  }

  // The balance wallet. No ceiling to compare against: the balance is both limit and remaining, and
  // the reference flagged it as a wallet rather than a quota for exactly that reason.
  for (const alias of ['credit_balance', 'balance_usd', 'balance', 'remaining_balance'] as const) {
    const balance = finiteNumber(data[alias], Number.NaN);
    if (Number.isFinite(balance)) {
      resources['Credit balance'] = { used: 0, limit: Math.round(balance * 100) / 100, remaining: Math.round(balance * 100) / 100 };
      break;
    }
  }
  const concurrency = data.concurrency;
  if (concurrency && finiteNumber(concurrency.limit, 0) > 0) {
    resources['Concurrent tasks'] = row(concurrency.active, concurrency.limit, undefined, undefined);
  }
  return { plan, resources };
}

export type ApmixAdapterOptions = OpenAICompatibleAdapterOptions & {
  baseUrl?: string;
};

export class ApmixAdapter extends OpenAICompatibleAdapter {
  private readonly usageUrl: string;
  // A copy of the transport, because the base class's is private: the same instance the gateway or
  // the test injected, used for the one read the generic base does not make.
  private readonly quotaTransport: HttpTransport;

  constructor(options: ApmixAdapterOptions = {}) {
    const baseUrl = options.baseUrl ?? 'https://api.apmix.ai/v1';
    super({
      id: 'apmix',
      name: 'apmix',
      baseUrl,
      auth: { header: 'Authorization', prefix: 'Bearer' },
    }, options);
    this.quotaTransport = options.transport ?? new FetchHttpTransport();
    this.usageUrl = `${baseUrl.replace(/\/$/, '')}/usage`;
  }

  /**
   * apmix's allowance for the saved key, read from `/usage`. Account metadata, not an inference
   * request: it spends no allowance.
   */
  async quota(context: ProviderRequestContext = {}): Promise<ProviderQuota> {
    const credential = context.credential;
    if (!credential || !('value' in credential) || typeof credential.value !== 'string' || !credential.value) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'Connect apmix to read its usage.', { providerId: apmixProviderId });
    }
    const { data } = await this.quotaTransport.request<ApmixUsageResponse>({
      method: 'GET',
      providerId: apmixProviderId,
      url: this.usageUrl,
      headers: { accept: 'application/json', Authorization: `Bearer ${credential.value}` },
      ...(context.signal ? { signal: context.signal } : {}),
    });
    return parseUsage(data ?? {});
  }
}

export * from '../lib/openai-compatible.js';
