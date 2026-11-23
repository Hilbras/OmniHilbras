import { useEffect, useState } from 'react';
import { getGatewayTranslators, type GatewayTranslationPair } from '../lib/gatewayClient';

/**
 * The format pairs this gateway actually registers, read from `GET /v1/translators`.
 *
 * This is an inspector, not a translator. The gateway publishes only `{source, target}` — no
 * translate function, no request bodies and no credentials — and serves no translate/send/save
 * endpoint. So there is nothing here to simulate: a row is a fact the gateway stated, and an
 * error is printed verbatim rather than replaced by an empty list. No timer sets any state;
 * every change comes from the request's own promise.
 */
export function TranslatorContent() {
  const [pairs, setPairs] = useState<GatewayTranslationPair[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    getGatewayTranslators(controller.signal)
      .then((reply) => {
        setPairs(Array.isArray(reply?.data) ? reply.data : []);
        setError(undefined);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setPairs(undefined);
        setError(cause instanceof Error ? cause.message : 'The gateway did not answer.');
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  const pairLabel = (pair: GatewayTranslationPair) => `${pair.source} → ${pair.target}`;

  return (
    <div className="space-y-4">
      <header>
        <p className="eyebrow">Gateway capability</p>
        <h1 className="text-lg font-semibold">Translators</h1>
        <p className="muted mt-1 text-xs">
          The source → target format pairs registered in the gateway and used by its translation routes.
          This page only reads that inventory; it cannot translate a message, send one or write a configuration.
        </p>
      </header>

      {error && <p role="alert" className="rounded-xl border border-warning/25 bg-warning/10 px-3 py-2 text-xs text-warning">{error}</p>}

      <section className="card overflow-hidden" aria-label='Registered format pairs'>
        {loading ? (
          <p className='muted px-4 py-10 text-center text-xs'>Reading the gateway inventory…</p>
        ) : !pairs ? (
          <p className='muted px-4 py-10 text-center text-xs'>Nothing to show — the gateway did not return an inventory.</p>
        ) : pairs.length === 0 ? (
          <p className='muted px-4 py-10 text-center text-xs'>The gateway registers no format pairs.</p>
        ) : (
          <ul className='divide-y divide-line'>
            {pairs.map((pair) => (
              <li key={pairLabel(pair)} className='px-4 py-3'>
                <p className='font-mono text-xs font-semibold'>{pairLabel(pair)}</p>
                <dl className='mt-2 grid gap-x-4 gap-y-1 text-[11px] sm:grid-cols-2'>
                  <div><dt className='mono-label'>source</dt><dd className='break-all font-mono'>{pair.source}</dd></div>
                  <div><dt className='mono-label'>target</dt><dd className='break-all font-mono'>{pair.target}</dd></div>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
