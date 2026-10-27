"use client";

import { useState, useEffect } from "react";
import Card from "@/shared/components/Card";
import SegmentedControl from "@/shared/components/SegmentedControl";
import { cn } from "@/shared/utils/cn";

const PERIODS = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "all", label: "All" },
];

function formatRate(n) {
  if (n >= 100) return Math.round(n).toLocaleString();
  return n.toFixed(n >= 10 ? 1 : 2);
}

function StatTile({ label, value, hint, danger }) {
  return (
    <Card padding="sm">
      <p className="text-xs uppercase tracking-wide text-text-muted">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold font-mono", danger ? "text-red-600" : "text-text-main")}>{value}</p>
      {hint && <p className="mt-1 text-xs text-text-muted">{hint}</p>}
    </Card>
  );
}

function Breakdown({ title, rows }) {
  const max = Math.max(1, ...rows.map((r) => r.requests));
  return (
    <Card padding="md" title={title}>
      {rows.length === 0 ? (
        <p className="text-sm text-text-muted">No data in this period.</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.key} className="text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate font-mono text-text-main" title={r.key}>{r.key}</span>
                <span className="shrink-0 font-mono text-text-muted">
                  {r.requests.toLocaleString()} req
                  {r.errors > 0 && <span className="text-red-600"> · {r.errors} err</span>}
                  {" · "}{r.avgLatency}ms
                </span>
              </div>
              <div className="mt-1 h-2 rounded-full bg-surface-2 overflow-hidden flex">
                <div className="h-full bg-brand-500" style={{ width: `${((r.requests - r.errors) / max) * 100}%` }} />
                <div className="h-full bg-red-500" style={{ width: `${(r.errors / max) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default function MetricsTab() {
  const [period, setPeriod] = useState("24h");
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    fetch(`/api/observability/stats?period=${period}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (alive) setStats(data);
      })
      .catch((err) => alive && setError(err.message));
    return () => { alive = false; };
  }, [period]);

  return (
    <div className="flex flex-col gap-6">
      <SegmentedControl options={PERIODS} value={period} onChange={setPeriod} size="sm" className="self-start" />

      {error && <Card padding="md"><p className="text-sm text-red-500">Failed to load metrics: {error}</p></Card>}

      {stats && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Requests" value={stats.requests.toLocaleString()} hint={`${formatRate(stats.requestsPerMinute)} / min`} />
            <StatTile label="Tokens" value={(stats.promptTokens + stats.completionTokens).toLocaleString()} hint={`${formatRate(stats.tokensPerMinute)} / min`} />
            <StatTile
              label="Error rate"
              value={`${(stats.errorRate * 100).toFixed(1)}%`}
              hint={`${stats.errors.toLocaleString()} errors`}
              danger={stats.errorRate > 0.05}
            />
            <StatTile label="Avg latency" value={`${stats.avgLatency.toLocaleString()}ms`} />
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Breakdown title="By provider" rows={stats.byProvider} />
            <Breakdown title="By model" rows={stats.byModel} />
          </div>

          <Card padding="md" title="Retention">
            <p className="text-sm text-text-main">
              {stats.retention.records.toLocaleString()} of {stats.retention.maxRecords.toLocaleString()} records retained
              {stats.retention.oldest && <> · oldest {new Date(stats.retention.oldest).toLocaleString()}</>}
            </p>
            <div className="mt-2 h-2 rounded-full bg-surface-2 overflow-hidden">
              <div
                className="h-full bg-brand-500"
                style={{ width: `${Math.min(100, (stats.retention.records / stats.retention.maxRecords) * 100)}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-text-muted">
              Metrics cover the retained log only. {stats.retention.enabled ? "Recording is on." : "Recording is off — enable it in Settings."}
            </p>
          </Card>
        </>
      )}
    </div>
  );
}
