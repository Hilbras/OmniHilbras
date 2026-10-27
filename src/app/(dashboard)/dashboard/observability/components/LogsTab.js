"use client";

import { useState, useEffect, useCallback } from "react";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Drawer from "@/shared/components/Drawer";
import Pagination from "@/shared/components/Pagination";
import { ConfirmModal } from "@/shared/components/Modal";
import { cn } from "@/shared/utils/cn";

const EMPTY_FILTERS = { provider: "", model: "", status: "", startDate: "", endDate: "" };

function inputTokens(tokens) {
  return tokens?.prompt_tokens ?? tokens?.input_tokens ?? 0;
}

function outputTokens(tokens) {
  return tokens?.completion_tokens ?? tokens?.output_tokens ?? 0;
}

function FilterSelect({ id, label, value, options, onChange }) {
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <label htmlFor={id} className="text-sm font-medium text-text-main">{label}</label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full py-2 px-3 text-sm text-text-main bg-surface-2 rounded-[10px] focus:outline-none focus:ring-2 focus:ring-brand-500/30"
      >
        <option value="">All</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

function FilterDate({ id, label, value, onChange }) {
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <label htmlFor={id} className="text-sm font-medium text-text-main">{label}</label>
      <input
        id={id}
        type="datetime-local"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full py-2 px-3 text-sm text-text-main bg-surface-2 rounded-[10px] focus:outline-none focus:ring-2 focus:ring-brand-500/30"
      />
    </div>
  );
}

function buildQuery(filters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (!value) continue;
    // datetime-local has no zone; send it as the viewer's local time.
    params.set(key, key.endsWith("Date") ? new Date(value).toISOString() : value);
  }
  return params;
}

export default function LogsTab() {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 25, totalItems: 0 });
  const [details, setDetails] = useState([]);
  const [facets, setFacets] = useState({ providers: [], models: [] });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [checked, setChecked] = useState(new Set());
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const params = buildQuery(filters);
      params.set("page", String(pagination.page));
      params.set("pageSize", String(pagination.pageSize));
      const res = await fetch(`/api/observability/logs?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setDetails(data.details || []);
      setFacets(data.facets || { providers: [], models: [] });
      setPagination((p) => ({ ...p, totalItems: data.pagination?.totalItems || 0 }));
      setChecked(new Set());
    } catch (err) {
      setLoadError(err.message);
      setDetails([]);
    } finally {
      setLoading(false);
    }
  }, [filters, pagination.page, pagination.pageSize]);

  useEffect(() => { load(); }, [load]);

  const setFilter = (key, value) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setPagination((p) => ({ ...p, page: 1 }));
  };

  const toggleChecked = (id) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const allChecked = details.length > 0 && details.every((d) => checked.has(d.id));
  const toggleAll = () => setChecked(allChecked ? new Set() : new Set(details.map((d) => d.id)));

  const runDelete = async () => {
    setBusy(true);
    try {
      const body = confirm === "selected" ? { ids: [...checked] } : { all: true };
      const res = await fetch("/api/observability/logs", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
      setConfirm(null);
      setPagination((p) => ({ ...p, page: 1 }));
      await load();
    } catch (err) {
      setLoadError(err.message);
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  };

  const runExport = async (format) => {
    setBusy(true);
    try {
      const res = await fetch("/api/observability/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format, ...Object.fromEntries(buildQuery(filters)) }),
      });
      if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
      const blob = await res.blob();
      const name = res.headers.get("Content-Disposition")?.match(/filename="(.+)"/)?.[1] || `observability.${format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const hasFilters = Object.values(filters).some(Boolean);

  return (
    <>
      <Card padding="md">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <FilterSelect id="obs-provider" label="Provider" value={filters.provider} options={facets.providers} onChange={(v) => setFilter("provider", v)} />
          <FilterSelect id="obs-model" label="Model" value={filters.model} options={facets.models} onChange={(v) => setFilter("model", v)} />
          <FilterSelect id="obs-status" label="Status" value={filters.status} options={["success", "error"]} onChange={(v) => setFilter("status", v)} />
          <FilterDate id="obs-start" label="From" value={filters.startDate} onChange={(v) => setFilter("startDate", v)} />
          <FilterDate id="obs-end" label="To" value={filters.endDate} onChange={(v) => setFilter("endDate", v)} />
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="ghost" size="sm" icon="filter_alt_off" disabled={!hasFilters} onClick={() => { setFilters(EMPTY_FILTERS); setPagination((p) => ({ ...p, page: 1 })); }}>
            Clear filters
          </Button>
          <Button variant="outline" size="sm" icon="refresh" onClick={load} disabled={loading}>Refresh</Button>
          <Button variant="outline" size="sm" icon="download" onClick={() => runExport("jsonl")} disabled={busy}>Export JSONL</Button>
          <Button variant="outline" size="sm" icon="download" onClick={() => runExport("csv")} disabled={busy}>Export CSV</Button>
          <div className="flex-1" />
          <Button variant="outline" size="sm" icon="delete" disabled={checked.size === 0 || busy} onClick={() => setConfirm("selected")}>
            Delete selected ({checked.size})
          </Button>
          <Button variant="outline" size="sm" icon="delete_sweep" disabled={pagination.totalItems === 0 || busy} onClick={() => setConfirm("all")} className="text-red-500">
            Clear all
          </Button>
        </div>
      </Card>

      <Card padding="none">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px]">
            <thead>
              <tr className="border-b border-black/5 dark:border-white/5 text-left text-xs uppercase tracking-wide text-text-muted">
                <th className="p-4 w-10">
                  <input type="checkbox" aria-label="Select all on page" checked={allChecked} onChange={toggleAll} />
                </th>
                <th className="p-4">Time</th>
                <th className="p-4">Provider</th>
                <th className="p-4">Model</th>
                <th className="p-4">Status</th>
                <th className="p-4 text-right">In</th>
                <th className="p-4 text-right">Out</th>
                <th className="p-4 text-right">Latency</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan="8" className="p-8 text-center text-text-muted">Loading…</td></tr>
              ) : loadError ? (
                <tr><td colSpan="8" className="p-8 text-center text-red-500">Failed to load logs: {loadError}</td></tr>
              ) : details.length === 0 ? (
                <tr><td colSpan="8" className="p-8 text-center text-text-muted">No log entries. Enable observability in the Settings tab to start recording.</td></tr>
              ) : (
                details.map((d) => (
                  <tr
                    key={d.id}
                    onClick={() => setSelected(d)}
                    className="cursor-pointer border-b border-black/5 dark:border-white/5 last:border-b-0 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors"
                  >
                    <td className="p-4" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" aria-label={`Select ${d.id}`} checked={checked.has(d.id)} onChange={() => toggleChecked(d.id)} />
                    </td>
                    <td className="whitespace-nowrap p-4 text-sm text-text-main">{new Date(d.timestamp).toLocaleString()}</td>
                    <td className="max-w-[160px] truncate p-4 text-sm text-text-main">{d.provider}</td>
                    <td className="max-w-[240px] truncate p-4 font-mono text-sm text-text-main">{d.model}</td>
                    <td className="p-4 text-sm">
                      <span className={cn("font-medium", d.status === "error" ? "text-red-600" : "text-green-600")}>{d.status}</span>
                    </td>
                    <td className="p-4 text-right font-mono text-sm text-text-main">{inputTokens(d.tokens).toLocaleString()}</td>
                    <td className="p-4 text-right font-mono text-sm text-text-main">{outputTokens(d.tokens).toLocaleString()}</td>
                    <td className="p-4 text-right font-mono text-sm text-text-muted">{d.latency?.total || 0}ms</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {!loading && !loadError && details.length > 0 && (
          <div className="border-t border-black/5 dark:border-white/5">
            <Pagination
              currentPage={pagination.page}
              pageSize={pagination.pageSize}
              totalItems={pagination.totalItems}
              onPageChange={(page) => setPagination((p) => ({ ...p, page }))}
              onPageSizeChange={(pageSize) => setPagination((p) => ({ ...p, pageSize, page: 1 }))}
            />
          </div>
        )}
      </Card>

      <Drawer isOpen={!!selected} onClose={() => setSelected(null)} title="Log Entry" width="lg">
        {selected && (
          <div className="space-y-4">
            <p className="text-xs text-text-muted">
              Request and response bodies are redacted; only metadata is stored for viewing.
            </p>
            <pre className="overflow-x-auto rounded-lg bg-black/[0.03] dark:bg-white/[0.03] p-4 text-xs font-mono text-text-main">
              {JSON.stringify(selected, null, 2)}
            </pre>
          </div>
        )}
      </Drawer>

      <ConfirmModal
        isOpen={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={runDelete}
        title={confirm === "all" ? "Clear all logs" : "Delete selected logs"}
        message={confirm === "all"
          ? `Delete all ${pagination.totalItems} stored log entries? This cannot be undone.`
          : `Delete ${checked.size} selected log entries? This cannot be undone.`}
        confirmText="Delete"
        cancelText="Cancel"
        variant="danger"
        loading={busy}
      />
    </>
  );
}
