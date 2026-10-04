import { useCallback, useEffect, useState } from 'react';
import {
  CircleAlert,
  Clock,
  Cpu,
  FolderCog,
  Globe,
  RefreshCw,
  Server,
  Settings2,
  SlidersHorizontal,
} from 'lucide-react';
import { DashboardShell } from '../components/DashboardShell';
import { getGatewaySettings, type GatewaySettings } from '../lib/gatewayClient';

/**
 * Settings: what this gateway is actually running with.
 *
 * ## Why this page exists, given everything is an environment variable
 *
 * Because the reason it had been disabled since the project began is worth stating plainly: **there was
 * nothing to show.** Every setting lived in an env var, so the only honest page would have restated
 * `.env.example` — documentation wearing a UI, and already wrong the moment someone forgot a row.
 *
 * `GET /v1/settings` returns something a README cannot: the configuration *this process* resolved, after
 * defaults, after parsing, and after validation. `OMNIHILBRAS_PORT=0` is refused rather than clamped, so
 * "what is my port" has exactly one answer at runtime and this is where it comes from.
 *
 * ## Two rows are deliberately different
 *
 * `mutableAtRuntime` holds one setting — `requireApiKey`. Everything else needs a restart. A page that lists
 * nine values with no indication of which can change shows the reader nine editable rows, and that is the
 * kind of quiet lie this project keeps removing. So each row says which it is, and the restart-only ones are
 * rendered without an edit affordance rather than with a disabled one that implies pressing it would work.
 *
 * ## No secrets
 *
 * The response is built from an explicit field allowlist on the gateway side, so this page cannot display a
 * credential: there is no field that could carry one. `dataDir` is shown because a settings page that hid it
 * would leave no way to find where the vault is — and it is a path the operator chose, with the contents
 * behind `/v1/keys`.
 */

function ms(value: number): string {
  if (value === 0) return 'disabled';
  if (value < 1_000) return `${value} ms`;
  if (value % 60_000 === 0) return `${value / 60_000} min`;
  return `${(value / 1_000).toFixed(1)} s`;
}

function Row({ label, value, detail, icon: Icon }: {
  label: string;
  value: string;
  detail?: string;
  icon: typeof Server;
}) {
  return (
    <div className="flex items-start gap-3 border-t border-line px-4 py-3.5 first:border-t-0">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">{label}</p>
        {/* `break-all` because a data directory is a full filesystem path and a long one must wrap rather
            than push the card wide. */}
        <p className="mt-1 break-all text-sm font-medium">{value}</p>
        {detail ? <p className="muted mt-0.5 text-[11px] leading-relaxed">{detail}</p> : null}
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="card overflow-hidden">
      <div className="border-b border-line px-4 py-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint ? <p className="muted mt-1 text-[11px] leading-relaxed">{hint}</p> : null}
      </div>
      <div>{children}</div>
    </section>
  );
}

export function SettingsContent() {
  const [settings, setSettings] = useState<GatewaySettings | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    getGatewaySettings()
      .then((next) => { setSettings(next.settings); setReason(next.reason ?? null); setError(null); })
      .catch(() => setError('The gateway did not answer. Start it with `pnpm dev:gateway` and refresh.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // The gateway's own answer, used rather than a second opinion computed here — a page that decided which
  // settings were mutable on its own would drift from the gateway the first time one changed.
  const runtimeMutable = new Set(settings?.mutableAtRuntime ?? []);

  return (
    <div id="settings">
      <div className="mb-6 flex flex-col justify-between gap-5 sm:mb-8 sm:flex-row sm:items-end">
        <div>
          <span className="eyebrow"><span className="eyebrow-dot" aria-hidden="true" />Effective configuration</span>
          <h2 className="mt-4 text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">What it is actually running with.</h2>
          <p className="muted mt-2 max-w-xl text-sm leading-relaxed">
            Every value here is one the gateway resolved at startup, after defaults and validation. It is not a
            copy of the environment and it cannot drift from what the process is doing.
          </p>
        </div>
        <button type="button" onClick={load} className="btn-ghost !px-3 !py-2.5 !text-xs">
          <RefreshCw className={`h-3.5 w-3.5${loading ? ' animate-spin' : ''}`} aria-hidden="true" />
          {loading ? 'Reading configuration' : 'Refresh'}
        </button>
      </div>

      {error ? (
        <section className="card p-5" role="alert">
          <p className="flex items-center gap-2 text-sm font-semibold text-danger">
            <CircleAlert className="h-4 w-4" aria-hidden="true" />{error}
          </p>
          <p className="muted mt-2 text-xs leading-relaxed">
            Nothing here is shown from memory. A gateway that is not running has no configuration to report.
          </p>
        </section>
      ) : !settings ? (
        <section className="card p-6 text-center">
          <Settings2 className="mx-auto h-6 w-6 text-muted" aria-hidden="true" />
          <p className="mt-3 text-sm font-semibold">No configuration to report</p>
          <p className="muted mt-1 text-xs leading-relaxed">
            {reason ?? 'This gateway was started without a loaded configuration.'} Inventing defaults here
            would mean a second set of numbers to keep in step with the first.
          </p>
        </section>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Section title="Server" hint={`Values resolved at startup. Only ${[...runtimeMutable].join(', ') || 'nothing'} can change without a restart.`}>
            <Row label="Bind" value={`${settings.host}:${settings.port}`} detail="Loopback only — the gateway refuses to bind anything else." icon={Globe} />
            <Row label="Request timeout" value={ms(settings.timeoutMs)} detail="Applies per provider attempt." icon={Clock} />
            <Row label="Health polling" value={ms(settings.healthIntervalMs)} detail="0 disables background health checks." icon={Cpu} />
            <Row label="Data directory" value={settings.dataDir} detail="Where connections, keys and usage records are stored." icon={FolderCog} />
            <Row label="Allowed origins" value={settings.corsOrigins.join(', ') || 'none'} detail="A browser origin on this list may reach the management surface." icon={Globe} />
          </Section>

          <Section title="Routing" hint="How many consecutive failures eject a connection, and how long it waits before one probe.">
            <Row label="Failure threshold" value={String(settings.failureThreshold)} detail="Consecutive failures before a connection is ejected." icon={SlidersHorizontal} />
            <Row label="Recovery cooldown" value={ms(settings.recoveryCooldownMs)} detail="How long an ejected connection waits before one probe." icon={Clock} />
          </Section>

          <Section title="Provider endpoints" hint="Where requests for each provider family are sent.">
            <Row label="OpenAI" value={settings.endpoints.openai} icon={Server} />
            <Row label="Anthropic" value={settings.endpoints.anthropic} icon={Server} />
            <Row label="Gemini" value={settings.endpoints.gemini} icon={Server} />
            <Row label="OpenRouter" value={settings.endpoints.openrouter} icon={Server} />
            <Row
              label={settings.endpoints.compatible.name}
              value={settings.endpoints.compatible.baseUrl}
              detail={settings.endpoints.compatible.authRequired ? 'Requires a credential.' : 'No credential required.'}
              icon={Server}
            />
          </Section>

          <Section title="Changing these" hint="One setting is live. The rest need a restart, so they are listed rather than offered as controls.">
            <Row
              label="Mutable now"
              value={settings.mutableAtRuntime.join(', ') || 'nothing'}
              detail="Read and written on the API keys page, and it takes effect immediately."
              icon={SlidersHorizontal}
            />
            <Row
              label="Needs a restart"
              value={settings.mutableByRestart.join(', ')}
              detail="Set the matching environment variable and restart. This page will show the new values then."
              icon={Clock}
            />
          </Section>
        </div>
      )}
    </div>
  );
}

export default function SettingsPage() {
  return (
    <DashboardShell>
      <SettingsContent />
    </DashboardShell>
  );
}