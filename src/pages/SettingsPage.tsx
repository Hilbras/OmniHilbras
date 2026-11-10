import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { CheckCircle2, CircleAlert, MonitorCog, Moon, Palette, RefreshCw, Save, ShieldCheck, Sun, Terminal, Timer, Wrench } from 'lucide-react';
import { DashboardShell } from '../components/DashboardShell';
import {
  getGatewaySettings,
  listGatewayApiKeys,
  setGatewayRequireApiKey,
  type GatewaySettings,
} from '../lib/gatewayClient';
import { desktopBridge, type DesktopAppSettings, type UpdateState } from '../lib/electronBridge';

/**
 * Settings that are real.
 *
 * Browser-facing rows read the gateway's resolved configuration; desktop rows persist to
 * `userData/config.json` and take effect in main. The only gateway setting mutable without a restart is
 * API-key enforcement; the port restarts the gateway, and everything under "loaded at startup" is
 * read-only because it comes from the environment this process was started with.
 */

const THEME_KEY = 'omnihilbras-theme';
const REDUCE_KEY = 'omnihilbras-reduce-motion';

function Toggle({ label, detail, checked, disabled, onChange }: { label: string; detail?: string; checked: boolean; disabled?: boolean; onChange: (next: boolean) => void }) {
  return (
    <label className="flex items-start justify-between gap-4 py-3">
      <span>
        <span className="block text-xs font-medium">{label}</span>
        {detail && <span className="muted mt-0.5 block text-[11px] leading-relaxed">{detail}</span>}
      </span>
      <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors disabled:opacity-40 ${checked ? 'border-gold/60 bg-gold/70' : 'border-line bg-bg-soft'}`}>
        <span className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-text transition-[left] ${checked ? 'left-[18px]' : 'left-0.5'}`} />
      </button>
    </label>
  );
}

function Section({ icon, title, description, children }: { icon: ReactNode; title: string; description: string; children: ReactNode }) {
  return (
    <section className="card p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold">{icon}{title}</h2>
      <p className="muted mt-1 text-xs leading-relaxed">{description}</p>
      <div className="mt-3 divide-y divide-line">{children}</div>
    </section>
  );
}

function KeyValue({ label, value }: { label: string; value: ReactNode }) {
  return <div className="grid grid-cols-[150px_1fr] gap-3 py-2 text-[11px]"><span className="muted">{label}</span><span className="break-all font-mono">{value}</span></div>;
}

export function SettingsContent() {
  const bridge = desktopBridge();
  const [settings, setSettings] = useState<GatewaySettings | undefined>();
  const [preferences, setPreferences] = useState<DesktopAppSettings | undefined>();
  const [update, setUpdate] = useState<UpdateState | undefined>();
  const [requireApiKey, setRequireApiKey] = useState<boolean | undefined>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [failed, setFailed] = useState(false);
  const [port, setPort] = useState('');
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>(() => {
    try {
      const stored = localStorage.getItem(THEME_KEY);
      return stored === 'light' || stored === 'dark' ? stored : 'system';
    } catch {
      return 'system';
    }
  });
  const [reduceMotion, setReduceMotion] = useState(() => {
    try {
      return localStorage.getItem(REDUCE_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const flash = useCallback((message: string, error = false) => {
    setNotice(message);
    setFailed(error);
  }, []);

  const loadGateway = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const [resolved, keys] = await Promise.all([getGatewaySettings(signal), listGatewayApiKeys(signal)]);
      setSettings(resolved.settings ?? undefined);
      setRequireApiKey(keys.requireApiKey);
    } catch (error) {
      if (signal?.aborted) return;
      flash(error instanceof Error ? error.message : 'The gateway did not answer.', true);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [flash]);

  useEffect(() => {
    const controller = new AbortController();
    void loadGateway(controller.signal);
    if (bridge) {
      void bridge.settings.get().then((next) => {
        setPreferences(next);
        setPort(String(next.gatewayPort));
      });
      void bridge.updates.getState().then(setUpdate);
      const off = bridge.updates.onState(setUpdate);
      return () => {
        controller.abort();
        off();
      };
    }
    return () => controller.abort();
  }, [bridge, loadGateway]);

  const saveDesktop = useCallback(async (patch: Partial<DesktopAppSettings>, label: string) => {
    if (!bridge) return;
    setSaving(label);
    try {
      setPreferences(await bridge.settings.set(patch));
      flash(`${label} saved.`);
      if (patch.gatewayPort) await loadGateway();
    } catch (error) {
      flash(error instanceof Error ? error.message : 'The setting was not saved.', true);
    } finally {
      setSaving(undefined);
    }
  }, [bridge, flash, loadGateway]);

  const applyTheme = (next: 'light' | 'dark' | 'system') => {
    setTheme(next);
    try {
      if (next === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, next);
    } catch { /* storage unavailable */ }
    const resolved = next === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : next;
    document.documentElement.dataset.theme = resolved;
  };

  const applyReduceMotion = (next: boolean) => {
    setReduceMotion(next);
    document.documentElement.classList.toggle('reduce-motion', next);
    try { localStorage.setItem(REDUCE_KEY, String(next)); } catch { /* storage unavailable */ }
  };

  const updateAction = async (action: 'check' | 'download' | 'install') => {
    if (!bridge) return;
    setSaving(`update-${action}`);
    try {
      if (action === 'check') setUpdate(await bridge.updates.check());
      else if (action === 'download') setUpdate(await bridge.updates.download());
      else await bridge.updates.install();
    } catch (error) {
      flash(error instanceof Error ? error.message : 'The update action failed.', true);
    } finally {
      setSaving(undefined);
    }
  };

  const toggleRequireApiKey = async (next: boolean) => {
    setRequireApiKey(next);
    setSaving('api-key-gate');
    try {
      setRequireApiKey(await setGatewayRequireApiKey(next));
      flash(next ? 'API-key enforcement is on.' : 'API-key enforcement is off. Every local client is accepted.');
    } catch (error) {
      setRequireApiKey(!next);
      flash(error instanceof Error ? error.message : 'The gate was not changed.', true);
    } finally {
      setSaving(undefined);
    }
  };

  return (
    <div id="settings" className="space-y-5">
      {notice && (
        <div role="status" className={`flex items-center gap-2 rounded-xl border px-3.5 py-3 text-xs ${failed ? 'border-danger/25 bg-danger/10 text-danger' : 'border-success/25 bg-success/10 text-success'}`}>
          {failed ? <CircleAlert className="h-4 w-4" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
          {notice}
          <button type="button" onClick={() => setNotice(undefined)} className="ml-auto text-[10px] underline">dismiss</button>
        </div>
      )}

      <Section icon={<Palette className="h-4 w-4 text-gold-text" aria-hidden="true" />} title="Appearance" description="Saved in this browser. The desktop app uses the same renderer.">
        <div className="flex flex-wrap items-center gap-2 py-3">
          {([['light', Sun], ['dark', Moon], ['system', MonitorCog]] as const).map(([value, Icon]) => (
            <button key={value} type="button" onClick={() => applyTheme(value)} className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[11px] capitalize ${theme === value ? 'border-gold/40 bg-gold-soft text-gold-text' : 'border-line text-muted hover:text-text'}`}>
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />{value}
            </button>
          ))}
        </div>
        <Toggle label="Reduce motion" detail="Disables page transitions, hover lifts and animated icons." checked={reduceMotion} onChange={applyReduceMotion} />
      </Section>

      <Section icon={<Wrench className="h-4 w-4 text-gold-text" aria-hidden="true" />} title="Desktop app" description={bridge ? 'Saved to the app config and applied in the main process.' : 'These settings exist only in the desktop app. The browser dashboard is managed by pnpm dev.'}>
        <Toggle label="Close to tray" detail="Closing the window hides the app; the gateway keeps serving." checked={preferences?.closeToTray ?? true} disabled={!bridge || Boolean(saving)} onChange={(next) => void saveDesktop({ closeToTray: next }, 'Close to tray')} />
        <Toggle label="Start gateway on launch" detail="When off, the app opens with the gateway stopped." checked={preferences?.autoStartGateway ?? true} disabled={!bridge || Boolean(saving)} onChange={(next) => void saveDesktop({ autoStartGateway: next }, 'Start gateway on launch')} />
        <Toggle label="Check for updates on launch" detail="Checks five seconds after startup. A skipped or failed check is reported honestly." checked={preferences?.checkUpdatesOnLaunch ?? true} disabled={!bridge || Boolean(saving)} onChange={(next) => void saveDesktop({ checkUpdatesOnLaunch: next }, 'Update check on launch')} />
        <div className="flex flex-wrap items-end gap-2 py-3">
          <label className="text-[11px] font-medium">Gateway port
            <input value={port} onChange={(event) => setPort(event.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" disabled={!bridge} className="input mt-1 block !h-9 !w-32 !rounded-lg !border-line !bg-surface-2 !px-2 !font-mono !text-xs" />
          </label>
          <button type="button" onClick={() => void saveDesktop({ gatewayPort: Number(port) }, 'Gateway port')} disabled={!bridge || Boolean(saving) || Number(port) === preferences?.gatewayPort} className="btn-ghost !px-3 !py-2 !text-xs disabled:opacity-40"><Save className="h-3.5 w-3.5" aria-hidden="true" />{saving === 'Gateway port' ? 'Restarting' : 'Apply and restart'}</button>
          <span className="muted text-[10px]">Changing this restarts the gateway on the new port.</span>
        </div>
      </Section>

      <Section icon={<RefreshCw className="h-4 w-4 text-gold-text" aria-hidden="true" />} title="Updates" description="The app checks the release feed. Windows, signed macOS and the Linux AppImage install from here; a .deb downloads and opens the system installer.">
        <KeyValue label="Status" value={update ? `${update.status}${update.version ? ` · ${update.version}` : ''}${typeof update.percent === 'number' ? ` · ${update.percent}%` : ''}` : 'not checked'} />
        {update?.reason && <KeyValue label="Reason" value={update.reason} />}
        <div className="flex flex-wrap gap-2 py-3">
          <button type="button" onClick={() => void updateAction('check')} disabled={!bridge || Boolean(saving)} className="btn-ghost !px-3 !py-2 !text-xs disabled:opacity-40">Check now</button>
          {update?.canInstall && update.status === 'available' && <button type="button" onClick={() => void updateAction('download')} disabled={Boolean(saving)} className="btn-gold !px-3 !py-2 !text-xs">Download</button>}
          {update?.canInstall && update.status === 'downloaded' && <button type="button" onClick={() => void updateAction('install')} disabled={Boolean(saving)} className="btn-gold !px-3 !py-2 !text-xs">{update.installMethod === 'deb' ? 'Open installer' : 'Install and restart'}</button>}
          {!update?.canInstall && (update?.status === 'available' || update?.status === 'error') && <button type="button" onClick={() => void bridge?.updates.openRelease()} className="btn-ghost !px-3 !py-2 !text-xs">Release page</button>}
        </div>
      </Section>

      <Section icon={<ShieldCheck className="h-4 w-4 text-gold-text" aria-hidden="true" />} title="Gateway access" description="The one gateway setting that can change without a restart.">
        <Toggle label="Require an API key" detail="When on, every LLM and management request must present a key created on the API keys page." checked={requireApiKey ?? true} disabled={loading || Boolean(saving)} onChange={(next) => void toggleRequireApiKey(next)} />
      </Section>

      <Section icon={<ClockIcon />} title="Loaded at startup" description={loading ? 'Reading the configuration this process resolved.' : 'These come from the environment. Change them in the launch configuration and restart the gateway.'}>
        {settings ? (
          <>
            <KeyValue label="Listen" value={`${settings.host}:${settings.port}`} />
            <KeyValue label="Data directory" value={settings.dataDir} />
            <KeyValue label="CORS origins" value={settings.corsOrigins.join(', ') || 'none'} />
            <KeyValue label="Request timeout" value={`${settings.timeoutMs} ms`} />
            <KeyValue label="Health interval" value={`${settings.healthIntervalMs} ms`} />
            <KeyValue label="Failure threshold" value={String(settings.failureThreshold)} />
            <KeyValue label="Recovery cooldown" value={`${settings.recoveryCooldownMs} ms`} />
            <KeyValue label="Context saver" value={settings.compression ? `${settings.compression.enabled ? 'on' : 'off'} · ratio ${settings.compression.targetRatio} · keep last ${settings.compression.protectRecent}` : 'not reported'} />
            <KeyValue label="Output cap" value={settings.maxOutputTokensCap ? `${settings.maxOutputTokensCap} tokens` : 'none'} />
            <KeyValue label="Thinking cap" value={settings.thinkingBudgetCap ? `${settings.thinkingBudgetCap} tokens` : 'none'} />
            <KeyValue label="History trim" value={settings.historyTrim ? `over ${settings.historyTrim.maxInputTokens} tokens · keep last ${settings.historyTrim.keepRecent}` : 'off'} />
            <KeyValue label="Cache anchor" value={settings.cacheAnchor ? 'on' : 'off'} />
            <KeyValue label="Prompt style" value={[settings.caveman ? `caveman ${settings.caveman.level}` : '', settings.ponytail ? `ponytail ${settings.ponytail.level}` : ''].filter(Boolean).join(' · ') || 'off'} />
            <KeyValue label="Headroom" value={settings.headroom?.enabled ? `on${settings.headroom.timeoutMs ? ` · ${settings.headroom.timeoutMs} ms` : ''}` : 'off'} />
            <KeyValue label="PXPIPE" value={settings.pxpipe?.enabled ? `on${settings.pxpipe.minChars ? ` · min ${settings.pxpipe.minChars} chars` : ''}` : 'off'} />
            <KeyValue label="Mutable at runtime" value={settings.mutableAtRuntime.join(', ') || '—'} />
            <KeyValue label="OpenAI-compatible" value={`${settings.endpoints.compatible.name} · ${settings.endpoints.compatible.baseUrl}`} />
            <KeyValue label="Mutable by restart" value={settings.mutableByRestart.join(', ') || '—'} />
          </>
        ) : <p className="muted py-3 text-xs">{loading ? 'Loading…' : 'No configuration was returned.'}</p>}
      </Section>

      <Section icon={<Terminal className="h-4 w-4 text-gold-text" aria-hidden="true" />} title="Data and recovery" description="Backups and diagnostics are on About; they are not duplicated here.">
        <div className="flex flex-wrap gap-2 py-3">
          <a href="/dashboard/about" className="btn-ghost !px-3 !py-2 !text-xs">Encrypted backup</a>
          {bridge && <button type="button" onClick={() => void bridge.diagnostics.export()} className="btn-ghost !px-3 !py-2 !text-xs">Export diagnostics</button>}
        </div>
      </Section>
    </div>
  );
}

function ClockIcon() {
  return <Timer className="h-4 w-4 text-gold-text" aria-hidden="true" />;
}

export function SettingsPage() {
  return <DashboardShell activePage="settings" pageTitle="Settings" pageDescription="Appearance, desktop behaviour, updates and gateway configuration"><SettingsContent /></DashboardShell>;
}
