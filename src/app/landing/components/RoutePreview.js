"use client";

import { useState } from "react";
import { Check, ChevronRight, CircleDot, ShieldCheck } from "./Icons";

const routes = [
  {
    id: "auto",
    label: "Auto",
    provider: "Best available",
    model: "claude-sonnet-4 · gemini-2.5-pro",
    color: "#e2bd52",
    initial: "A",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    provider: "Anthropic",
    model: "claude-sonnet-4",
    color: "#d97757",
    initial: "C",
  },
  {
    id: "openai",
    label: "OpenAI",
    provider: "OpenAI",
    model: "gpt-4.1-mini",
    color: "#6fdb9b",
    initial: "O",
  },
  {
    id: "local",
    label: "Local",
    provider: "Ollama",
    model: "qwen3-coder",
    color: "#83b7ff",
    initial: "L",
  },
];

function ProviderMark({ initial, color, className = "" }) {
  return (
    <span
      className={`grid place-items-center font-mono font-bold shrink-0 ${className}`}
      style={{ background: `${color}22`, color, border: `1px solid ${color}55` }}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}

/**
 * Routing illustration — request shape, priority path, selectable route.
 * No live metrics: latency is "measured per request", policy is "pinned provider".
 */
export default function RoutePreview() {
  const [selectedRoute, setSelectedRoute] = useState("auto");
  const activeRoute = routes.find((route) => route.id === selectedRoute) ?? routes[0];

  return (
    <div className="route-panel overflow-hidden rounded-2xl border border-line">
      <div className="flex items-center justify-between border-b border-line/80 px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-gold/30 bg-gold-soft text-[13px] text-gold-text" aria-hidden="true">
            ◈
          </span>
          <div className="min-w-0">
            <p className="truncate font-mono text-[11px] font-medium tracking-wide">omnihilbras / gateway</p>
            <p className="muted mt-0.5 truncate text-[10px]">how a route is chosen</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 rounded-full border border-line-strong bg-surface-2 px-2.5 py-1 font-mono text-[10px] text-muted">
          illustration
        </div>
      </div>

      <div className="grid gap-5 p-4 sm:p-5 lg:grid-cols-[1fr_0.72fr_1fr] lg:items-center lg:gap-4">
        <div className="rounded-xl border border-line bg-bg-soft/80 p-4">
          <div className="mb-4 flex items-center justify-between">
            <span className="mono-label">incoming request</span>
          </div>
          <div className="space-y-3 font-mono text-[11px] leading-relaxed">
            <p>
              <span className="code-muted">POST</span> <span className="text-gold-text">/v1/chat/completions</span>
            </p>
            <p>
              <span className="code-muted">model</span> <span className="text-gold-text">{activeRoute.id === "auto" ? "auto" : activeRoute.label.toLowerCase()}</span>
            </p>
            <p>
              <span className="code-muted">stream</span> <span className="text-gold-text">true</span>
            </p>
          </div>
          <div className="mt-4 flex items-center gap-2 border-t border-line/70 pt-3 text-[11px] text-muted">
            <ShieldCheck className="h-3.5 w-3.5 text-success" aria-hidden="true" />
            <span>keys stay on your server</span>
          </div>
        </div>

        <div className="relative hidden min-h-[170px] flex-col items-center justify-center lg:flex" aria-label="Routing path">
          <div className="absolute left-1/2 top-5 h-[calc(100%-40px)] w-px -translate-x-1/2 bg-line-strong/70" />
          <div className="relative z-10 grid h-8 w-8 place-items-center rounded-full border border-gold/40 bg-bg text-gold-text">
            <CircleDot className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="route-line absolute left-1/2 top-1/2 h-px w-[78%] -translate-x-1/2" />
          {routes.slice(0, 3).map((route, index) => (
            <span
              key={route.id}
              className="route-dot absolute h-2.5 w-2.5 rounded-full bg-gold"
              style={{ left: `${29 + index * 21}%`, top: `${49 + (index - 1) * 24}%`, animationDelay: `${index * 420}ms` }}
              aria-hidden="true"
            />
          ))}
          <span className="mono-label absolute bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap">priority order</span>
        </div>

        <div className="rounded-xl border border-line bg-bg-soft/80 p-4" aria-live="polite">
          <div className="mb-4 flex items-center justify-between">
            <span className="mono-label">selected route</span>
            <span className="hidden shrink-0 font-mono text-[10px] text-success min-[360px]:inline">200 OK</span>
          </div>
          <div className="flex items-center gap-3">
            <ProviderMark initial={activeRoute.initial} color={activeRoute.color} className="h-9 w-9 rounded-full text-xs" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{activeRoute.provider}</p>
              <p className="truncate font-mono text-[10px] text-muted">{activeRoute.model}</p>
            </div>
            <Check className="ml-auto h-4 w-4 shrink-0 text-success" aria-label="Route healthy" />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-line bg-surface px-3 py-2.5">
              <span className="mono-label block">latency</span>
              <strong className="mt-1 block font-mono text-xs">measured per request</strong>
            </div>
            <div className="rounded-lg border border-line bg-surface px-3 py-2.5">
              <span className="mono-label block">policy</span>
              <strong className="mt-1 block font-mono text-xs">pinned provider</strong>
            </div>
          </div>
        </div>
      </div>

      <div className="border-t border-line/80 px-4 py-3 sm:px-5">
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="mono-label">choose a policy to preview</span>
          <span className="muted hidden font-mono text-[10px] sm:inline">click a provider</span>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {routes.map((route) => {
            const selected = route.id === selectedRoute;
            return (
              <button
                key={route.id}
                type="button"
                onClick={() => setSelectedRoute(route.id)}
                aria-pressed={selected}
                className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                  selected ? "border-gold/60 bg-gold-soft text-gold-text" : "border-line bg-surface text-muted hover:border-line-strong hover:text-text"
                }`}
              >
                <ProviderMark initial={route.initial} color={route.color} className="h-5 w-5 rounded-md text-[8px]" />
                <span className="min-w-0 truncate text-[11px] font-medium">{route.label}</span>
                {selected && <ChevronRight className="ml-auto h-3 w-3 shrink-0" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
