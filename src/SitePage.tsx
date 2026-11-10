import type { ReactNode } from 'react';
import { version } from 'virtual:omnihilbras-version';
import { ArrowUpRight, CheckCircle2, ExternalLink, GitBranch, LockKeyhole, Server, ShieldCheck } from 'lucide-react';
import { Footer } from './components/Footer';
import { Navbar } from './components/Navbar';
import { ParticleBackground } from './components/ParticleBackground';
import { ScrollProgress } from './components/ScrollProgress';

const SPEC = 'https://github.com/Hilbras/OmniHilbras/blob/main/docs/SPEC-SDK.md';
const GITHUB = 'https://github.com/Hilbras/OmniHilbras';
const RELEASES = `${GITHUB}/releases`;

function PageShell({ eyebrow, title, lead, children }: { eyebrow: string; title: string; lead: string; children: ReactNode }) {
  return (
    <div className="page-enter min-h-screen overflow-x-clip">
      <ScrollProgress />
      <ParticleBackground />
      <Navbar />
      <main id="main" className="relative overflow-hidden border-b border-line/70">
        <div aria-hidden="true" className="bg-glow slow-drift absolute inset-x-0 top-0 h-[460px] opacity-60" />
        <div aria-hidden="true" className="grid-wash absolute inset-x-0 top-0 h-[460px] opacity-30" />
        <div className="relative mx-auto max-w-4xl px-5 pb-16 pt-14 sm:pb-24 sm:pt-20">
          <a href="/home" className="muted inline-flex items-center gap-1.5 text-xs transition-colors hover:text-gold-text">
            ← Back to home
          </a>
          <header className="mt-8 max-w-3xl">
            <span className="eyebrow">{eyebrow}</span>
            <h1 className="section-title mt-5">{title}</h1>
            <p className="muted mt-4 max-w-2xl text-sm leading-relaxed sm:text-base">{lead}</p>
          </header>
          <div className="mt-10 space-y-5">{children}</div>
        </div>
      </main>
      <Footer />
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card p-6">
      <h2 className="text-lg font-semibold tracking-[-0.02em]">{title}</h2>
      <div className="muted mt-3 space-y-3 text-sm leading-relaxed">{children}</div>
    </section>
  );
}

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-xl border border-line bg-bg-soft p-4 font-mono text-[11px] leading-relaxed text-text">
      <code>{children}</code>
    </pre>
  );
}

function DocsPage() {
  return (
    <PageShell
      eyebrow={`Documentation · v${version}`}
      title="One local endpoint for every provider."
      lead="The gateway speaks the OpenAI chat-completions shape and adds health-aware routing, failover and token accounting. Point an existing client at loopback and keep the interface it already knows."
    >
      <Card title="Quick start">
        <p>Start the desktop app or run the gateway on its own, then send an OpenAI-compatible request:</p>
        <Code>{`curl http://127.0.0.1:8787/v1/chat/completions \\
  -H "Authorization: Bearer $OMNIHILBRAS_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "auto",
    "messages": [{ "role": "user", "content": "Hello" }]
  }'`}</Code>
        <p>When API-key enforcement is off, the <code className="font-mono">Authorization</code> header is optional. When it is on, the dashboard can mint and revoke keys.</p>
      </Card>
      <Card title="Core endpoints">
        <ul className="space-y-2">
          <li><code className="font-mono">POST /v1/chat/completions</code> — chat, streaming and tool calls through the selected provider.</li>
          <li><code className="font-mono">GET /v1/models</code> — the saved models of enabled, credentialed connections.</li>
          <li><code className="font-mono">POST /v1/messages/count_tokens</code> — an explicit bytes/4 estimate, marked as estimated.</li>
          <li><code className="font-mono">GET /health</code> — gateway and provider health, with a reason for every unavailable provider.</li>
          <li><code className="font-mono">GET /v1/token-saver/stats</code> — per-saver savings and cache figures.</li>
        </ul>
        <p><a className="text-gold-text hover:underline" href={SPEC} target="_blank" rel="noreferrer">Read the full gateway specification <ExternalLink className="inline h-3 w-3" aria-hidden="true" /></a></p>
      </Card>
      <Card title="Configuration">
        <p>The gateway is configured by environment variables. The ones you are most likely to change:</p>
        <Code>{`OMNIHILBRAS_PORT=8787
OMNIHILBRAS_TOKEN_SAVER=1
OMNIHILBRAS_MAX_OUTPUT_TOKENS=8192
OMNIHILBRAS_HISTORY_TRIM_TOKENS=120000
OMNIHILBRAS_CACHE_ANCHOR=1`}</Code>
        <p>Every value is local. No provider credential is sent to a browser store, and the vault lives under <code className="font-mono">$XDG_CONFIG_HOME/omnihilbras</code>.</p>
      </Card>
      <Card title="Clients">
        <p>Any OpenAI-compatible client works: set the base URL to <code className="font-mono">http://127.0.0.1:8787/v1</code> and choose a saved model, or use <code className="font-mono">model: "auto"</code> to let the gateway resolve a connection.</p>
        <p><a className="text-gold-text hover:underline" href="/download">Download the desktop app</a> or <a className="text-gold-text hover:underline" href={GITHUB} target="_blank" rel="noreferrer">build from source</a>.</p>
      </Card>
    </PageShell>
  );
}

function AboutPage() {
  return (
    <PageShell
      eyebrow="About"
      title="A gateway you can keep on your own machine."
      lead="OmniHilbras is a local-first AI gateway: one OpenAI-compatible endpoint in front of the providers you already use, with routing, failover, usage accounting and a desktop dashboard."
    >
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { icon: LockKeyhole, title: 'Local by default', body: 'The gateway binds to loopback. Keys stay in an encrypted vault on your machine.' },
          { icon: Server, title: 'Provider-neutral', body: 'Provider wire formats live in their adapters, not in the gateway core.' },
          { icon: GitBranch, title: 'Open source', body: 'MIT licensed. Build it, audit it, or run it from the packaged desktop app.' },
        ].map(({ icon: Icon, title, body }) => (
          <div key={title} className="card p-5">
            <Icon className="h-4 w-4 text-gold-text" aria-hidden="true" />
            <h2 className="mt-3 text-sm font-semibold">{title}</h2>
            <p className="muted mt-1.5 text-xs leading-relaxed">{body}</p>
          </div>
        ))}
      </div>
      <Card title="What it does">
        <p>OmniHilbras resolves a model to a saved connection, checks health and credentials, then sends the request in the provider's own shape. If a connection is unhealthy or rate-limited, the next one can take the request. The client keeps one stable endpoint.</p>
        <p>Usage is recorded locally. The dashboard shows requests, tokens, cache reads and writes, and the savers that actually ran. A saver that could not perform its check is reported as skipped, not as a saving.</p>
      </Card>
      <Card title="Status">
        <p>Current release: <strong>v{version}</strong>. The desktop app is available for Windows and Linux; the macOS build is produced by CI. This is an early, actively changing project, and the <a className="text-gold-text hover:underline" href={`${GITHUB}/releases`} target="_blank" rel="noreferrer">release notes</a> say what changed.</p>
      </Card>
    </PageShell>
  );
}

function PricingPage() {
  return (
    <PageShell
      eyebrow="Pricing"
      title="Free, open source, and yours to run."
      lead="There is no paid tier and no per-request markup today. You pay your model providers directly, and OmniHilbras stays on your machine."
    >
      <section className="card relative overflow-hidden p-6 sm:p-8">
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 -top-24 h-48 opacity-70 blur-3xl" style={{ background: 'radial-gradient(ellipse, var(--glow), transparent 70%)' }} />
        <div className="relative">
          <span className="eyebrow">Self-hosted</span>
          <p className="mt-5 font-mono text-4xl font-bold tracking-tight">$0</p>
          <p className="muted mt-2 text-sm">MIT license. No account required.</p>
          <ul className="mt-6 space-y-2.5 text-sm">
            {['One OpenAI-compatible endpoint', 'Bring your own provider keys', 'Unlimited local connections', 'Desktop app for Windows and Linux', 'Gateway source available on GitHub'].map((item) => (
              <li key={item} className="flex items-start gap-2.5"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-gold" aria-hidden="true" /><span>{item}</span></li>
            ))}
          </ul>
          <div className="mt-7 flex flex-wrap gap-3">
            <a href="/download" className="btn-gold">Download the app</a>
            <a href={GITHUB} target="_blank" rel="noreferrer" className="btn-ghost">View source <ArrowUpRight className="h-4 w-4" aria-hidden="true" /></a>
          </div>
        </div>
      </section>
      <Card title="What costs money">
        <p>Your provider bills. Tokens, images, audio and web sessions are charged by the provider you connect. OmniHilbras does not add a fee or proxy your payment.</p>
        <p>Running the app costs only the machine it runs on. The gateway is a local Node process; the dashboard is local too.</p>
      </Card>
    </PageShell>
  );
}

function ChangelogPage() {
  return (
    <PageShell
      eyebrow="Changelog"
      title="What changed, in releases."
      lead="Release notes live on GitHub so every version has one canonical page. The desktop app checks the same feed for updates."
    >
      <Card title={`v${version} — the first desktop release`}>
        <ul className="space-y-2">
          <li>Desktop app with local gateway lifecycle, logs, provider connections and encrypted backup import/export.</li>
          <li>Cache-aware token accounting across the gateway and provider adapters.</li>
          <li>Token Saver: RTK filters, history trimming, output and thinking caps, count_tokens, Anthropic cache anchoring, and optional external savers.</li>
          <li>Version 3.0.0 across the workspace.</li>
        </ul>
        <p><a className="text-gold-text hover:underline" href={RELEASES} target="_blank" rel="noreferrer">All releases and checksums <ExternalLink className="inline h-3 w-3" aria-hidden="true" /></a></p>
      </Card>
      <Card title="Earlier versions">
        <p>The repository history and release feed carry the full trail. A version is only listed here when it has a release page, so this page never invents a changelog entry.</p>
      </Card>
    </PageShell>
  );
}

function SecurityPage() {
  return (
    <PageShell
      eyebrow="Security"
      title="Local surface, narrow boundaries."
      lead="The gateway is designed to run on loopback, keep credentials out of browser storage, and fail closed when a request cannot be verified."
    >
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { icon: Server, title: 'Loopback', body: 'The gateway binds to 127.0.0.1 by default. A non-loopback host is refused unless explicitly configured.' },
          { icon: LockKeyhole, title: 'Vault', body: 'Provider credentials live in an encrypted local vault, never in localStorage or a cookie.' },
          { icon: ShieldCheck, title: 'Honest failures', body: 'A provider check that cannot run is reported as skipped, not as a successful verification.' },
        ].map(({ icon: Icon, title, body }) => (
          <div key={title} className="card p-5">
            <Icon className="h-4 w-4 text-gold-text" aria-hidden="true" />
            <h2 className="mt-3 text-sm font-semibold">{title}</h2>
            <p className="muted mt-1.5 text-xs leading-relaxed">{body}</p>
          </div>
        ))}
      </div>
      <Card title="Reporting a vulnerability">
        <p>Do not open a public issue with a live key or an exploit. Use GitHub's private vulnerability reporting on the repository, or read <a className="text-gold-text hover:underline" href={`${GITHUB}/blob/main/SECURITY.md`} target="_blank" rel="noreferrer">SECURITY.md</a> for the current contact path.</p>
        <p>Provider credentials and gateway keys belong in the local vault or a local environment variable. Never paste them into an issue, a commit, or a chat message.</p>
      </Card>
      <Card title="What leaves the machine">
        <p>Only the provider request you asked for. The dashboard and gateway do not send telemetry. The marketing site is static and does not run analytics scripts. The hosting provider may keep standard access logs for the site itself.</p>
      </Card>
    </PageShell>
  );
}

function PrivacyPage() {
  return (
    <PageShell
      eyebrow="Privacy"
      title="Your prompts stay between you and your provider."
      lead="OmniHilbras has no account system and no telemetry pipeline. The gateway runs on your machine; the dashboard reads local state."
    >
      <Card title="What the app stores">
        <p>Connection metadata, an encrypted credential vault, usage records, API-key hashes and settings are stored in your local data directory. Usage records contain counts and routing metadata, not prompt text or credentials.</p>
        <p>You can export an encrypted backup and import it on another machine. The passphrase is not stored; a lost passphrase cannot be recovered.</p>
      </Card>
      <Card title="What the site stores">
        <p>The marketing site is static. It does not set an account cookie and does not run an analytics script. The hosting provider may keep standard request logs (IP, path, user agent) to operate the service.</p>
      </Card>
      <Card title="What your provider receives">
        <p>Only the request the gateway sends on your behalf, to the provider you connected. That provider's terms and privacy policy apply to it. OmniHilbras does not add a second data collector in the middle.</p>
      </Card>
    </PageShell>
  );
}

function NotFoundPage() {
  return (
    <PageShell eyebrow="404" title="That page is not here." lead="The route may have moved. Start from home, or open the documentation.">
      <div className="flex flex-wrap gap-3">
        <a href="/home" className="btn-gold">Back to home</a>
        <a href="/docs" className="btn-ghost">Documentation</a>
      </div>
    </PageShell>
  );
}

const pages: Record<string, () => ReactNode> = {
  '/docs': DocsPage,
  '/about': AboutPage,
  '/pricing': PricingPage,
  '/changelog': ChangelogPage,
  '/security': SecurityPage,
  '/privacy': PrivacyPage,
};

export default function SitePage() {
  const path = typeof window === 'undefined' ? '' : window.location.pathname.replace(/\/+$/, '') || '/home';
  const Page = pages[path] ?? NotFoundPage;
  return <Page />;
}
