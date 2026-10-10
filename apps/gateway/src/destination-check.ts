import { lookup } from 'node:dns/promises';
import { isPrivateHostname } from '@hilbras/omnihilbras';

/**
 * Refuses a remote provider hostname that resolves to a private or metadata address.
 *
 * The SDK checks the hostname text, which cannot see that `127.0.0.1.nip.io` points at loopback. This
 * check resolves the name and judges every address it returns, with the same rule the SDK applies to
 * literals. A name is refused if any one of its addresses is private, because a client may connect to
 * any of them.
 *
 * ## The limit, stated rather than hidden
 *
 * The transport makes its own connection, which resolves the name again. A DNS server that answers with a
 * public address to this check and a private one to the connection wins that race. Closing it needs the
 * check to run on the connection's own lookup, which Node's global `fetch` does not expose. So this is a
 * narrowing, not a guarantee: it stops names that point at private addresses, not a deliberate rebinding.
 */
export async function assertPublicDestination(hostname: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const addresses = await raceAbort(lookup(hostname, { all: true, verbatim: true }), signal);
  if (addresses.length === 0) throw new Error(`The host ${hostname} did not resolve.`);
  if (addresses.some((entry) => isPrivateHostname(entry.address))) {
    throw new Error(`The host ${hostname} resolves to a private address.`);
  }
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}
