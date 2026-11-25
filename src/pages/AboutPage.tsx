import { useEffect, useState } from 'react';
import { Code2, Download, FileKey2, Info, KeyRound, ShieldCheck, Upload } from 'lucide-react';
import { desktopBridge, type OmniBridge } from '../lib/electronBridge';
import { exportGatewayBackup, importGatewayBackup, verifyGatewayBackup, type GatewayBackupPreview } from '../lib/gatewayClient';
import { useGatewayStatus } from '../lib/useGatewayStatus';
import { badgeTone } from '../ui/primitives';

type AppInfo = Awaited<ReturnType<NonNullable<OmniBridge>['appInfo']>>;

function BackupPanel() {
  const bridge = desktopBridge();
  const [passphrase, setPassphrase] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState<'export' | 'import' | undefined>();
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [file, setFile] = useState<{ name: string; envelope: unknown } | undefined>();
  const [confirmed, setConfirmed] = useState(false);
  const [preview, setPreview] = useState<GatewayBackupPreview | undefined>();
  const [verifying, setVerifying] = useState(false);

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
      const content = JSON.stringify(backup, null, 2);
      const filename = `omnihilbras-backup-${new Date().toISOString().slice(0, 10)}.json`;
      if (bridge) {
        const saved = await bridge.backup.save(content, filename);
        if (!saved.saved) {
          setMessage('Export cancelled.');
          return;
        }
        setMessage(`Encrypted backup saved to ${saved.path}. Keep the passphrase separately; it cannot be recovered.`);
        return;
      }
      const blob = new Blob([content], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      // Revoking immediately after `click()` can abort the download before it starts, leaving an empty
      // file that later fails import. Let the browser take the blob first.
      window.setTimeout(() => URL.revokeObjectURL(url), 1_500);
      setMessage('Encrypted backup downloaded. Keep the passphrase separately; it cannot be recovered.');
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : 'The backup could not be exported.');
    } finally {
      setBusy(undefined);
    }
  }

  async function verifyBackup() {
    if (!file || passphrase.length < 8) return;
    setVerifying(true);
    setFailed(false);
    try {
      const next = await verifyGatewayBackup(passphrase, file.envelope);
      setPreview(next);
      setMessage(`This file is readable: ${Object.entries(next.sections).map(([name, count]) => `${name} ${count}`).join(', ')}.`);
    } catch (error) {
      setPreview(undefined);
      setFailed(true);
      setMessage(error instanceof Error ? error.message : 'The backup could not be verified.');
    } finally {
      setVerifying(false);
    }
  }

  async function importBackup() {
    if (!file || passphrase.length < 8 || !confirmed) return;
    setBusy('import');
    setFailed(false);
    setMessage('');
    try {
      const result = await importGatewayBackup(passphrase, file.envelope);
      // Named per section rather than summarised: a restore that silently skipped a store is the failure
      // this whole file exists to make visible, and "imported" alone is what hid it before.
      const carried = Object.keys(result.sections ?? {}).map((name) => `${name} ${result.sections[name]}`).join(', ');
      const untouched = (result.notCarried ?? []).length > 0 ? ` The file carried no ${result.notCarried.join(', ')}, so those stores were left as they were.` : '';
      setMessage(`Imported ${result.connections} connections, ${result.apiKeys} API keys and ${result.strategies} strategies. Sections replaced: ${carried}.${untouched} Reloading.`);
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
        Exports every store this gateway keeps: connections and their credentials (API keys, OAuth sign-ins and
        keyless providers such as Ollama), provider strategies, model aliases, the API-key store, usage history,
        virtual models, skills, workspaces, tunnels, proxy pools, provider nodes, the MITM policy, and the
        signed-in browser sessions of ChatGPT Web and Gemini Web (their session files only — never Chromium's
        caches). The file is
        AES-256-GCM with a scrypt-derived key; the passphrase is not stored anywhere. API keys are exported as
        their stored hashes, so they keep working after import but cannot be shown again.
      </p>
      <p className="muted mt-2 text-xs leading-relaxed">
        Not in the file, deliberately: the master key and this installation's dashboard token. Credentials travel
        decrypted inside the envelope and are re-wrapped under the destination's own master key, so a backup never
        carries the key that opens the machine it came from. Settings are environment variables rather than stored
        state, and the token saver's cache lives only in memory, so neither has anything to export.
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
      <p className="muted mt-1 text-[11px] leading-relaxed">
        Import replaces every store the file carries — connections, credentials, gateway API keys, usage history,
        virtual models and the rest — with what the file holds. There is no merge and no undo. A store the file
        does not carry is left exactly as it is: silence in the file is not an instruction to delete. If any part
        of the file is unreadable, nothing is written at all and your gateway keeps what it has.
      </p>
      <div className="mt-3 flex flex-col gap-3">
        <input type="file" accept="application/json,.json" aria-label="Backup file to import" onChange={async (event) => {
          const selected = event.target.files?.[0];
          if (!selected) return;
          try {
            const parsed = JSON.parse(await selected.text()) as { backup?: unknown; format?: string };
            // Accept both the envelope itself and an API response that wrapped it in `backup`.
            const envelope = (parsed.backup ?? parsed) as { format?: string; version?: number };
            if (envelope?.format !== 'omnihilbras-backup') {
              throw new Error('not an OmniHilbras backup envelope');
            }
            setFile({ name: selected.name, envelope });
            setPreview(undefined);
            setFailed(false);
            setMessage(`Loaded ${selected.name}.`);
          } catch (cause) {
            setFile(undefined);
            setFailed(true);
            setMessage(cause instanceof Error ? `That file is not a readable backup: ${cause.message}` : 'That file is not a readable backup.');
          }
        }} className="block w-full text-[11px] text-muted file:mr-3 file:rounded-md file:border file:border-line file:bg-bg-soft file:px-3 file:py-1.5 file:text-[11px] file:text-text" />
        {file && <p className="muted font-mono text-[10px]">selected: {file.name}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void verifyBackup()} disabled={!file || passphrase.length < 8 || verifying} className="btn-ghost !px-3 !py-2 !text-xs disabled:opacity-40">
            {verifying ? 'Verifying…' : 'Verify file'}
          </button>
        </div>
        {preview && (
          <div className="rounded-lg border border-line bg-bg-soft p-3 text-[11px]">
            <p className="font-semibold">This file is readable.</p>
            <ul className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono text-[10px]">
              {Object.entries(preview.sections).map(([name, count]) => <li key={name}>{name}: {count}</li>)}
            </ul>
            {preview.notCarried.length > 0 && <p className="muted mt-1">Not carried: {preview.notCarried.join(', ')}.</p>}
          </div>
        )}
        <label className="flex items-start gap-2 text-[11px] text-muted">
          <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-0.5" />
          I understand this replaces all current connections and API keys.
        </label>
        <button type="button" onClick={() => void importBackup()} disabled={Boolean(busy) || !file || !confirmed || passphrase.length < 8} className="btn-ghost self-start !px-3 !py-2 !text-xs disabled:opacity-40">
          <Upload className="h-3.5 w-3.5" aria-hidden="true" />{busy === 'import' ? 'Importing' : 'Import and replace'}
        </button>
      </div>
      {message && <p role="status" className={`mt-3 rounded-lg border px-3 py-2 text-[11px] ${failed ? badgeTone.bad : 'border-success/25 bg-success/10 text-success'}`}>{message}</p>}
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
