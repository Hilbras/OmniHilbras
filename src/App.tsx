import { useState } from 'react';
import { motion, MotionConfig, type Variants } from 'motion/react';
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Braces,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Clock3,
  Code2,
  Copy,
  Gauge,
  LockKeyhole,
  Network,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Workflow,
} from 'lucide-react';
import { Footer } from './components/Footer';
import { Navbar } from './components/Navbar';
import { ParticleBackground } from './components/ParticleBackground';
import { RoutePreview } from './components/RoutePreview';

const revealContainer: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.09, delayChildren: 0.08 } },
};

const revealItem: Variants = {
  hidden: { opacity: 0, y: 22 },
  show: { opacity: 1, y: 0, transition: { duration: 0.58, ease: [0.22, 1, 0.36, 1] } },
};

const revealCard: Variants = {
  hidden: { opacity: 0, y: 28, scale: 0.98 },
  show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.55, ease: [0.22, 1, 0.36, 1] } },
};

const viewport = { once: true, amount: 0.16 } as const;

const providers = ['OpenAI', 'Anthropic', 'Google', 'Mistral', 'Groq', 'Ollama', 'OpenRouter', 'DeepSeek'] as const;

const features = [
  {
    icon: Network,
    label: 'Unified surface',
    title: 'One endpoint. Every model.',
    body: 'Keep your application code stable while providers, models, and regions change underneath it.',
    detail: 'OpenAI-compatible by default',
  },
  {
    icon: SlidersHorizontal,
    label: 'Policy engine',
    title: 'Route on what matters.',
    body: 'Choose the right trade-off for each request: fastest response, lowest cost, private local inference, or a provider you already trust.',
    detail: 'Per-model rules and budgets',
  },
  {
    icon: ShieldCheck,
    label: 'Resilient by design',
    title: 'Fail over before users notice.',
    body: 'Health checks, retries, and graceful fallback keep a slow provider from becoming a broken product.',
    detail: 'Automatic recovery paths',
  },
] as const;

const steps = [
  {
    number: '01',
    icon: Server,
    title: 'Connect your providers',
    body: 'Bring API keys for the services you already use, or start with a local Ollama endpoint.',
  },
  {
    number: '02',
    icon: Workflow,
    title: 'Define the policy',
    body: 'Set priorities for quality, latency, cost, privacy, and the providers allowed to serve each route.',
  },
  {
    number: '03',
    icon: Code2,
    title: 'Ship one clean request',
    body: 'Point your app at OmniHilbras and keep the same interface while the routing layer gets smarter.',
  },
] as const;

const requestRows = [
  { path: '/v1/chat/completions', provider: 'Anthropic', model: 'claude-sonnet-4', latency: '438 ms', status: '200' },
  { path: '/v1/chat/completions', provider: 'OpenAI', model: 'gpt-4.1-mini', latency: '286 ms', status: '200' },
  { path: '/v1/responses', provider: 'Ollama', model: 'qwen3-coder', latency: '92 ms', status: '200' },
  { path: '/v1/embeddings', provider: 'OpenRouter', model: 'text-embedding-3', latency: '164 ms', status: '200' },
];

const codeSamples = {
  curl: `curl https://gateway.omnihilbras.dev/v1/chat/completions \\
  -H "Authorization: Bearer $OMNIHILBRAS_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "auto",
    "messages": [{ "role": "user", "content": "Hello" }]
  }'`,
  typescript: `const response = await fetch(
  'https://gateway.omnihilbras.dev/v1/chat/completions',
  {
    method: 'POST',
    headers: {
      Authorization: \`Bearer \${process.env.OMNIHILBRAS_KEY}\`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'auto',
      messages: [{ role: 'user', content: 'Hello' }],
    }),
  },
);`,
} as const;

type CodeLanguage = keyof typeof codeSamples;

function LogoStrip() {
  return (
    <section className="overflow-hidden border-b border-line bg-bg-soft/60 py-8" aria-label="Supported providers">
      <p className="muted text-center text-[10px] font-semibold tracking-[0.18em] uppercase">
        Bring the providers you already trust
      </p>
      <div className="relative mt-5 overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 z-10 w-20"
          style={{ backgroundImage: 'linear-gradient(to right, var(--bg-soft), transparent)' }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 z-10 w-20"
          style={{ backgroundImage: 'linear-gradient(to left, var(--bg-soft), transparent)' }}
        />
        <div className="marquee flex w-max items-center gap-10 sm:gap-14">
          {[...providers, ...providers].map((provider, index) => (
            <span key={`${provider}-${index}`} className="muted flex items-center gap-2 text-sm font-semibold">
              <span className="grid h-5 w-5 place-items-center rounded-md border border-line-strong bg-surface font-mono text-[9px] text-gold-text">
                {provider.slice(0, 1)}
              </span>
              {provider}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

function ProductSection() {
  return (
    <section id="product" className="mx-auto max-w-6xl px-5 py-16 sm:py-24">
      <motion.div
        variants={revealContainer}
        initial={false}
        whileInView="show"
        viewport={viewport}
        className="text-center"
      >
        <motion.div variants={revealItem}>
          <span className="eyebrow">
            <span className="eyebrow-dot" aria-hidden="true" />
            A calmer model layer
          </span>
          <h2 className="section-title mx-auto mt-5 max-w-2xl">Keep control of the route.</h2>
          <p className="muted mx-auto mt-4 max-w-xl text-sm leading-relaxed sm:text-base">
            OmniHilbras turns provider choice into an intentional product decision—not a config file written in a hurry.
          </p>
        </motion.div>
      </motion.div>

      <motion.div
        variants={revealContainer}
        initial={false}
        whileInView="show"
        viewport={viewport}
        className="mt-10 grid gap-4 md:grid-cols-3"
      >
        {features.map(({ icon: Icon, label, title, body, detail }) => (
          <motion.article key={title} variants={revealCard} className="card group relative overflow-hidden p-6">
            <div className="mb-8 flex items-center justify-between">
              <span className="grid h-10 w-10 place-items-center rounded-xl border border-gold/25 bg-gold-soft text-gold-text">
                <Icon className="h-5 w-5" aria-hidden="true" />
              </span>
              <span className="mono-label transition-colors group-hover:text-gold-text">{label}</span>
            </div>
            <h3 className="text-lg font-semibold tracking-[-0.02em]">{title}</h3>
            <p className="muted mt-3 text-sm leading-relaxed">{body}</p>
            <div className="mt-6 flex items-center gap-2 border-t border-line pt-4 text-[11px] text-muted">
              <CheckCircle2 className="h-3.5 w-3.5 text-gold" aria-hidden="true" />
              {detail}
            </div>
            <div aria-hidden="true" className="absolute -right-12 -bottom-12 h-32 w-32 rounded-full bg-gold-soft opacity-0 blur-2xl transition-opacity group-hover:opacity-100" />
          </motion.article>
        ))}
      </motion.div>

      <motion.div
        initial={false}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={viewport}
        transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
        className="mt-5 flex flex-col items-start justify-between gap-4 rounded-2xl border border-gold/25 bg-gold-soft/60 px-5 py-4 sm:flex-row sm:items-center sm:px-6"
      >
        <div className="flex items-start gap-3">
          <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-gold-text" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold">Your infrastructure stays yours.</p>
            <p className="muted mt-1 text-xs">Self-host the gateway, keep your keys, and choose exactly where requests run.</p>
          </div>
        </div>
        <a href="#start" className="btn-quiet shrink-0 text-gold-text">
          See the principles <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      </motion.div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section id="how-it-works" className="border-y border-line bg-bg-soft/55">
      <div className="mx-auto max-w-6xl px-5 py-16 sm:py-24">
        <motion.div
          variants={revealContainer}
          initial={false}
          whileInView="show"
          viewport={viewport}
          className="mb-10 text-center"
        >
          <motion.div variants={revealItem}>
            <span className="eyebrow">How it works</span>
            <h2 className="section-title mt-5">From provider sprawl to one clear path.</h2>
            <p className="muted mx-auto mt-4 max-w-lg text-sm leading-relaxed">
              OmniHilbras sits beside your app, not in the way of it. Start small and make the routing policy as expressive as you need.
            </p>
          </motion.div>
        </motion.div>

        <motion.div
          variants={revealContainer}
          initial={false}
          whileInView="show"
          viewport={viewport}
          className="grid gap-4 md:grid-cols-3"
        >
          {steps.map(({ number, icon: Icon, title, body }, index) => (
            <motion.article key={number} variants={revealCard} className="card relative p-6">
              <div className="mb-8 flex items-center justify-between">
                <span className="font-mono text-3xl font-bold text-gold/80">{number}</span>
                <span className="grid h-9 w-9 place-items-center rounded-full border border-line-strong text-gold-text">
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
              </div>
              <h3 className="font-semibold">{title}</h3>
              <p className="muted mt-2.5 text-sm leading-relaxed">{body}</p>
              {index < steps.length - 1 && (
                <div aria-hidden="true" className="absolute -right-3 top-1/2 hidden h-px w-6 bg-gold/45 md:block" />
              )}
            </motion.article>
          ))}
        </motion.div>
      </div>
    </section>
  );
}

function DocsSection() {
  const [language, setLanguage] = useState<CodeLanguage>('curl');
  const [copied, setCopied] = useState(false);
  const code = codeSamples[language];

  async function copyCode() {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section id="docs" className="mx-auto max-w-6xl px-5 py-16 sm:py-24">
      <div className="grid items-center gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
        <motion.div
          variants={revealContainer}
          initial={false}
          whileInView="show"
          viewport={viewport}
        >
          <motion.div variants={revealItem}>
            <span className="eyebrow">A familiar interface</span>
            <h2 className="section-title mt-5">A better default, not a new abstraction.</h2>
            <p className="muted mt-4 text-sm leading-relaxed sm:text-base">
              Keep the request shape your team already knows. OmniHilbras handles provider selection behind the endpoint, so your product can focus on the user.
            </p>
            <ul className="mt-7 space-y-3.5">
              {[
                'OpenAI-compatible request and response shapes',
                'Streaming passthrough for responsive interfaces',
                'Per-request overrides when you need control',
              ].map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-sm">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-gold" aria-hidden="true" />
                  <span className="muted">{item}</span>
                </li>
              ))}
            </ul>
            <a href="#start" className="btn-ghost mt-8">
              <BookOpen className="h-4 w-4" aria-hidden="true" />
              Read the getting started guide
            </a>
          </motion.div>
        </motion.div>

        <motion.div
          initial={false}
          whileInView={{ opacity: 1, y: 0, scale: 1 }}
          viewport={viewport}
          transition={{ duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
          className="overflow-hidden rounded-2xl border border-line bg-[#0d0c09] shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
            <div className="flex items-center gap-1.5" aria-hidden="true">
              <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
            </div>
            <div className="flex rounded-lg border border-white/10 bg-white/5 p-0.5" role="tablist" aria-label="Code language">
              {(['curl', 'typescript'] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  aria-selected={language === item}
                  onClick={() => setLanguage(item)}
                  className={`rounded-md px-2.5 py-1 font-mono text-[10px] transition-colors ${
                    language === item ? 'bg-white/10 text-[#f3d789]' : 'text-[#8c8575] hover:text-[#e6c768]'
                  }`}
                >
                  {item === 'typescript' ? 'TypeScript' : 'cURL'}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => void copyCode()}
              aria-label={copied ? 'Code copied' : 'Copy code'}
              className="grid h-7 w-7 place-items-center rounded-md text-[#8c8575] transition-colors hover:bg-white/10 hover:text-[#f3d789]"
            >
              {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
            </button>
          </div>
          <div className="overflow-x-auto px-4 py-5 sm:px-6">
            <pre className="min-w-[560px] font-mono text-[11px] leading-[1.85] sm:text-xs">
              <code>
                {code.split('\n').map((line, index) => (
                  <span key={`${line}-${index}`} className="flex">
                    <span className="mr-5 w-5 shrink-0 select-none text-right text-[#8c8575]">{String(index + 1).padStart(2, '0')}</span>
                    <span className={line.includes('Authorization') || line.includes('model') ? 'text-[#83b7ff]' : line.includes('https') || line.includes('fetch') ? 'text-[#e6c768]' : 'text-[#b5ad9d]'}>
                      {line || ' '}
                    </span>
                  </span>
                ))}
              </code>
            </pre>
          </div>
          <div className="flex items-center justify-between border-t border-white/10 px-4 py-3 font-mono text-[10px] text-[#8c8575] sm:px-6">
            <span>omnihilbras-client.ts</span>
            <span className="flex items-center gap-1.5 text-[#7fd88f]"><span className="h-1.5 w-1.5 rounded-full bg-[#7fd88f]" />ready to route</span>
          </div>
        </motion.div>
      </div>
    </section>
  );
}

function ObservabilitySection() {
  return (
    <section id="observability" className="border-y border-line bg-bg-soft/55">
      <div className="mx-auto grid max-w-6xl items-center gap-10 px-5 py-16 sm:py-24 lg:grid-cols-[0.78fr_1.22fr] lg:gap-16">
        <motion.div
          variants={revealContainer}
          initial={false}
          whileInView="show"
          viewport={viewport}
        >
          <motion.div variants={revealItem}>
            <span className="eyebrow">No black box</span>
            <h2 className="section-title mt-5">See the decision, not just the answer.</h2>
            <p className="muted mt-4 text-sm leading-relaxed sm:text-base">
              Every request should tell you where it went, why it went there, and what it cost. OmniHilbras makes routing observable by default.
            </p>
            <div className="mt-7 space-y-4">
              {[
                { icon: Activity, title: 'Live request traces', body: 'Follow a request from policy to provider and back.' },
                { icon: Gauge, title: 'Useful metrics', body: 'Track latency, retries, spend, and provider health.' },
                { icon: CircleHelp, title: 'Human-readable reasons', body: 'Know when a fallback happened and what triggered it.' },
              ].map(({ icon: Icon, title, body }) => (
                <div key={title} className="flex gap-3">
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-gold-text" aria-hidden="true" />
                  <div>
                    <p className="text-sm font-semibold">{title}</p>
                    <p className="muted mt-1 text-xs leading-relaxed">{body}</p>
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        </motion.div>

        <motion.div
          initial={false}
          whileInView={{ opacity: 1, y: 0, scale: 1 }}
          viewport={viewport}
          transition={{ duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
          className="card overflow-hidden"
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-4 sm:px-5">
            <div>
              <p className="text-sm font-semibold">Request activity</p>
              <p className="muted mt-1 font-mono text-[10px]">last 15 minutes · all routes</p>
            </div>
            <span className="flex items-center gap-1.5 rounded-full border border-success/25 bg-success/10 px-2.5 py-1 font-mono text-[10px] text-success">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" /> live
            </span>
          </div>
          <div className="grid grid-cols-3 border-b border-line bg-surface-2/60">
            <div className="px-4 py-3 sm:px-5">
              <span className="mono-label">requests</span>
              <strong className="mt-1 block font-mono text-lg">18.4k</strong>
            </div>
            <div className="border-x border-line px-4 py-3 sm:px-5">
              <span className="mono-label">p95 latency</span>
              <strong className="mt-1 block font-mono text-lg">412<span className="text-xs text-muted">ms</span></strong>
            </div>
            <div className="px-4 py-3 sm:px-5">
              <span className="mono-label">success</span>
              <strong className="mt-1 block font-mono text-lg text-success">99.98%</strong>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[580px] text-left text-xs">
              <thead className="border-b border-line bg-surface-2/40">
                <tr className="mono-label">
                  <th className="px-4 py-3 font-normal sm:px-5">route</th>
                  <th className="px-3 py-3 font-normal">provider</th>
                  <th className="px-3 py-3 font-normal">latency</th>
                  <th className="px-3 py-3 font-normal">status</th>
                </tr>
              </thead>
              <tbody>
                {requestRows.map((row) => (
                  <tr key={`${row.path}-${row.provider}-${row.model}`} className="border-b border-line/70 last:border-0">
                    <td className="px-4 py-3 font-mono text-[10px] text-muted sm:px-5">{row.path}</td>
                    <td className="px-3 py-3">
                      <span className="block text-xs font-medium">{row.provider}</span>
                      <span className="muted block font-mono text-[10px]">{row.model}</span>
                    </td>
                    <td className="px-3 py-3 font-mono text-[10px] text-muted">{row.latency}</td>
                    <td className="px-3 py-3"><span className="rounded-full bg-success/10 px-2 py-1 font-mono text-[10px] text-success">{row.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-line px-4 py-3 sm:px-5">
            <span className="muted flex items-center gap-2 text-[11px]"><Clock3 className="h-3.5 w-3.5" aria-hidden="true" />Updated just now</span>
            <a href="#start" className="btn-quiet !px-2 !py-1 text-[11px]">Open dashboard <ChevronRight className="h-3 w-3" aria-hidden="true" /></a>
          </div>
        </motion.div>
      </div>
    </section>
  );
}

function ClosingCta() {
  return (
    <section id="start" className="mx-auto max-w-6xl px-5 py-16 sm:py-24">
      <motion.div
        initial={false}
        whileInView={{ opacity: 1, y: 0, scale: 1 }}
        viewport={viewport}
        transition={{ duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
        className="card relative overflow-hidden px-6 py-12 text-center sm:px-10 sm:py-16"
      >
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 -top-32 h-64 opacity-60 blur-3xl" style={{ background: 'radial-gradient(ellipse, var(--glow), transparent 70%)' }} />
        <div className="relative">
          <span className="eyebrow">The first release is taking shape</span>
          <h2 className="section-title mx-auto mt-5 max-w-2xl">Keep your options <span className="gold-text">open.</span></h2>
          <p className="muted mx-auto mt-4 max-w-lg text-sm leading-relaxed sm:text-base">
            OmniHilbras is being built for teams that want more leverage from every model without giving up control of the stack.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <a href="#docs" className="btn-gold">
              Explore the API shape
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </a>
            <a href="#how-it-works" className="btn-ghost">
              See how it works
            </a>
          </div>
          <div className="muted mt-7 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 font-mono text-[10px]">
            <span className="flex items-center gap-1.5"><Sparkles className="h-3 w-3 text-gold" aria-hidden="true" />Early preview</span>
            <span className="flex items-center gap-1.5"><LockKeyhole className="h-3 w-3 text-gold" aria-hidden="true" />Local-first</span>
            <span className="flex items-center gap-1.5"><Braces className="h-3 w-3 text-gold" aria-hidden="true" />Developer-friendly</span>
          </div>
        </div>
      </motion.div>
    </section>
  );
}

function App() {
  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-screen overflow-x-clip">
        <ParticleBackground />
        <Navbar />

        <main id="main">
          <section className="relative overflow-hidden border-b border-line/70">
            <div aria-hidden="true" className="bg-glow absolute inset-x-0 top-0 h-[620px] opacity-70" />
            <div aria-hidden="true" className="grid-wash absolute inset-x-0 top-0 h-[620px] opacity-35" />
            <div className="relative mx-auto max-w-6xl px-5 pb-16 pt-16 sm:pb-24 sm:pt-24">
              <motion.div
                variants={revealContainer}
                initial={false}
                animate="show"
                className="text-center"
              >
                <motion.span variants={revealItem} className="eyebrow">
                  <span className="eyebrow-dot" aria-hidden="true" />
                  Self-hosted AI infrastructure · early preview
                </motion.span>
                <motion.h1 variants={revealItem} className="mx-auto mt-6 max-w-4xl text-[clamp(42px,8vw,76px)] font-extrabold leading-[0.98] tracking-[-0.055em]">
                  One route to <span className="gold-text">every model.</span>
                </motion.h1>
                <motion.p variants={revealItem} className="muted mx-auto mt-6 max-w-2xl text-base leading-relaxed sm:text-lg">
                  OmniHilbras is the intelligent gateway between your applications and the model providers you choose. One clean endpoint, smarter routing, fewer surprises.
                </motion.p>
                <motion.div variants={revealItem} className="mt-8 flex flex-wrap items-center justify-center gap-3">
                  <a href="#start" className="btn-gold">
                    Start routing
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </a>
                  <a href="#how-it-works" className="btn-ghost">
                    See how it works
                  </a>
                </motion.div>
                <motion.div variants={revealItem} className="muted mt-7 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 font-mono text-[10px] uppercase tracking-[0.12em]">
                  <span className="flex items-center gap-1.5"><CheckCircle2 className="h-3 w-3 text-gold" aria-hidden="true" />Provider agnostic</span>
                  <span className="flex items-center gap-1.5"><CheckCircle2 className="h-3 w-3 text-gold" aria-hidden="true" />BYOK by default</span>
                  <span className="flex items-center gap-1.5"><CheckCircle2 className="h-3 w-3 text-gold" aria-hidden="true" />Self-hostable</span>
                </motion.div>
              </motion.div>

              <motion.div
                initial={false}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ duration: 0.75, delay: 0.35, ease: [0.22, 1, 0.36, 1] }}
                className="mx-auto mt-12 max-w-4xl sm:mt-16"
              >
                <RoutePreview />
              </motion.div>
            </div>
            <div className="hairline" />
          </section>

          <LogoStrip />
          <ProductSection />
          <HowItWorks />
          <DocsSection />
          <ObservabilitySection />
          <ClosingCta />
        </main>

        <Footer />
      </div>
    </MotionConfig>
  );
}

export default App;
