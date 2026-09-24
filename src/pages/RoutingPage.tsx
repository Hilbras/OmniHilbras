import { useMemo, useState } from 'react';
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Gauge,
  GitBranch,
  LockKeyhole,
  Play,
  Plus,
  RefreshCw,
  Route as RouteIcon,
  Save,
  ShieldCheck,
  Sparkles,
  Timer,
  X,
} from 'lucide-react';
import { DashboardShell } from '../components/DashboardShell';

type Strategy = 'balanced' | 'fallback' | 'round-robin' | 'private';
type Policy = {
  id: string;
  name: string;
  description: string;
  strategy: Strategy;
  routes: number;
  requests: string;
  color: string;
  active?: boolean;
};
type Rule = {
  id: string;
  match: string;
  model: string;
  route: string;
  fallback: string;
  requests: string;
  status: 'active' | 'paused';
  color: string;
};

const initialPolicies: Policy[] = [
  { id: 'balanced', name: 'Balanced default', description: 'Quality first, with cost and latency awareness.', strategy: 'balanced', routes: 4, requests: '18.4k', color: '#e2bd52', active: true },
  { id: 'fast-local', name: 'Fast local', description: 'Keep everyday coding requests close to home.', strategy: 'fallback', routes: 2, requests: '6.8k', color: '#83b7ff' },
  { id: 'private', name: 'Private only', description: 'Never send a request to a hosted provider.', strategy: 'private', routes: 1, requests: '2.1k', color: '#6fdb9b' },
];

const initialRules: Rule[] = [
  { id: 'auto-chat', match: 'model = auto', model: 'Best available', route: 'Anthropic', fallback: 'OpenAI → Ollama', requests: '8.9k', status: 'active', color: '#d97757' },
  { id: 'coding', match: 'task_type = coding', model: 'qwen3-coder', route: 'Ollama', fallback: 'OpenAI', requests: '4.2k', status: 'active', color: '#e2bd52' },
  { id: 'long-context', match: 'tokens > 128k', model: 'claude-sonnet-4', route: 'Anthropic', fallback: 'Google', requests: '2.7k', status: 'active', color: '#d97757' },
  { id: 'embeddings', match: 'endpoint = /embeddings', model: 'text-embedding-3', route: 'OpenAI', fallback: 'Google', requests: '1.4k', status: 'paused', color: '#6fdb9b' },
];

const strategyLabels: Record<Strategy, string> = {
  balanced: 'Balanced',
  fallback: 'Fallback',
  'round-robin': 'Round robin',
  private: 'Private only',
};

function SummaryCard({ label, value, detail, icon: Icon, tone }: { label: string; value: string; detail: string; icon: typeof Activity; tone: string }) {
  return <article className="card min-w-0 p-4 sm:p-5"><div className="flex items-start justify-between gap-3"><span className={`grid h-9 w-9 place-items-center rounded-lg border ${tone}`}><Icon className="h-[17px] w-[17px]" aria-hidden="true" /></span><span className="muted font-mono text-[10px]">{detail}</span></div><p className="muted mt-5 text-[10px] font-semibold uppercase tracking-[0.1em]">{label}</p><p className="mt-1 font-mono text-2xl font-semibold tracking-tight">{value}</p></article>;
}

function PolicyCard({ policy, active, onActivate }: { policy: Policy; active: boolean; onActivate: () => void }) {
  return (
    <button type="button" onClick={onActivate} aria-pressed={active} className={`card min-w-0 p-4 text-left transition-all hover:-translate-y-0.5 sm:p-5 ${active ? 'border-gold/50 shadow-[0_0_0_1px_var(--gold-soft)]' : ''}`}>
      <div className="flex items-start justify-between gap-3"><span className="grid h-9 w-9 place-items-center rounded-lg border" style={{ borderColor: `${policy.color}35`, background: `${policy.color}14`, color: policy.color }}><GitBranch className="h-4 w-4" aria-hidden="true" /></span>{active ? <span className="inline-flex items-center gap-1.5 rounded-full border border-success/25 bg-success/10 px-2 py-1 font-mono text-[9px] text-success"><span className="h-1.5 w-1.5 rounded-full bg-success" />Active</span> : <ChevronRight className="h-4 w-4 text-muted" aria-hidden="true" />}</div>
      <h2 className="mt-5 text-sm font-semibold">{policy.name}</h2><p className="muted mt-1.5 min-h-9 text-xs leading-relaxed">{policy.description}</p>
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3"><span className="rounded-full border border-line-strong bg-bg-soft px-2 py-1 font-mono text-[9px] text-muted">{strategyLabels[policy.strategy]}</span><span className="muted font-mono text-[10px]">{policy.routes} routes · {policy.requests} req</span></div>
    </button>
  );
}

function RuleRow({ rule, onToggle }: { rule: Rule; onToggle: () => void }) {
  const active = rule.status === 'active';
  return <div className={`flex flex-col gap-4 px-4 py-4 transition-colors sm:flex-row sm:items-center sm:justify-between sm:px-5 ${active ? '' : 'opacity-60'}`}><div className="flex min-w-0 items-start gap-3"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border" style={{ borderColor: `${rule.color}35`, background: `${rule.color}14`, color: rule.color }}><RouteIcon className="h-3.5 w-3.5" aria-hidden="true" /></span><div className="min-w-0"><p className="truncate font-mono text-xs font-semibold">{rule.match}</p><p className="muted mt-1 truncate text-[11px]">{rule.model} · {rule.requests} requests</p></div></div><div className="flex flex-wrap items-center gap-2 sm:justify-end"><span className="rounded-full border border-line bg-bg-soft px-2.5 py-1 font-mono text-[10px] text-muted">{rule.route}</span><ArrowRight className="h-3 w-3 text-muted" aria-hidden="true" /><span className="rounded-full border border-line bg-bg-soft px-2.5 py-1 font-mono text-[10px] text-muted">{rule.fallback}</span><button type="button" onClick={onToggle} aria-label={`${active ? 'Pause' : 'Enable'} ${rule.match} rule`} aria-pressed={active} className={`relative ml-1 h-6 w-10 rounded-full border transition-colors ${active ? 'border-success/40 bg-success/20' : 'border-line-strong bg-line/60'}`}><span className={`absolute top-1 h-4 w-4 rounded-full transition-transform ${active ? 'translate-x-5 bg-success' : 'translate-x-1 bg-muted'}`} /></button></div></div>;
}

function PolicySimulator() {
  const [model, setModel] = useState('auto');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(false);
  const routes: Record<string, { label: string; provider: string; model: string; color: string }[]> = {
    auto: [{ label: 'Primary', provider: 'Anthropic', model: 'claude-sonnet-4', color: '#d97757' }, { label: 'Fallback 1', provider: 'OpenAI', model: 'gpt-4.1-mini', color: '#6fdb9b' }, { label: 'Fallback 2', provider: 'Ollama', model: 'qwen3-coder', color: '#e2bd52' }],
    coding: [{ label: 'Primary', provider: 'Ollama', model: 'qwen3-coder', color: '#e2bd52' }, { label: 'Fallback', provider: 'OpenAI', model: 'gpt-4.1-mini', color: '#6fdb9b' }],
    long: [{ label: 'Primary', provider: 'Anthropic', model: 'claude-sonnet-4', color: '#d97757' }, { label: 'Fallback', provider: 'Google', model: 'gemini-2.5-pro', color: '#83b7ff' }],
  };
  const selectedRoutes = routes[model] ?? routes.auto;
  function simulate() { setRunning(true); setResult(false); window.setTimeout(() => { setRunning(false); setResult(true); }, 750); }
  return <section className="card min-w-0 p-4 sm:p-5" aria-labelledby="simulator-title"><div className="flex items-start justify-between gap-3"><div><h2 id="simulator-title" className="text-sm font-semibold">Policy simulator</h2><p className="muted mt-1 text-xs">See how a request would move through your routes.</p></div><span className="grid h-8 w-8 place-items-center rounded-lg border border-gold/25 bg-gold-soft text-gold-text"><Sparkles className="h-4 w-4" aria-hidden="true" /></span></div><label className="mt-5 block"><span className="mono-label mb-2 block">Request profile</span><select value={model} onChange={(event) => { setModel(event.target.value); setResult(false); }} className="input !py-2.5 !text-xs"><option value="auto">General chat · auto</option><option value="coding">Coding task · local first</option><option value="long">Long context · quality first</option></select></label><div className="mt-5 space-y-2">{selectedRoutes.map((route, index) => <div key={route.provider} className="flex items-center gap-3 rounded-lg border border-line bg-bg-soft/60 p-3"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[10px] font-bold" style={{ background: `${route.color}18`, color: route.color }}>{route.provider.slice(0, 1)}</span><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="text-xs font-semibold">{route.provider}</span><span className="rounded-full border border-line px-1.5 py-0.5 font-mono text-[9px] text-muted">{route.label}</span></div><p className="muted mt-1 truncate font-mono text-[10px]">{route.model}</p></div><span className="font-mono text-[10px] text-muted">{index === 0 ? 'first' : 'next'}</span></div>)}</div><button type="button" onClick={simulate} disabled={running} className="btn-gold mt-5 w-full !text-xs">{running ? <Activity className="h-3.5 w-3.5 animate-pulse" aria-hidden="true" /> : <Play className="h-3.5 w-3.5" aria-hidden="true" />}{running ? 'Simulating route' : 'Simulate request'}</button>{result && <p role="status" className="mt-3 flex items-center gap-2 text-[11px] text-success"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />Would route to {selectedRoutes[0].provider} in ~{selectedRoutes[0].provider === 'Ollama' ? '92' : selectedRoutes[0].provider === 'OpenAI' ? '286' : '438'} ms.</p>}</section>;
}

function CreatePolicyModal({ open, onClose, onCreate }: { open: boolean; onClose: () => void; onCreate: (name: string, description: string, strategy: Strategy) => void }) {
  const [name, setName] = useState(''); const [description, setDescription] = useState(''); const [strategy, setStrategy] = useState<Strategy>('balanced');
  if (!open) return null;
  function submit(event: React.FormEvent<HTMLFormElement>) { event.preventDefault(); if (name.trim()) { onCreate(name.trim(), description.trim() || 'A custom routing policy for your local gateway.', strategy); setName(''); setDescription(''); setStrategy('balanced'); } }
  return <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/55 p-0 backdrop-blur-sm sm:items-center sm:p-5" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div role="dialog" aria-modal="true" aria-labelledby="create-policy-title" className="w-full max-w-lg rounded-t-2xl border border-line bg-bg p-5 shadow-2xl sm:rounded-2xl sm:p-6"><div className="flex items-start justify-between gap-4"><div><span className="eyebrow"><span className="eyebrow-dot" aria-hidden="true" />New policy</span><h2 id="create-policy-title" className="mt-3 text-xl font-semibold tracking-tight">Create a routing policy</h2></div><button type="button" onClick={onClose} aria-label="Close create policy dialog" className="muted grid h-9 w-9 place-items-center rounded-lg hover:bg-bg-soft hover:text-gold-text"><X className="h-4 w-4" aria-hidden="true" /></button></div><form onSubmit={submit} className="mt-6 space-y-4"><label className="block"><span className="mono-label mb-2 block">Policy name</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Production chat" className="input" /></label><label className="block"><span className="mono-label mb-2 block">Description</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What should this policy optimize for?" rows={3} className="input resize-none !py-2.5 !text-xs" /></label><label className="block"><span className="mono-label mb-2 block">Strategy</span><select value={strategy} onChange={(event) => setStrategy(event.target.value as Strategy)} className="input !py-2.5 !text-xs"><option value="balanced">Balanced · quality and cost</option><option value="fallback">Fallback · try in order</option><option value="round-robin">Round robin · rotate routes</option><option value="private">Private only · local routes</option></select></label><div className="flex flex-col-reverse gap-2 border-t border-line pt-5 sm:flex-row sm:justify-end"><button type="button" onClick={onClose} className="btn-ghost">Cancel</button><button type="submit" disabled={!name.trim()} className="btn-gold">Create policy <Save className="h-4 w-4" aria-hidden="true" /></button></div></form></div></div>;
}

export function RoutingContent() {
  const [policies, setPolicies] = useState(initialPolicies);
  const [activePolicyId, setActivePolicyId] = useState('balanced');
  const [rules, setRules] = useState(initialRules);
  const [createOpen, setCreateOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const activePolicy = policies.find((policy) => policy.id === activePolicyId) ?? policies[0];
  const activeRules = useMemo(() => rules.filter((rule) => rule.status === 'active').length, [rules]);
  function flash(message: string) { setNotice(message); window.setTimeout(() => setNotice(''), 3200); }
  function toggleRule(id: string) { setRules((current) => current.map((rule) => rule.id === id ? { ...rule, status: rule.status === 'active' ? 'paused' : 'active' } : rule)); }
  function createPolicy(name: string, description: string, strategy: Strategy) { const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`; setPolicies((current) => [...current, { id, name, description, strategy, routes: 1, requests: '0', color: '#b995e8' }]); setActivePolicyId(id); setCreateOpen(false); flash(`${name} policy created.`); }
  return <><div id="routing"><div className="mb-6 flex flex-col justify-between gap-5 sm:mb-8 sm:flex-row sm:items-end"><div><span className="eyebrow"><span className="eyebrow-dot" aria-hidden="true" />Routing control plane</span><h2 className="mt-4 text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">Make every request intentional.</h2><p className="muted mt-2 max-w-xl text-sm leading-relaxed">Define how OmniHilbras chooses a route, tries the next option, and keeps latency and spend in view.</p></div><div className="flex items-center gap-2"><button type="button" onClick={() => flash('All active policies passed the preview health check.')} className="btn-ghost !px-3 !py-2.5 !text-xs"><Gauge className="h-3.5 w-3.5" aria-hidden="true" />Test policies</button><button type="button" onClick={() => setCreateOpen(true)} className="btn-gold !px-3 !py-2.5 !text-xs"><Plus className="h-3.5 w-3.5" aria-hidden="true" />Create policy</button></div></div>{notice && <div role="status" className="mb-5 flex items-center gap-2 rounded-xl border border-success/25 bg-success/10 px-3.5 py-3 text-xs text-success"><CheckCircle2 className="h-4 w-4" aria-hidden="true" />{notice}</div>}
<section className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="Routing summary"><SummaryCard label="Active policies" value={String(policies.length)} detail="configured" icon={GitBranch} tone="border-gold/25 bg-gold-soft text-gold-text" /><SummaryCard label="Active rules" value={String(activeRules)} detail={`of ${rules.length}`} icon={RouteIcon} tone="border-success/20 bg-success/10 text-success" /><SummaryCard label="Fallback events" value="18" detail="last 24 hours" icon={RefreshCw} tone="border-[#83b7ff]/25 bg-[#83b7ff]/10 text-[#5d98e8]" /><SummaryCard label="Decision time" value="4 ms" detail="p95" icon={Timer} tone="border-[#b995e8]/25 bg-[#b995e8]/10 text-[#9b7bd1]" /></section>
<section className="mt-5" aria-labelledby="policies-title"><div className="mb-3 flex items-center justify-between gap-3"><div><h2 id="policies-title" className="text-sm font-semibold">Policies</h2><p className="muted mt-1 text-xs">Choose the policy that best matches each kind of work.</p></div><span className="hidden font-mono text-[10px] text-muted sm:block">Click a policy to make it active</span></div><div className="grid gap-4 md:grid-cols-3">{policies.map((policy) => <PolicyCard key={policy.id} policy={policy} active={policy.id === activePolicyId} onActivate={() => { setActivePolicyId(policy.id); flash(`${policy.name} is now the active policy.`); }} />)}</div></section>
<div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]"><section className="card min-w-0 overflow-hidden" aria-labelledby="rules-title"><div className="flex flex-col justify-between gap-3 border-b border-line p-4 sm:flex-row sm:items-center sm:p-5"><div><h2 id="rules-title" className="text-sm font-semibold">Routing rules</h2><p className="muted mt-1 text-xs">Rules are evaluated from top to bottom.</p></div><span className="rounded-full border border-line bg-bg-soft px-2.5 py-1 font-mono text-[10px] text-muted">active: {activePolicy.name}</span></div><div className="divide-y divide-line/70">{rules.map((rule) => <RuleRow key={rule.id} rule={rule} onToggle={() => toggleRule(rule.id)} />)}</div><div className="flex items-center justify-between border-t border-line px-4 py-3 sm:px-5"><span className="muted flex items-center gap-1.5 text-[11px]"><CircleAlert className="h-3.5 w-3.5 text-gold" aria-hidden="true" />Rules are preview-only until connected</span><button type="button" onClick={() => setCreateOpen(true)} className="btn-quiet !px-2 !py-1 text-[11px]"><Plus className="h-3 w-3" aria-hidden="true" />Add rule</button></div></section><PolicySimulator /></div>
<section className="mt-5 grid gap-4 md:grid-cols-3"><div className="card p-4 sm:p-5"><div className="flex items-center gap-2"><span className="grid h-8 w-8 place-items-center rounded-lg border border-gold/25 bg-gold-soft text-gold-text"><ShieldCheck className="h-4 w-4" aria-hidden="true" /></span><h2 className="text-sm font-semibold">Safe fallback</h2></div><p className="muted mt-4 text-xs leading-relaxed">If a provider times out or returns an unhealthy response, the next enabled route takes over.</p></div><div className="card p-4 sm:p-5"><div className="flex items-center gap-2"><span className="grid h-8 w-8 place-items-center rounded-lg border border-[#83b7ff]/25 bg-[#83b7ff]/10 text-[#5d98e8]"><Gauge className="h-4 w-4" aria-hidden="true" /></span><h2 className="text-sm font-semibold">Observable decisions</h2></div><p className="muted mt-4 text-xs leading-relaxed">Every route choice is recorded with its policy, provider, and reason for the next request.</p></div><div className="card p-4 sm:p-5"><div className="flex items-center gap-2"><span className="grid h-8 w-8 place-items-center rounded-lg border border-success/25 bg-success/10 text-success"><LockKeyhole className="h-4 w-4" aria-hidden="true" /></span><h2 className="text-sm font-semibold">Local by default</h2></div><p className="muted mt-4 text-xs leading-relaxed">Private policies keep requests on providers you control, with no account required locally.</p></div></section><div className="mt-5 flex items-start gap-3 rounded-xl border border-gold/20 bg-gold-soft/45 px-4 py-3.5"><Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-gold-text" aria-hidden="true" /><div><p className="text-xs font-semibold">Routing preview</p><p className="muted mt-1 text-[11px]">These policies are local UI previews. Connect the gateway settings API to make them persist across sessions.</p></div></div></div><CreatePolicyModal open={createOpen} onClose={() => setCreateOpen(false)} onCreate={createPolicy} /></>;
}

export default function RoutingPage() {
  return <DashboardShell activePage="routing" pageTitle="Routing" pageDescription="Policies, fallbacks, and request flow"><RoutingContent /></DashboardShell>;
}
