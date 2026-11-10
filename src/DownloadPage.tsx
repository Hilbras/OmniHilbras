import { Apple, ArrowLeft, ArrowUpRight, CheckCircle2, Download, Monitor, ShieldCheck, Terminal } from 'lucide-react';
import { version } from 'virtual:omnihilbras-version';
import { Footer } from './components/Footer';
import { Navbar } from './components/Navbar';
import { ParticleBackground } from './components/ParticleBackground';
import { ScrollProgress } from './components/ScrollProgress';

const RELEASES = 'https://github.com/Hilbras/OmniHilbras/releases/latest';

const platforms = [
  {
    id: 'windows',
    icon: Monitor,
    name: 'Windows',
    detail: 'Windows 10/11 · x64',
    action: 'Download for Windows',
    href: `${RELEASES}/download/OmniHilbras-Setup.exe`,
    secondary: null,
    available: true,
    note: 'NSIS installer. The build is not code-signed yet, so SmartScreen may ask you to confirm.',
  },
  {
    id: 'linux',
    icon: Terminal,
    name: 'Linux',
    detail: 'AppImage or Debian · amd64',
    action: 'Download AppImage',
    href: `${RELEASES}/download/OmniHilbras-linux-amd64.AppImage`,
    secondary: { label: 'Or download the .deb', href: `${RELEASES}/download/OmniHilbras-linux-amd64.deb` },
    available: true,
    note: 'The AppImage updates itself from Settings. The .deb is for apt and must be upgraded manually.',
  },
  {
    id: 'macos',
    icon: Apple,
    name: 'macOS',
    detail: 'Apple silicon and Intel',
    action: 'Open release page',
    href: RELEASES,
    secondary: null,
    available: false,
    note: 'The macOS build is produced on a macOS CI runner. Open the release page for the available builds.',
  },
] as const;

function detectPlatform() {
  if (typeof navigator === 'undefined') return undefined;
  const agent = navigator.userAgent;
  if (/Windows/i.test(agent)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(agent)) return 'macos';
  if (/Linux/i.test(agent) && !/Android/i.test(agent)) return 'linux';
  return undefined;
}

export default function DownloadPage() {
  const detected = detectPlatform();

  return (
    <div className="page-enter min-h-screen overflow-x-clip">
      <ScrollProgress />
      <ParticleBackground />
      <Navbar />

      <main id="main" className="relative overflow-hidden border-b border-line/70">
        <div aria-hidden="true" className="bg-glow absolute inset-x-0 top-0 h-[560px] opacity-70" />
        <div aria-hidden="true" className="grid-wash absolute inset-x-0 top-0 h-[560px] opacity-35" />
        <div className="relative mx-auto max-w-5xl px-5 pb-16 pt-14 sm:pb-24 sm:pt-20">
          <a href="/home" className="muted inline-flex items-center gap-1.5 text-xs transition-colors hover:text-gold-text">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Back to home
          </a>

          <div className="mx-auto mt-8 max-w-3xl text-center">
            <span className="eyebrow">
              <span className="eyebrow-dot" aria-hidden="true" />
              Desktop app · v{version}
            </span>
            <h1 className="section-title mx-auto mt-5 max-w-2xl">Download OmniHilbras.</h1>
            <p className="muted mx-auto mt-4 max-w-xl text-sm leading-relaxed sm:text-base">
              The app owns the gateway: start and stop the local server, watch the log, connect providers,
              and keep your keys on this machine.
            </p>
          </div>

          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {platforms.map(({ id, icon: Icon, name, detail, action, href, secondary, available, note }) => {
              const primary = detected === id;
              return (
                <article key={id} className={`card lift flex flex-col p-6 ${primary ? 'border-gold/50' : ''}`}>
                  <div className="flex items-center justify-between gap-3">
                    <span className="grid h-11 w-11 place-items-center rounded-xl border border-gold/25 bg-gold-soft text-gold-text">
                      <Icon className="h-5 w-5" aria-hidden="true" />
                    </span>
                    {primary && <span className="mono-label text-gold-text">Your platform</span>}
                  </div>
                  <h2 className="mt-5 text-lg font-semibold tracking-[-0.02em]">{name}</h2>
                  <p className="muted mt-1 font-mono text-[11px]">{detail}</p>
                  <p className="muted mt-4 flex-1 text-xs leading-relaxed">{note}</p>
                  <a
                    href={href}
                    className={`mt-6 inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors ${available ? 'btn-gold' : 'btn-ghost'}`}
                    {...(available ? { rel: 'noreferrer' } : { target: '_blank', rel: 'noreferrer' })}
                  >
                    {available ? <Download className="h-4 w-4" aria-hidden="true" /> : <ArrowUpRight className="h-4 w-4" aria-hidden="true" />}
                    {action}
                  </a>
                  {secondary && (
                    <a href={secondary.href} className="muted mt-3 text-center text-[11px] transition-colors hover:text-gold-text">
                      {secondary.label}
                    </a>
                  )}
                </article>
              );
            })}
          </div>

          <div className="mx-auto mt-10 grid max-w-3xl gap-4 sm:grid-cols-3">
            <div className="card p-5">
              <ShieldCheck className="h-4 w-4 text-gold-text" aria-hidden="true" />
              <h2 className="mt-3 text-sm font-semibold">Local by default</h2>
              <p className="muted mt-1.5 text-xs leading-relaxed">The gateway binds to loopback. Credentials stay in your encrypted vault.</p>
            </div>
            <div className="card p-5">
              <Terminal className="h-4 w-4 text-gold-text" aria-hidden="true" />
              <h2 className="mt-3 text-sm font-semibold">Same API</h2>
              <p className="muted mt-1.5 text-xs leading-relaxed">Point any OpenAI-compatible client at <span className="font-mono">127.0.0.1:8787</span>.</p>
            </div>
            <div className="card p-5">
              <CheckCircle2 className="h-4 w-4 text-gold-text" aria-hidden="true" />
              <h2 className="mt-3 text-sm font-semibold">All releases</h2>
              <p className="muted mt-1.5 text-xs leading-relaxed">
                Older versions and checksums live on the{' '}
                <a href={RELEASES} target="_blank" rel="noreferrer" className="text-gold-text hover:underline">GitHub release page</a>.
              </p>
            </div>
          </div>

          <p className="muted mx-auto mt-8 max-w-2xl text-center text-[11px] leading-relaxed">
            The Windows build is not signed yet. The macOS installer is built on macOS CI and is not offered as a
            direct link until it exists. The Linux app is distributed as a Debian package.
          </p>
        </div>
      </main>

      <Footer />
    </div>
  );
}
