"use client";

import { useEffect, useState } from "react";
import Card from "@/shared/components/Card";
import Badge from "@/shared/components/Badge";
import { cn } from "@/shared/utils/cn";

// What the client-facing limits have been doing.
//
// A request that is turned away leaves no usage row — it never reached a
// provider — so before this card the only trace of a rejection was a line in
// the server log. Here the operator sees which key spent what in the last
// minute, what it was allowed, and how often it was refused.

const REFRESH_MS = 10_000;

// The dimension a rejection came from, in the words the client sees.
const DIMENSION_LABELS = {
  requests: "too many requests",
  tokens: "too many tokens",
  concurrency: "too many concurrent requests",
  fanout: "too many upstream calls",
  error: "limiter error (the request was let through)",
};

function formatNumber(value) {
  const n = Number(value) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

function identityLabel(identity) {
  if (identity.keyName) return identity.keyName;
  if (identity.keyId) return `key ${String(identity.keyId).slice(0, 8)}`;
  // An IP bucket, or a key the gateway does not know.
  return identity.scope?.startsWith("ip:") ? identity.scope.slice(3) : identity.scope;
}

// How full the ceiling is, as a percentage (null when there is no ceiling).
function usagePercent(used, limit) {
  if (!(limit > 0)) return null;
  return Math.min(100, Math.round((used / limit) * 100));
}

function UsageBar({ used, limit }) {
  const percent = usagePercent(used, limit);
  if (percent === null) {
    return <span className="text-xs text-text-muted">no limit</span>;
  }
  const tone =
    percent >= 90 ? "bg-red-500" : percent >= 70 ? "bg-yellow-500" : "bg-green-500";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
      <div className={cn("h-full transition-all duration-300", tone)} style={{ width: `${percent}%` }} />
    </div>
  );
}

export default function RateLimitStatusCard({ refreshMs = REFRESH_MS }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      // Pause the poll while the tab is hidden: the counters are for whoever
      // is looking at the card, and a background tab must not keep hitting
      // the API every 10 s.
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const res = await fetch("/api/usage/rate-limit", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (cancelled) return;
        setData(json);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e?.message || "Failed to load");
      }
    };

    load();
    const timer = setInterval(load, refreshMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refreshMs]);

  const defaults = data?.defaults;
  const identities = data?.identities || [];
  const inFlight = data?.inFlight?.total ?? 0;

  return (
    <Card
      title="Client limits"
      subtitle="What the API keys and peers spent in the last minute"
      icon="speed"
      padding="md"
      action={
        data && !data.enabled ? (
          <Badge variant="warning" size="sm">disabled</Badge>
        ) : null
      }
    >
      {error ? (
        <p className="text-sm text-red-500">Could not load the limit status: {error}</p>
      ) : !data ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : (
        <div className="flex flex-col gap-4">
          {defaults && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
              <span>{defaults.requestsPerMinute > 0 ? `${defaults.requestsPerMinute} req/min` : "no request limit"}</span>
              <span>{defaults.tokensPerMinute > 0 ? `${formatNumber(defaults.tokensPerMinute)} tokens/min` : "no token limit"}</span>
              <span>{defaults.concurrency?.perKey > 0 ? `${defaults.concurrency.perKey} concurrent per key` : "no per-key concurrency cap"}</span>
              <span>{defaults.concurrency?.global > 0 ? `${defaults.concurrency.global} concurrent overall` : "no global concurrency cap"}</span>
              <span>{inFlight} in flight</span>
            </div>
          )}

          {identities.length === 0 ? (
            <p className="text-sm text-text-muted">
              No client traffic yet. The counters fill up as keys and peers call the API.
            </p>
          ) : (
            <div className="flex flex-col divide-y divide-border-subtle">
              {identities.map((identity) => {
                const rejections = identity.rejections || {};
                const rejectedTotal = Object.values(rejections).reduce((sum, n) => sum + (Number(n) || 0), 0);
                const requestLimit = identity.limits?.requestsPerMinute;
                const tokenLimit = identity.limits?.tokensPerMinute;

                return (
                  <div key={identity.scope} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-sm font-medium text-text-main">
                        {identityLabel(identity)}
                      </span>
                      <span className="shrink-0 text-xs text-text-muted">
                        {identity.requestsPerMinute} req/min
                        {requestLimit > 0 ? ` / ${requestLimit}` : ""}
                        {" · "}
                        {formatNumber(identity.tokensPerMinute)} tok/min
                        {tokenLimit > 0 ? ` / ${formatNumber(tokenLimit)}` : ""}
                      </span>
                    </div>

                    <UsageBar used={identity.requestsPerMinute} limit={requestLimit} />

                    {rejectedTotal > 0 && (
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="error" size="sm">
                          {rejectedTotal} refused
                        </Badge>
                        {Object.entries(rejections)
                          .filter(([, count]) => Number(count) > 0)
                          .map(([dimension, count]) => (
                            <span key={dimension} className="text-xs text-text-muted">
                              {count}× {DIMENSION_LABELS[dimension] || dimension}
                            </span>
                          ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
