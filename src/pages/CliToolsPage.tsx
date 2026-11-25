import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { copyText } from '../lib/copyText';
import { getGatewaySettings, listGatewayApiKeys, type GatewayApiKey, type GatewaySettings } from '../lib/gatewayClient';

/**
 * The values a CLI tool needs, assembled only from what the gateway reports.
 *
 * The gateway publishes no per-tool configuration route, so this page is a configurator of a snippet,
 * not of gateway state: the base URL comes from `GET /v1/settings`, the key row from `GET /v1/keys`.
 * Key **values** are never reported by either route and are never invented here — the snippet uses an
 * environment-variable placeholder and says plainly that the operator supplies the secret. Nothing on
 * this page sets a success state from a timer; the copy result is whatever `copyText` actually returned.
 */

type Reported = {
  settings: GatewaySettings | null;
  keys: GatewayApiKey[];
  requireApiKey: boolean;
  reason?: string;
};

export function CliToolsContent() {
  const [reported, setReported] = useState<Reported | undefined>();
  const [error, setError] = useState<string>();
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [copied, setCopied] = useState<boolean>();

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([getGatewaySettings(controller.signal), listGatewayApiKeys(controller.signal)])
      .then(([settingsReply, keysReply]) => {
        const keys = Array.isArray(keysReply?.keys) ? keysReply.keys : [];
        setReported({
          settings: settingsReply.settings ?? null,
          keys,
          requireApiKey: keysReply.requireApiKey === true,
          ...(settingsReply.reason ? { reason: settingsReply.reason } : {}),
        });
        setSelectedKey(keys.find((key) => key.enabled)?.id ?? '');
        setError(undefined);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setReported(undefined);
        setError(cause instanceof Error ? cause.message : 'The gateway did not answer.');
      });
    return () => controller.abort();
  }, []);

const settings = reported?.settings;
  const key = reported?.keys.find((entry) => entry.id === selectedKey);
  /**
   * The address a client should use, not the address the gateway bound.
   *
   * `0.0.0.0` and `::` are bind addresses; a remote client cannot dial either. The dashboard already
   * knows the reachable gateway origin (`gatewayBase`), so prefer it and fall back to the reported
   * endpoint only when this build has no origin of its own. IPv6 literals need brackets in a URL.
   */
  const reportedHost = settings?.host === '0.0.0.0' || settings?.host === '::' ? '127.0.0.1' : settings?.host;
  const host = reportedHost?.includes(':') && !reportedHost.startsWith('[') ? `[${reportedHost}]` : reportedHost;
  const runtimeGatewayBase = (globalThis as { __OMNIHILBRAS_GATEWAY_URL__?: unknown }).__OMNIHILBRAS_GATEWAY_URL__;
  const sameOriginBase = import.meta.env.DEV && typeof window !== 'undefined' ? window.location.origin : undefined;
  const baseUrl = typeof runtimeGatewayBase === 'string' && runtimeGatewayBase
    ? runtimeGatewayBase
    : sameOriginBase ?? (settings && host ? `http://${host}:${settings.port}` : undefined);
  const snippet = [
    `OMNIHILBRAS_GATEWAY_URL=${baseUrl ?? '<gateway did not report a reachable gateway URL>'}`,
    // The prefix is the only key fact the gateway reports. The rest is a placeholder the operator
    // fills, not a value this page guessed or a check this page claims to have run.
    key ? `OMNIHILBRAS_API_KEY=<paste the value of ${key.name} (${key.prefix}...)>` : 'OMNIHILBRAS_API_KEY=<paste a gateway key value>',
  ].join('\n');

  const doCopy = async () => {
    const ok = await copyText(snippet);
    setCopied(ok);
  };

  return (
    <div className="space-y-4">
      <header>
        <p className="eyebrow">Gateway-reported values</p>
        <h1 className="text-lg font-semibold">CLI tools</h1>
        <p className="muted mt-1 max-w-2xl text-xs">
          Assemble the environment a CLI tool needs from the gateway&apos;s own answers. The gateway reports
          no per-tool configuration and never returns a key value, so this page cannot test a key or write a
          client config — it copies a snippet with a placeholder you fill yourself.
        </p>
      </header>

      {error && <p role="alert" className="rounded-xl border border-warning/25 bg-warning/10 px-3 py-2 text-xs text-warning">{error}</p>}
      {reported?.reason && <p role="status" className="muted text-xs">{reported.reason}</p>}
      {!reported && !error && <p className="muted px-4 py-10 text-center text-xs">Reading the gateway configuration…</p>}

      {reported && (
        <>
          <section className="card space-y-3 p-4" aria-label="Reported gateway values">
            <h2 className="text-sm font-semibold">What the gateway reported</h2>
            <dl className="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
              <div><dt className="mono-label">Host</dt><dd className="font-mono">{settings?.host ?? 'not reported'}</dd></div>
              <div><dt className="mono-label">Port</dt><dd className="font-mono">{settings?.port ?? 'not reported'}</dd></div>
              <div><dt className="mono-label">Reachable gateway base</dt><dd className="break-all font-mono">{baseUrl ?? 'not reported'}</dd></div>
              <div><dt className="mono-label">Upstream OpenAI adapter URL</dt><dd className="break-all font-mono">{settings?.endpoints.openai ?? 'not reported'}</dd></div>
              <div><dt className="mono-label">Key enforcement</dt><dd>{reported.requireApiKey ? 'on' : 'off'}</dd></div>
            </dl>
            <label className="block text-xs">
              <span className="mono-label">Reported key to name in the snippet</span>
              <select className="input mt-1 w-full" value={selectedKey} onChange={(event) => { setSelectedKey(event.target.value); setCopied(undefined); }}>
                <option value="">No key selected</option>
                {reported.keys.map((entry) => (
                  <option key={entry.id} value={entry.id}>{entry.name} — {entry.prefix}…{entry.enabled ? '' : ' (disabled)'}</option>
                ))}
              </select>
            </label>
            {reported.keys.length === 0 && <p className="muted text-xs">The gateway reports no keys. Create one on the API keys page before pointing a CLI tool at it.</p>}
          </section>

          <section className="card space-y-3 p-4" aria-label="Environment snippet">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">Environment snippet</h2>
              <button type="button" className="btn btn-secondary flex items-center gap-1.5 text-xs" onClick={doCopy}>
                {copied === true ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
                {copied === true ? 'Copied' : copied === false ? 'Copy failed' : 'Copy'}
              </button>
            </div>
            <pre className="overflow-x-auto rounded-lg bg-bg/60 p-3 font-mono text-xs">{snippet}</pre>
            <p className="muted text-xs">The key value is deliberately absent from every gateway answer and from this snippet. Pasting it into a client is the operator&apos;s action, not a result this page measured.</p>
          </section>
        </>
      )}
    </div>
  );
}
