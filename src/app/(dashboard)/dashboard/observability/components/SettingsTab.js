"use client";

import { useState, useEffect } from "react";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Input from "@/shared/components/Input";
import Toggle from "@/shared/components/Toggle";

const FIELDS = [
  { key: "maxRecords", label: "Max records", hint: "Oldest entries are pruned beyond this (10–100000)", min: 10, max: 100000 },
  { key: "batchSize", label: "Batch size", hint: "Entries buffered before a write (1–500)", min: 1, max: 500 },
  { key: "flushIntervalMs", label: "Flush interval (ms)", hint: "Max wait before buffered entries are written (100–60000)", min: 100, max: 60000 },
  { key: "maxJsonSize", label: "Max payload size (KB)", hint: "Larger request/response fields are truncated (1–1024)", min: 1, max: 1024 },
];

export default function SettingsTab() {
  const [config, setConfig] = useState(null);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    fetch("/api/observability/settings")
      .then((res) => res.json())
      .then((data) => {
        setConfig(data);
        setDraft(Object.fromEntries(FIELDS.map((f) => [f.key, String(data[f.key])])));
      })
      .catch((err) => setMessage({ error: true, text: err.message }));
  }, []);

  const patch = async (body) => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/observability/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setConfig(data);
      setDraft(Object.fromEntries(FIELDS.map((f) => [f.key, String(data[f.key])])));
      setMessage({ error: false, text: "Saved" });
    } catch (err) {
      setMessage({ error: true, text: err.message });
    } finally {
      setSaving(false);
    }
  };

  if (!config) {
    return <Card padding="md"><p className="text-sm text-text-muted">{message?.text || "Loading…"}</p></Card>;
  }

  const invalid = FIELDS.find((f) => {
    const n = Number(draft[f.key]);
    return !Number.isInteger(n) || n < f.min || n > f.max;
  });
  const dirty = FIELDS.some((f) => draft[f.key] !== String(config[f.key]));

  return (
    <div className="flex flex-col gap-6">
      <Card padding="md">
        <div className="flex items-start sm:items-center justify-between gap-4">
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm sm:text-base">Record requests</p>
            <p className="text-xs sm:text-sm text-text-muted">
              {config.envOverride
                ? "Turned off by OBSERVABILITY_ENABLED=false in the server environment; remove it to use this toggle."
                : "Store metadata for each gateway request so it shows up in Logs and Metrics"}
            </p>
          </div>
          <Toggle checked={config.enabled} onChange={(enabled) => patch({ enabled })} disabled={saving || config.envOverride} />
        </div>
      </Card>

      <Card padding="md" title="Storage">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {FIELDS.map((f) => (
            <Input
              key={f.key}
              label={f.label}
              type="number"
              min={f.min}
              max={f.max}
              value={draft[f.key] ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
              hint={f.hint}
            />
          ))}
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Button
            variant="primary"
            size="sm"
            loading={saving}
            disabled={!dirty || !!invalid}
            onClick={() => patch(Object.fromEntries(FIELDS.map((f) => [f.key, Number(draft[f.key])])))}
          >
            Save
          </Button>
          {invalid && <span className="text-xs text-red-500">{invalid.label} is out of range</span>}
          {message && !invalid && (
            <span className={message.error ? "text-xs text-red-500" : "text-xs text-green-600"}>{message.text}</span>
          )}
        </div>
      </Card>
    </div>
  );
}
