import { useEffect, useState } from 'react';
import type { GatewayOperatorRecord } from '../lib/gatewayClient';

/**
 * One read-only surface for the gateway's operator stores.
 *
 * Every value on this page comes from the gateway's own list response. A `NOT_SUPPORTED` refusal is
 * printed verbatim rather than replaced by an empty table, because "this build has no store" and
 * "the store is empty" are different answers. No timer ever sets a success state here: the only
 * state changes come from the request's own promise.
 */
export function OperatorRecordsPage({ title, description, fields, load }: {
  title: string;
  description: string;
  fields: readonly string[];
  load: (signal: AbortSignal) => Promise<GatewayOperatorRecord[]>;
}) {
  const [records, setRecords] = useState<GatewayOperatorRecord[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    load(controller.signal)
      .then((rows) => { setRecords(rows); setError(undefined); })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setRecords(undefined);
        setError(cause instanceof Error ? cause.message : 'The gateway did not answer.');
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [load]);

  const render = (value: unknown) => {
    if (value === undefined || value === null || value === '') return '—';
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };

  return (
    <div className="space-y-4">
      <header>
        <p className="eyebrow">Operator</p>
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="muted mt-1 text-xs">{description}</p>
      </header>

      {error && <p role="alert" className="rounded-xl border border-warning/25 bg-warning/10 px-3 py-2 text-xs text-warning">{error}</p>}

      <section className="card overflow-hidden" aria-label={`${title} records`}>
        {loading ? (
          <p className="muted px-4 py-10 text-center text-xs">Reading the gateway store…</p>
        ) : !records ? (
          <p className="muted px-4 py-10 text-center text-xs">Nothing to show — the gateway did not return a list.</p>
        ) : records.length === 0 ? (
          <p className="muted px-4 py-10 text-center text-xs">The gateway returned no records.</p>
        ) : (
          <ul className="divide-y divide-line">
            {records.map((record, index) => (
              <li key={String(record.id ?? index)} className="px-4 py-3">
                <p className="font-mono text-xs font-semibold">{render(record.name ?? record.id ?? index)}</p>
                <dl className="mt-2 grid gap-x-4 gap-y-1 text-[11px] sm:grid-cols-3">
                  {fields.map((field) => (
                    <div key={field}><dt className="mono-label">{field}</dt><dd className="break-all font-mono">{render(record[field])}</dd></div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
