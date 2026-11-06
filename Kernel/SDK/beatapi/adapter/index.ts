import { ProviderError } from '../lib/errors.js';
import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '../lib/openai-compatible.js';
import { FetchHttpTransport, type HttpTransport } from '../lib/transport.js';
import type { ProviderQuota, ProviderRequestContext, ProviderResourceQuota } from '../lib/types.js';

export const beatapiProviderId = 'beatapi';

/**
 * BeatAPI's usage report — the same gateway family as apmix, measured by the reference project at
 * `/v1/usage`: a USD credit balance (it may be negative), an optional concurrency cap, and the
 * structured allowance shape the family has since grown. One parser handles both, alias-driven, so
 * whichever shape a given account answers still lands as rows.
 */
type BeatApiUsageResponse = {
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
  const left = remaining == null ? Math.max(0, limit - spent) : Math.max(0, Math.round(finiteNumber(remaining, 0)));
  const resets = resetTime(resetsAt);
  return { used: spent, limit, remaining: left, ...(resets ? { resetsAt: resets } : {}) };
}

function parseUsage(data: BeatApiUsageResponse): ProviderQuota {
  const resources: Record<string, ProviderResourceQuota> = {};
  const plan = typeof data.plan === 'string' && data.plan ? data.plan : 'BeatAPI';

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

  // The balance wallet: no ceiling to compare against, so the balance is both limit and remaining.
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

export type BeatApiAdapterOptions = OpenAICompatibleAdapterOptions & {
  baseUrl?: string;
};

export class BeatApiAdapter extends OpenAICompatibleAdapter {
  private readonly usageUrl: string;
  // A copy of the transport, because the base class's is private: the same instance the gateway or
  // the test injected, used for the one read the generic base does not make.
  private readonly quotaTransport: HttpTransport;

  constructor(options: BeatApiAdapterOptions = {}) {
    const baseUrl = options.baseUrl ?? 'https://api.beatapi.io/v1';
    super({
      id: 'beatapi',
      name: 'BeatAPI',
      baseUrl,
      auth: { header: 'Authorization', prefix: 'Bearer' },
    }, options);
    this.quotaTransport = options.transport ?? new FetchHttpTransport();
    this.usageUrl = `${baseUrl.replace(/\/$/, '')}/usage`;
  }

  /**
   * BeatAPI's account report, read from `/usage` — the same read the reference project's aggregator
   * parsed. Account metadata, not an inference request: it spends no credits.
   */
  async quota(context: ProviderRequestContext = {}): Promise<ProviderQuota> {
    const credential = context.credential;
    if (!credential || !('value' in credential) || typeof credential.value !== 'string' || !credential.value) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'Connect BeatAPI to read its usage.', { providerId: beatapiProviderId });
    }
    const { data } = await this.quotaTransport.request<BeatApiUsageResponse>({
      method: 'GET',
      providerId: beatapiProviderId,
      url: this.usageUrl,
      headers: { accept: 'application/json', Authorization: `Bearer ${credential.value}` },
      ...(context.signal ? { signal: context.signal } : {}),
    });
    return parseUsage(data ?? {});
  }
}

export * from '../lib/openai-compatible.js';
