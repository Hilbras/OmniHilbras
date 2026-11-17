import type { UsageRecord } from './usage-store.js';

/**
 * The gateway, in the shape Prometheus scrapes.
 *
 * Nothing here is invented: every number comes from the usage records the gateway already writes, which is what makes
 * this cheap and what makes it honest. A metrics endpoint that counted its own idea of a request would disagree with
 * `/v1/usage` the first time either changed, and an operator would have to decide which one to believe.
 *
 * The choice of series is deliberate:
 *
 * - **counters, not averages**, for outcomes — an average of a categorical is not a number;
 * - **`_sum` and `_count`** for latency rather than quantiles computed here. A gateway that renders its own `p95` from
 *   a store it re-reads on every scrape produces a quantile that is not rateable and cannot be aggregated across
 *   instances; Prometheus computes those from the sum and the count.
 * - **`provider="unattributed"`** for a record no provider served, which is a real state here — a client that
 *   disconnects during startup produces one — rather than a series that silently disappears.
 *
 * A record without a provider is not a record without a cause, so it is counted rather than dropped.
 */

const escapeLabel = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

type ProviderTotals = {
  outcomes: Record<string, number>;
  attempts: number;
  latencySum: number;
  latencyCount: number;
  inputTokens: number;
  outputTokens: number;
};

function emptyTotals(): ProviderTotals {
  return { outcomes: {}, attempts: 0, latencySum: 0, latencyCount: 0, inputTokens: 0, outputTokens: 0 };
}

export type MetricsInput = {
  records: readonly UsageRecord[];
  version: string;
  /** Epoch milliseconds, so a test can render a deterministic document. */
  now?: number;
};

export function renderPrometheusMetrics({ records, version, now = Date.now() }: MetricsInput): string {
  void now;
  const byProvider = new Map<string, ProviderTotals>();
  for (const record of records) {
    const provider = record.providerId ?? 'unattributed';
    const totals = byProvider.get(provider) ?? emptyTotals();
    totals.outcomes[record.outcome] = (totals.outcomes[record.outcome] ?? 0) + 1;
    totals.attempts += record.attempts;
    if (Number.isFinite(record.latencyMs)) {
      totals.latencySum += record.latencyMs;
      totals.latencyCount += 1;
    }
    if (typeof record.inputTokens === 'number') totals.inputTokens += record.inputTokens;
    if (typeof record.outputTokens === 'number') totals.outputTokens += record.outputTokens;
    byProvider.set(provider, totals);
  }

  const lines: string[] = [];
  const help = (name: string, type: 'counter' | 'gauge', text: string) => {
    lines.push(`# HELP ${name} ${text}`);
    lines.push(`# TYPE ${name} ${type}`);
  };

  help('omnihilbras_up', 'gauge', '1 when the gateway is answering, 0 otherwise. A scrape that returns nothing is not this.');
  lines.push('omnihilbras_up 1');

  help('omnihilbras_build_info', 'gauge', 'Always 1; the version is the label.');
  lines.push(`omnihilbras_build_info{version="${escapeLabel(version)}"} 1`);

  help('omnihilbras_requests_total', 'counter', 'Finished requests by provider and outcome, from the usage store.');
  const providers = [...byProvider.keys()].sort();
  for (const provider of providers) {
    const totals = byProvider.get(provider)!;
    for (const outcome of Object.keys(totals.outcomes).sort()) {
      lines.push(`omnihilbras_requests_total{provider="${escapeLabel(provider)}",outcome="${escapeLabel(outcome)}"} ${totals.outcomes[outcome]}`);
    }
  }

  help('omnihilbras_usage_unreported_total', 'counter', 'Answers whose provider reported no token usage, by provider. The page shows a labelled estimate for these.');
  const unreported = new Map<string, number>();
  for (const record of records) {
    if (record.inputTokens !== undefined || record.outputTokens !== undefined) continue;
    const provider = record.providerId ?? 'unattributed';
    unreported.set(provider, (unreported.get(provider) ?? 0) + 1);
  }
  for (const provider of [...unreported.keys()].sort()) {
    lines.push(`omnihilbras_usage_unreported_total{provider="${escapeLabel(provider)}"} ${unreported.get(provider)}`);
  }

  help('omnihilbras_attempts_total', 'counter', 'Provider attempts, including the ones a failover abandoned. One request may be several attempts.');
  for (const provider of providers) lines.push(`omnihilbras_attempts_total{provider="${escapeLabel(provider)}"} ${byProvider.get(provider)!.attempts}`);

  help('omnihilbras_request_duration_ms_sum', 'counter', 'Sum of request latency in milliseconds. Divide by _count for the mean; give both to Prometheus for a rateable quantile.');
  for (const provider of providers) lines.push(`omnihilbras_request_duration_ms_sum{provider="${escapeLabel(provider)}"} ${byProvider.get(provider)!.latencySum}`);

  help('omnihilbras_request_duration_ms_count', 'counter', 'How many requests contributed to the duration sum.');
  for (const provider of providers) lines.push(`omnihilbras_request_duration_ms_count{provider="${escapeLabel(provider)}"} ${byProvider.get(provider)!.latencyCount}`);

  help('omnihilbras_tokens_total', 'counter', 'Tokens the providers reported. Absent for a provider that does not meter, rather than zero.');
  for (const provider of providers) {
    const totals = byProvider.get(provider)!;
    if (totals.inputTokens > 0) lines.push(`omnihilbras_tokens_total{provider="${escapeLabel(provider)}",kind="input"} ${totals.inputTokens}`);
    if (totals.outputTokens > 0) lines.push(`omnihilbras_tokens_total{provider="${escapeLabel(provider)}",kind="output"} ${totals.outputTokens}`);
  }

  // A trailing newline is part of the format, not decoration: a scraper reads the body line by line.
  return `${lines.join('\n')}\n`;
}
