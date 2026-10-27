"use client";

// Per-provider usage tab on the provider detail page.
//
// Shows router-observed traffic for this provider, broken down per
// connection, with a period selector and a per-model table. The data comes
// from the global usage store (usageHistory / usageDaily), filtered to this
// provider, so it works for every provider — even ones whose upstream exposes
// no usage API.

import { useState, useEffect, useCallback } from "react";
import PropTypes from "prop-types";
import { Card, CardSkeleton } from "@/shared/components";

const PERIODS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
];

function formatTokens(n) {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatCost(n) {
  if (!n) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export default function ProviderUsageTab({ providerId, providerStorageAlias, connections, providerNode }) {
  // The stats API keys byProvider by the raw storage alias, and resolves
  // byModel/byAccount `provider` to the node name when a compatible node has
  // one — otherwise back to the alias. Match on both so either path resolves.
  const providerKeys = new Set([providerStorageAlias]);
  if (providerNode?.name) providerKeys.add(providerNode.name);

  const [period, setPeriod] = useState("7d");
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/usage/stats?period=${encodeURIComponent(period)}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`Failed to load usage (HTTP ${res.status})`);
      const data = await res.json();
      setStats(data);
    } catch (err) {
      setError(err.message || "Failed to load usage");
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    load();
  }, [load]);

  // Filter the global stats to this provider. The stats API keys byProvider by
  // node name / storage alias; byModel and byAccount carry the resolved
  // display name in `provider`.
  const byProvider = providerKeys.size > 0
    ? Object.entries(stats?.byProvider || {})
      .filter(([key]) => providerKeys.has(key))
      .map(([, v]) => v)
      .reduce((acc, v) => {
        acc.requests += v.requests || 0;
        acc.promptTokens += v.promptTokens || 0;
        acc.completionTokens += v.completionTokens || 0;
        acc.cost += v.cost || 0;
        return acc;
      }, { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 })
    : null;
  const hasByProvider = providerKeys.size > 0 && Object.keys(stats?.byProvider || {}).some((k) => providerKeys.has(k));
  const providerModels = Object.entries(stats?.byModel || {})
    .filter(([, m]) => providerKeys.has(m.provider))
    .map(([key, m]) => ({ key, ...m }))
    .sort((a, b) => (b.promptTokens + b.completionTokens) - (a.promptTokens + a.completionTokens));
  const providerAccounts = Object.entries(stats?.byAccount || {})
    .filter(([, a]) => providerKeys.has(a.provider))
    .map(([key, a]) => ({ key, ...a }))
    .sort((a, b) => (b.promptTokens + b.completionTokens) - (a.promptTokens + a.completionTokens));

  // Match accounts to the current connection list so we can show connection names.
  const connById = Object.fromEntries((connections || []).map((c) => [c.id, c]));
  const totalTokens = byProvider ? byProvider.promptTokens + byProvider.completionTokens : 0;

  // Ollama Local has no upstream usage API; surface a clear message instead of
  // an empty "No usage recorded" card.
  if (providerId === "ollama-local") {
    return (
      <div className="flex flex-col gap-6">
        <Card>
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <span className="material-symbols-outlined text-[24px] text-muted" aria-hidden="true">
              monitoring
            </span>
            <p className="text-sm font-medium">Local instance — usage not tracked</p>
            <p className="text-xs text-text-muted">Ollama Local does not expose a usage API. Requests routed through this provider still appear in router logs.</p>
          </div>
        </Card>
      </div>
    );
  }

  if (loading) {
    return <CardSkeleton />;
  }

  if (error) {
    return (
      <Card>
        <p className="text-sm text-red-500">{error}</p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Period selector */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-text-muted">Period</span>
        <div className="flex flex-wrap gap-1">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => setPeriod(p.value)}
              className={
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors " +
                (period === p.value
                  ? "bg-gold-soft text-gold-text"
                  : "text-text-muted hover:bg-surface-2 hover:text-text-main")
              }
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Provider totals */}
      {!hasByProvider ? (
        <Card>
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <span className="material-symbols-outlined text-[24px] text-muted" aria-hidden="true">
              monitoring
            </span>
            <p className="text-sm font-medium">No usage recorded for this provider in this period</p>
            <p className="text-xs text-text-muted">Requests routed through this provider will appear here.</p>
          </div>
        </Card>
      ) : (
        <>
          <section aria-label="Provider usage totals" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <div className="rounded-xl border border-line bg-bg-soft/70 p-3.5">
              <p className="text-[10px] uppercase tracking-[0.1em] text-text-muted">Requests</p>
              <p className="mt-1 font-mono text-lg font-semibold">{byProvider.requests ?? 0}</p>
            </div>
            <div className="rounded-xl border border-line bg-bg-soft/70 p-3.5">
              <p className="text-[10px] uppercase tracking-[0.1em] text-text-muted">Tokens</p>
              <p className="mt-1 font-mono text-lg font-semibold">{formatTokens(totalTokens)}</p>
            </div>
            <div className="rounded-xl border border-line bg-bg-soft/70 p-3.5">
              <p className="text-[10px] uppercase tracking-[0.1em] text-text-muted">Input / Output</p>
              <p className="mt-1 font-mono text-sm">
                <span className="text-primary">{formatTokens(byProvider.promptTokens)}</span>
                <span className="text-text-muted"> / </span>
                <span className="text-success">{formatTokens(byProvider.completionTokens)}</span>
              </p>
            </div>
            <div className="rounded-xl border border-line bg-bg-soft/70 p-3.5">
              <p className="text-[10px] uppercase tracking-[0.1em] text-text-muted">Cost</p>
              <p className="mt-1 font-mono text-lg font-semibold">{formatCost(byProvider.cost)}</p>
            </div>
          </section>

          {/* Per-connection breakdown */}
          {providerAccounts.length > 0 && (
            <Card>
              <h3 className="mb-3 text-sm font-semibold">Per connection</h3>
              <div className="flex flex-col divide-y divide-border/50">
                {providerAccounts.map((acct) => {
                  const conn = connById[acct.connectionId];
                  const connLabel = conn?.name || conn?.email || acct.accountName || acct.connectionId;
                  const tokens = acct.promptTokens + acct.completionTokens;
                  return (
                    <div key={acct.key} className="flex items-center justify-between gap-3 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{connLabel}</p>
                        <p className="text-xs text-text-muted">
                          {acct.rawModel ? `${acct.rawModel} · ` : ""}
                          {new Date(acct.lastUsed).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="shrink-0 text-right font-mono text-xs">
                        <div>{acct.requests} req · {formatTokens(tokens)} tok</div>
                        <div className="text-text-muted">{formatCost(acct.cost)}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {/* Per-model breakdown */}
          {providerModels.length > 0 && (
            <Card>
              <h3 className="mb-3 text-sm font-semibold">Per model</h3>
              <div className="flex flex-col divide-y divide-border/50">
                {providerModels.map((m) => {
                  const tokens = m.promptTokens + m.completionTokens;
                  return (
                    <div key={m.key} className="flex items-center justify-between gap-3 py-2">
                      <div className="min-w-0">
                        <p className="truncate font-mono text-sm">{m.rawModel}</p>
                        <p className="text-xs text-text-muted">Last used {new Date(m.lastUsed).toLocaleDateString()}</p>
                      </div>
                      <div className="shrink-0 text-right font-mono text-xs">
                        <div>{m.requests} req · {formatTokens(tokens)} tok</div>
                        <div className="text-text-muted">{formatCost(m.cost)}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

ProviderUsageTab.propTypes = {
  providerId: PropTypes.string.isRequired,
  providerStorageAlias: PropTypes.string.isRequired,
  connections: PropTypes.array,
  providerNode: PropTypes.object,
};
