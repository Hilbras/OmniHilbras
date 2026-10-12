import { useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {
  GatewayUsageGroup,
  GatewayUsageModelGroup,
  GatewayUsageProviderGroup,
  GatewayUsageTimelinePoint,
} from '../lib/gatewayClient';

/**
 * The usage page's charts.
 *
 * ## Why this file is the only one that imports `recharts`
 *
 * Every page is statically imported from `dashboardApp.tsx`, so a dependency imported from `UsagePage.tsx`
 * lands in the dashboard's initial chunk on **every** page — the same trap that once put `motion` (284 KB
 * rendered) in front of every navigation. recharts is heavier than that: it pulls redux-toolkit, immer and
 * victory-vendor. So `UsagePage` reaches this module only through `lazy(() => import('./UsageCharts'))`, the
 * browser fetches it on intent, and `tests/bundle-budget.test.js` asserts the import stays dynamic.
 *
 * ## The one rule carried in from the page
 *
 * A chart must not draw a measurement that was never taken. A group whose provider reported no tokens has
 * `tokensMeasured: 0`, and a group with no published price has `pricedRequests: 0`; both are drawn as an
 * explicit "not measured" line rather than as a zero-height bar, because a zero bar is a claim that the value
 * is zero.
 */

const CHART_COLORS = ['#d4af37', '#5b8def', '#177d47', '#c23b31', '#8b5cf6', '#06b6d4', '#f59e0b', '#10b981'];

/** Compact counts for an axis tick. */
function axisTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function axisUsd(value: number): string {
  return value < 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(0)}`;
}

function EmptyChart({ message }: { message: string }) {
  return <p className="muted py-10 text-center text-xs">{message}</p>;
}

/** A tooltip on the page's own surface colours rather than recharts' default white. */
const tooltipStyle = {
  contentStyle: {
    background: 'var(--color-surface)',
    border: '1px solid var(--color-line)',
    borderRadius: 10,
    fontSize: 12,
  },
  labelStyle: { color: 'var(--color-text)' },
} as const;

type Mode = 'tokens' | 'requests';

/** A labelled option for the toggle, so each chart states which values it offers. */
type ToggleOption<T extends string> = { value: T; label: string; disabled?: boolean; disabledHint?: string };

function ModeToggle<T extends string>({ mode, onChange, options }: {
  mode: T;
  onChange: (next: T) => void;
  options: Array<ToggleOption<T>>;
}) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Chart value">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
          aria-pressed={mode === option.value}
          title={option.disabled ? option.disabledHint : undefined}
          className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            mode === option.value ? 'border-line bg-bg-soft text-text' : 'border-transparent text-muted hover:text-text'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Token or request figure for one group, with whether it is a real measurement. */
function measurement(group: { inputTokens: number; outputTokens: number; tokensMeasured: number; requests: number; costUsd: number; pricedRequests: number }, mode: Mode | 'cost') {
  if (mode === 'cost') return { value: group.costUsd, measured: group.pricedRequests > 0 };
  if (mode === 'requests') return { value: group.requests, measured: true };
  return { value: group.inputTokens + group.outputTokens, measured: group.tokensMeasured > 0 };
}

export function UsageTimelineChart({ timeline }: { timeline: GatewayUsageTimelinePoint[] }) {
  const [mode, setMode] = useState<Mode | 'cost'>('tokens');
  // Cost is offerable only when something in the window was priced; otherwise the button is disabled and
  // says why, rather than the chart drawing a flat $0 that reads as "this was free".
  const costAvailable = timeline.some((point) => point.pricedRequests > 0);
  const anyMeasured = timeline.some((point) => measurement(point, mode).measured);
  const data = useMemo(
    () => timeline.map((point) => ({ label: point.label, value: measurement(point, mode).value })),
    [timeline, mode],
  );

  return (
    <section className="card p-4" aria-label="Usage over time">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Over time</h3>
        <ModeToggle
          mode={mode}
          onChange={setMode}
          options={[
            { value: 'tokens', label: 'Tokens' },
            { value: 'requests', label: 'Requests' },
            { value: 'cost', label: 'Cost', disabled: !costAvailable, disabledHint: 'No request in this window had a published price.' },
          ]}
        />
      </div>
      {!anyMeasured ? (
        <EmptyChart message={mode === 'cost' ? 'No request in this window had a published price.' : 'No provider reported tokens in this window.'} />
      ) : (
        <div className="h-[220px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="usageArea" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-gold)" stopOpacity={0.45} />
                  <stop offset="100%" stopColor="var(--color-gold)" stopOpacity={0.03} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--color-line)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--color-muted)' }} interval="preserveStartEnd" tickLine={false} axisLine={false} />
              <YAxis
                tick={{ fontSize: 11, fill: 'var(--color-muted)' }}
                tickFormatter={mode === 'cost' ? axisUsd : mode === 'requests' ? String : axisTokens}
                width={48}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip {...tooltipStyle} formatter={(value) => {
                const numeric = typeof value === 'number' ? value : Number(value);
                return [mode === 'cost' ? axisUsd(numeric) : numeric.toLocaleString(), mode === 'cost' ? 'Cost' : mode === 'requests' ? 'Requests' : 'Tokens'];
              }} />
              <Area type="monotone" dataKey="value" stroke="var(--color-gold)" strokeWidth={2} fill="url(#usageArea)" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}

/** One bar chart over a grouped list, shared by the provider and model views. */
function GroupBarChart<T extends GatewayUsageGroup>({ title, ariaLabel, groups, nameOf, emptyMessage, layout }: {
  title: string;
  ariaLabel: string;
  groups: T[];
  nameOf: (group: T) => string;
  emptyMessage: string;
  layout: 'vertical' | 'horizontal';
}) {
  const [mode, setMode] = useState<Mode>('tokens');
  const anyMeasured = groups.some((group) => measurement(group, mode).measured);
  const data = useMemo(
    () => groups.map((group) => ({ name: nameOf(group), value: measurement(group, mode).value })),
    [groups, mode, nameOf],
  );
  const vertical = layout === 'horizontal';

  return (
    <section className="card p-4" aria-label={ariaLabel}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        <ModeToggle
          mode={mode}
          onChange={setMode}
          options={[
            { value: 'tokens', label: 'Tokens' },
            { value: 'requests', label: 'Requests' },
          ]}
        />
      </div>
      {groups.length === 0 ? (
        <EmptyChart message={emptyMessage} />
      ) : !anyMeasured ? (
        <EmptyChart message="No provider reported tokens for these requests." />
      ) : (
        <div className={layout === 'horizontal' ? 'h-[220px] w-full' : 'h-[240px] w-full'}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout={vertical ? 'vertical' : 'horizontal'} margin={{ top: 6, right: 12, bottom: 0, left: vertical ? 8 : 0 }}>
              <CartesianGrid stroke="var(--color-line)" strokeDasharray="3 3" vertical={vertical} horizontal={!vertical} />
              {vertical ? (
                <>
                  <XAxis type="number" tick={{ fontSize: 11, fill: 'var(--color-muted)' }} tickFormatter={axisTokens} tickLine={false} axisLine={false} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: 'var(--color-muted)' }} width={120} tickLine={false} axisLine={false} />
                </>
              ) : (
                <>
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--color-muted)' }} interval={0} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: 'var(--color-muted)' }} tickFormatter={axisTokens} width={48} tickLine={false} axisLine={false} />
                </>
              )}
              <Tooltip {...tooltipStyle} cursor={{ fill: 'var(--color-bg-soft)' }} />
              <Bar dataKey="value" radius={vertical ? [0, 4, 4, 0] : [4, 4, 0, 0]} maxBarSize={vertical ? 18 : 40}>
                {data.map((entry, index) => (
                  <Cell key={entry.name} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}

export function ProviderBarChart({ groups }: { groups: GatewayUsageProviderGroup[] }) {
  return (
    <GroupBarChart
      title="By provider"
      ariaLabel="Requests by provider"
      groups={groups}
      nameOf={(group) => group.id}
      emptyMessage="No provider served a request in this window."
      layout="horizontal"
    />
  );
}

export function TopModelsChart({ groups }: { groups: GatewayUsageModelGroup[] }) {
  // Only the top five, as 9router does: a horizontal list of thirty models is a table, not a chart.
  const top = useMemo(() => [...groups].sort((a, b) => b.requests - a.requests).slice(0, 5), [groups]);
  return (
    <GroupBarChart
      title="Top models"
      ariaLabel="Requests by model"
      groups={top}
      nameOf={(group) => group.model}
      emptyMessage="No model was asked for in this window."
      layout="vertical"
    />
  );
}