"use client";

import { useState } from "react";
import Link from "next/link";
import Navbar from "./components/Navbar";
import ParticleBackground from "./components/ParticleBackground";
import RoutePreview from "./components/RoutePreview";
import Footer from "./components/Footer";
import Reveal from "./components/Reveal";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Braces,
  Check,
  CheckCircle2,
  Code2,
  Copy,
  Fingerprint,
  Gauge,
  LockKeyhole,
  Network,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Workflow,
} from "./components/Icons";

const providers = ["OpenAI", "Anthropic", "Google", "Mistral", "Groq", "Ollama", "OpenRouter", "DeepSeek"];

const features = [
  {
    icon: Network,
    label: "Unified surface",
    title: "One endpoint. Every model.",
    body: "Keep your application code stable while providers, models, and regions change underneath it.",
    detail: "OpenAI-compatible by default",
  },
  {
    icon: SlidersHorizontal,
    label: "Priority routing",
    title: "You choose the order.",
    body: "Set a priority on each connection and the gateway serves them in that order, skipping any that are unhealthy, rate-limited, or missing a credential.",
    detail: "Deterministic, with health-aware failover",
  },
  {
    icon: ShieldCheck,
    label: "Resilient by design",
    title: "Fail over before users notice.",
    body: "Health checks, retries, and graceful fallback keep a slow provider from becoming a broken product.",
    detail: "Automatic recovery paths",
  },
];

const steps = [
  {
    number: "01",
    icon: Server,
    title: "Connect your providers",
    body: "Bring API keys for the services you already use, or start with a local Ollama endpoint.",
  },
  {
    number: "02",
    icon: Workflow,
    title: "Define the policy",
    body: "Set a priority on each connection. The gateway serves them in order, skipping any that are unhealthy, rate-limited, or missing a credential.",
  },
  {
    number: "03",
    icon: Code2,
    title: "Ship one clean request",
    body: "Point your app at OmniHilbras and keep the same interface while the routing layer gets smarter.",
  },
];

const codeSamples = {
  curl: `curl http://127.0.0.1:8787/v1/chat/completions \\
  -H "Authorization: Bearer $OMNIHILBRAS_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "auto",
    "messages": [{ "role": "user", "content": "Hello" }]
  }'`,
  typescript: `const response = await fetch(
  'http://127.0.0.1:8787/v1/chat/completions',
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
};

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
          style={{ backgroundImage: "linear-gradient(to right, var(--color-bg-alt), transparent)" }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 z-10 w-20"
          style={{ backgroundImage: "linear-gradient(to left, var(--color-bg-alt), transparent)" }}
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
      <Reveal className="text-center">
        <span className="eyebrow">
          <span className="eyebrow-dot" aria-hidden="true" />
          A calmer model layer
        </span>
        <h2 className="section-title mx-auto mt-5 max-w-2xl">Keep control of the route.</h2>
        <p className="muted mx-auto mt-4 max-w-xl text-sm leading-relaxed sm:text-base">
          OmniHilbras turns provider choice into an intentional product decision—not a config file written in a hurry.
        </p>
      </Reveal>

      <div className="mt-10 grid gap-4 md:grid-cols-3">
        {features.map(({ icon: Icon, label, title, body, detail }, index) => (
          <Reveal key={title} variant="reveal-card" delay={index * 90}>
            <article className="card group relative overflow-hidden p-6 h-full">
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
            </article>
          </Reveal>
        ))}
      </div>

      <Reveal className="mt-5">
        <div className="flex flex-col items-start justify-between gap-4 rounded-2xl border border-gold/25 bg-gold-soft/60 px-5 py-4 sm:flex-row sm:items-center sm:px-6">
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
        </div>
      </Reveal>
    </section>
  );
}

function HowItWorks() {
  return (
    <section id="how-it-works" className="border-y border-line bg-bg-soft/55">
      <div className="mx-auto max-w-6xl px-5 py-16 sm:py-24">
        <Reveal className="mb-10 text-center">
          <span className="eyebrow">How it works</span>
          <h2 className="section-title mt-5">From provider sprawl to one clear path.</h2>
          <p className="muted mx-auto mt-4 max-w-lg text-sm leading-relaxed">
            OmniHilbras sits beside your app, not in the way of it. Start small and make the routing policy as expressive as you need.
          </p>
        </Reveal>

        <div className="grid gap-4 md:grid-cols-3">
          {steps.map(({ number, icon: Icon, title, body }, index) => (
            <Reveal key={number} variant="reveal-card" delay={index * 90}>
              <article className="card relative p-6 h-full">
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
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function DocsSection() {
  const [language, setLanguage] = useState("curl");
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
        <Reveal>
          <span className="eyebrow">A familiar interface</span>
          <h2 className="section-title mt-5">A better default, not a new abstraction.</h2>
          <p className="muted mt-4 text-sm leading-relaxed sm:text-base">
            Keep the request shape your team already knows. OmniHilbras handles provider selection behind the endpoint, so your product can focus on the user.
          </p>
          <ul className="mt-7 space-y-3.5">
            {[
              "OpenAI-compatible request and response shapes",
              "Streaming passthrough for responsive interfaces",
              "Per-request overrides when you need control",
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
        </Reveal>

        <Reveal delay={120}>
          <div className="overflow-hidden rounded-2xl border border-line bg-[#0d0c09] shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <div className="flex items-center gap-1.5" aria-hidden="true">
                <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
              </div>
              <div className="flex rounded-lg border border-white/10 bg-white/5 p-0.5" role="tablist" aria-label="Code language">
                {["curl", "typescript"].map((item) => (
                  <button
                    key={item}
                    type="button"
                    role="tab"
                    aria-selected={language === item}
                    onClick={() => setLanguage(item)}
                    className={`rounded-md px-2.5 py-1 font-mono text-[10px] transition-colors ${
                      language === item ? "bg-white/10 text-[#f3d789]" : "text-[#8c8575] hover:text-[#e6c768]"
                    }`}
                  >
                    {item === "typescript" ? "TypeScript" : "cURL"}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => void copyCode()}
                aria-label={copied ? "Code copied" : "Copy code"}
                className="grid h-7 w-7 place-items-center rounded-md text-[#8c8575] transition-colors hover:bg-white/10 hover:text-[#f3d789]"
              >
                {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
              </button>
            </div>
            <div className="overflow-x-auto px-4 py-5 sm:px-6">
              <pre className="min-w-[560px] font-mono text-[11px] leading-[1.85] sm:text-xs">
                <code>
                  {code.split("\n").map((line, index) => (
                    <span key={`${line}-${index}`} className="flex">
                      <span className="mr-5 w-5 shrink-0 select-none text-right text-[#8c8575]">{String(index + 1).padStart(2, "0")}</span>
                      <span className={line.includes("Authorization") || line.includes("model") ? "text-[#83b7ff]" : line.includes("https") || line.includes("fetch") ? "text-[#e6c768]" : "text-[#b5ad9d]"}>
                        {line || " "}
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
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function ObservabilitySection() {
  return (
    <section id="observability" className="border-y border-line bg-bg-soft/55">
      <div className="mx-auto grid max-w-6xl items-center gap-10 px-5 py-16 sm:py-24 lg:grid-cols-[0.78fr_1.22fr] lg:gap-16">
        <Reveal>
          <span className="eyebrow">No black box</span>
          <h2 className="section-title mt-5">See the decision, not just the answer.</h2>
          <p className="muted mt-4 text-sm leading-relaxed sm:text-base">
            Every response says which provider served it, under which request id, and what was tried
            before it. When a request fails, the reason is named rather than swallowed — and when a
            provider is skipped, the skip has a reason too. OmniHilbras makes routing observable by
            default.
          </p>
          <div className="mt-7 space-y-4">
            {[
              { icon: Fingerprint, title: "A request id on every response", body: "Every reply carries gateway.requestId, and the providers that were tried before it." },
              { icon: Activity, title: "Named reasons, never generic errors", body: "A skip is one of unhealthy, rate-limited, no-credential, no-models or disabled — not a silent fallback." },
              { icon: Gauge, title: "Health that changes routing", body: "Connections are polled; consecutive failures mark one unhealthy and routing stops choosing it, recording why." },
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
        </Reveal>
      </div>
    </section>
  );
}

function ClosingCta() {
  return (
    <section id="start" className="mx-auto max-w-6xl px-5 py-16 sm:py-24">
      <Reveal>
        <div className="card relative overflow-hidden px-6 py-12 text-center sm:px-10 sm:py-16">
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 -top-32 h-64 opacity-60 blur-3xl" style={{ background: "radial-gradient(ellipse, var(--glow), transparent 70%)" }} />
          <div className="relative">
            <span className="eyebrow">The first release is taking shape</span>
            <h2 className="section-title mx-auto mt-5 max-w-2xl">Keep your options <span className="gold-text">open.</span></h2>
            <p className="muted mx-auto mt-4 max-w-lg text-sm leading-relaxed sm:text-base">
              OmniHilbras is being built for teams that want more leverage from every model without giving up control of the stack.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Link href="/dashboard" className="btn-gold">
                Open the dashboard
                <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              </Link>
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
        </div>
      </Reveal>
    </section>
  );
}

export default function LandingPage() {
  return (
    <div className="page-enter min-h-screen overflow-x-clip bg-bg text-text">
      <ParticleBackground />
      <Navbar />

      <main id="main">
        <section className="relative overflow-hidden border-b border-line/70">
          <div aria-hidden="true" className="bg-glow absolute inset-x-0 top-0 h-[620px] opacity-70" />
          <div aria-hidden="true" className="grid-wash absolute inset-x-0 top-0 h-[620px] opacity-35" />
          <div className="relative mx-auto max-w-6xl px-5 pb-16 pt-16 sm:pb-24 sm:pt-24">
            <div className="text-center">
              <Reveal>
                <span className="eyebrow">
                  <span className="eyebrow-dot" aria-hidden="true" />
                  Self-hosted AI infrastructure · early preview
                </span>
              </Reveal>
              <Reveal delay={90}>
                <h1 className="mx-auto mt-6 max-w-4xl text-[clamp(42px,8vw,76px)] font-extrabold leading-[0.98] tracking-[-0.055em]">
                  One route to <span className="gold-text">every model.</span>
                </h1>
              </Reveal>
              <Reveal delay={180}>
                <p className="muted mx-auto mt-6 max-w-2xl text-base leading-relaxed sm:text-lg">
                  OmniHilbras is the intelligent gateway between your applications and the model providers you choose. One clean endpoint, smarter routing, fewer surprises.
                </p>
              </Reveal>
              <Reveal delay={270}>
                <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                  <a href="#start" className="btn-gold">
                    Start routing
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </a>
                  <a href="#how-it-works" className="btn-ghost">
                    See how it works
                  </a>
                </div>
              </Reveal>
              <Reveal delay={360}>
                <div className="muted mt-7 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 font-mono text-[10px] uppercase tracking-[0.12em]">
                  <span className="flex items-center gap-1.5"><CheckCircle2 className="h-3 w-3 text-gold" aria-hidden="true" />Provider agnostic</span>
                  <span className="flex items-center gap-1.5"><CheckCircle2 className="h-3 w-3 text-gold" aria-hidden="true" />BYOK by default</span>
                  <span className="flex items-center gap-1.5"><CheckCircle2 className="h-3 w-3 text-gold" aria-hidden="true" />Self-hostable</span>
                </div>
              </Reveal>
            </div>

            <Reveal delay={450} className="mx-auto mt-12 max-w-4xl sm:mt-16">
              <RoutePreview />
            </Reveal>
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
  );
}
