import { useEffect, useState } from 'react';
import { Code2, Download, FileKey2, Info, KeyRound, ShieldCheck, Upload } from 'lucide-react';
import { DashboardShell } from '../components/DashboardShell';
import { desktopBridge, type OmniBridge } from '../lib/electronBridge';
import { exportGatewayBackup, importGatewayBackup } from '../lib/gatewayClient';
import { useGatewayStatus } from '../lib/useGatewayStatus';

type AppInfo = Awaited<ReturnType<NonNullable<OmniBridge>['appInfo']>>;

function BackupPanel() {
  const [passphrase, setPassphrase] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState<'export' | 'import' | undefined>();
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [file, setFile] = useState<{ name: string; envelope: unknown } | undefined>();
  const [confirmed, setConfirmed] = useState(false);

  const passphraseProblem = passphrase.length > 0 && passphrase.length < 8
    ? 'Use at least 8 characters.'
    : passphrase !== repeat && repeat.length > 0
      ? 'The passphrases do not match.'
      : undefined;

  async function exportBackup() {
    if (passphraseProblem || passphrase.length < 8) return;
    setBusy('export');
    setFailed(false);
    setMessage('');
    try {
      const backup = await exportGatewayBackup(passphrase);
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `omnihilbras-backup-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage('Encrypted backup downloaded. Keep the passphrase separately; it cannot be recovered.');
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : 'The backup could not be exported.');
    } finally {
      setBusy(undefined);
    }
  }

  async function importBackup() {
    if (!file || passphrase.length < 8 || !confirmed) return;
    setBusy('import');
    setFailed(false);
    setMessage('');
    try {
      const result = await importGatewayBackup(passphrase, file.envelope);
      setMessage(`Imported ${result.connections} connections, ${result.apiKeys} API keys and ${result.strategies} strategies. Reloading.`);
      setFile(undefined);
      setConfirmed(false);
      window.setTimeout(() => window.location.reload(), 1_200);
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : 'The backup could not be imported.');
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section className="card p-5" aria-labelledby="backup-title">
      <h2 id="backup-title" className="flex items-center gap-2 text-sm font-semibold"><FileKey2 className="h-4 w-4 text-gold-text" aria-hidden="true" />Encrypted backup</h2>
      <p className="muted mt-1 text-xs leading-relaxed">
        Exports connections, their provider credentials, model policy, resilience, strategies and the API-key
        store. The file is AES-256-GCM with a scrypt-derived key; the passphrase is not stored anywhere.
        API keys are exported as their stored hashes, so they keep working after import but cannot be shown again.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-medium">Passphrase
          <input type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} autoComplete="new-password" className="input mt-1 !h-10 !w-full !rounded-lg !border-line !bg-surface-2 !px-3 !text-xs" placeholder="At least 8 characters" />
        </label>
        <label className="block text-xs font-medium">Repeat passphrase
          <input type="password" value={repeat} onChange={(event) => setRepeat(event.target.value)} autoComplete="new-password" className="input mt-1 !h-10 !w-full !rounded-lg !border-line !bg-surface-2 !px-3 !text-xs" />
        </label>
      </div>
      {passphraseProblem && <p className="mt-2 text-[11px] text-danger">{passphraseProblem}</p>}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void exportBackup()} disabled={Boolean(busy) || passphrase.length < 8 || Boolean(passphraseProblem)} className="btn-gold !px-3 !py-2 !text-xs disabled:opacity-40">
          <Download className="h-3.5 w-3.5" aria-hidden="true" />{busy === 'export' ? 'Exporting' : 'Export encrypted backup'}
        </button>
      </div>
      <hr className="my-5 border-line" />
      <p className="text-xs font-semibold">Import</p>
      <p className="muted mt-1 text-[11px] leading-relaxed">Import replaces every connection and API key on this gateway. There is no merge and no undo.</p>
      <div className="mt-3 flex flex-col gap-3">
        <input type="file" accept="application/json,.json" onChange={async (event) => {
          const selected = event.target.files?.[0];
          if (!selected) return;
          try {
            setFile({ name: selected.name, envelope: JSON.parse(await selected.text()) });
            setFailed(false);
            setMessage(`Loaded ${selected.name}.`);
          } catch {
            setFile(undefined);
            setFailed(true);
            setMessage('That file is not a JSON backup.');
          }
        }} className="block w-full text-[11px] text-muted file:mr-3 file:rounded-md file:border file:border-line file:bg-bg-soft file:px-3 file:py-1.5 file:text-[11px] file:text-text" />
        {file && <p className="muted font-mono text-[10px]">selected: {file.name}</p>}
        <label className="flex items-start gap-2 text-[11px] text-muted">
          <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-0.5" />
          I understand this replaces all current connections and API keys.
        </label>
        <button type="button" onClick={() => void importBackup()} disabled={Boolean(busy) || !file || !confirmed || passphrase.length < 8} className="btn-ghost self-start !px-3 !py-2 !text-xs disabled:opacity-40">
          <Upload className="h-3.5 w-3.5" aria-hidden="true" />{busy === 'import' ? 'Importing' : 'Import and replace'}
        </button>
      </div>
      {message && <p role="status" className={`mt-3 rounded-lg border px-3 py-2 text-[11px] ${failed ? 'border-danger/25 bg-danger/10 text-danger' : 'border-success/25 bg-success/10 text-success'}`}>{message}</p>}
    </section>
  );
}

export function AboutContent() {
  const bridge = desktopBridge();
  const [info, setInfo] = useState<AppInfo | undefined>();
  const { buildVersion } = useGatewayStatus();

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    void bridge.appInfo().then((next) => {
      if (active) setInfo(next);
    });
    return () => { active = false; };
  }, [bridge]);

  return (
    <div id="about" className="space-y-5">
      <section className="card p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><Info className="h-4 w-4 text-gold-text" aria-hidden="true" />OmniHilbras</h2>
        <p className="muted mt-1 text-xs leading-relaxed">A provider-neutral local gateway with a dashboard that shows what it actually measured.</p>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
          <div className="rounded-lg border border-line bg-bg-soft/50 p-3"><dt className="muted text-[10px] uppercase tracking-wide">App</dt><dd className="mt-1 font-mono">{info?.version ?? 'browser'}</dd></div>
          <div className="rounded-lg border border-line bg-bg-soft/50 p-3"><dt className="muted text-[10px] uppercase tracking-wide">Gateway</dt><dd className="mt-1 font-mono">{buildVersion ?? 'unknown'}</dd></div>
          <div className="rounded-lg border border-line bg-bg-soft/50 p-3"><dt className="muted text-[10px] uppercase tracking-wide">Platform</dt><dd className="mt-1 font-mono">{info ? `${info.platform}-${info.arch}` : navigator.platform}</dd></div>
          <div className="rounded-lg border border-line bg-bg-soft/50 p-3"><dt className="muted text-[10px] uppercase tracking-wide">Mode</dt><dd className="mt-1 font-mono">{info ? (info.packaged ? 'installed' : 'development') : 'browser'}</dd></div>
        </dl>
        {info && <p className="muted mt-3 font-mono text-[10px]">Electron {info.electron} · Chrome {info.chrome} · Node {info.node}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          <a href="https://github.com/Hilbras/OmniHilbras" target="_blank" rel="noreferrer" className="btn-ghost !px-3 !py-2 !text-xs"><Code2 className="h-3.5 w-3.5" aria-hidden="true" />Source</a>
          <a href="https://github.com/Hilbras/OmniHilbras/blob/main/docs/SPEC-SDK.md" target="_blank" rel="noreferrer" className="btn-ghost !px-3 !py-2 !text-xs"><ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />Gateway spec</a>
          {bridge && <button type="button" onClick={() => void bridge.diagnostics.export()} className="btn-ghost !px-3 !py-2 !text-xs"><KeyRound className="h-3.5 w-3.5" aria-hidden="true" />Export diagnostics</button>}
        </div>
      </section>

      <BackupPanel />

      <section className="card p-5">
        <h2 className="text-sm font-semibold">Credential handling</h2>
        <p className="muted mt-1 text-xs leading-relaxed">
          Provider credentials live in the gateway vault, encrypted at rest, and are never placed in browser
          storage. The desktop app keeps the dashboard token in the main process; the renderer asks for paths.
          The backup is the only export that contains credentials, and it is encrypted with a passphrase the
          gateway never stores.
        </p>
      </section>
    </div>
  );
}

export function AboutPage() {
  return <DashboardShell activePage="about" pageTitle="About" pageDescription="Version, platform, backup and recovery"><AboutContent /></DashboardShell>;
}
