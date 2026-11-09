import { lookup, Resolver } from 'node:dns/promises';
import { isPrivateHostname } from './index.js';;

/**
 * Which name resolvers to fall back to when the system one answers with a private address.
 *
 * A router that blackholes a domain — answering `0.0.0.1`, as one was measured doing for a provider
 * host — does not break the *internet*, it breaks the one name. Refusing the provider outright turns
 * that into "this card does not work", which is true of the card and false of the network, and the
 * user is given no way to tell the two apart.
 *
 * The reference implementation (`OmniHilbras.old2/open-sse/utils/proxyFetch.js`) resolves through
 * Google DNS for exactly this reason. This is the same idea, narrowed: the public resolver is asked
 * **only** when the system answer is private, so a working machine does no extra traffic and a
 * deliberately-blocked name still has to survive the same public-address check.
 */
/**
 * The public resolvers, read at call time rather than module load.
 *
 * An embedder that passes a configuration object (or a test that sets the variable after import)
 * otherwise gets the process's boot-time value. Only IPv4 literals are accepted; a hostname here
 * would be resolved by the system resolver before the very check this exists to perform.
 */
function publicDnsServers(): string[] {
  return (process.env.OMNIHILBRAS_PUBLIC_DNS ?? '8.8.8.8,8.8.4.4')
    .split(',')
    .map((server) => server.trim())
    .filter((server) => /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/.test(server));
}

async function resolvePublicly(hostname: string, timeoutMs = 4000): Promise<string[]> {
  const servers = publicDnsServers();
  if (servers.length === 0) return [];
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  resolver.setServers(servers);
  try {
    return await resolver.resolve4(hostname);
  } catch {
    return [];
  }
}

/**
 * The addresses a hostname should be judged on.
 *
 * Normally this is what the system says. When the system says a *private* address, the same name is
 * asked again of a public resolver, and the two sets are judged together: a name that is private
 * everywhere stays refused, and a name the local resolver invented is rescued.
 *
 * Returned together rather than replacing one with the other, because the transport will connect
 * through whatever resolution it does itself — refusing on any private answer is the safe rule, and
 * the rescue only helps if the public answer is the only public one.
 *
 * The system lookup is also **bounded**: measured on 2026-11, this network's resolver answered some
 * names in 10ms and stalled twenty seconds on others — `inference-api.nousresearch.com` and
 * `api.beatapi.io` hung the full getaddrinfo window while public resolvers held their answers in
 * under 50ms. A stalled lookup is therefore treated like any other unresolvable answer: the public
 * resolver gets its chance, and the check costs a bounded wait instead of a twenty-second stall.
 */
const SYSTEM_LOOKUP_TIMEOUT_MS = 2_500;

export async function resolveForDestinationCheck(hostname: string, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  let addresses: string[];
  try {
    const lookupWork = lookup(hostname, { all: true, verbatim: true });
    const stalled = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`the system resolver did not answer ${hostname} within ${SYSTEM_LOOKUP_TIMEOUT_MS}ms`)), SYSTEM_LOOKUP_TIMEOUT_MS);
      // The losing lookup must not become an unhandled rejection when the timer wins the race.
      lookupWork.catch(() => {});
      timer.unref?.();
    });
    addresses = (await raceAbort(Promise.race([lookupWork, stalled]), signal)).map((entry) => entry.address);
  } catch (error) {
    if (signal?.aborted) throw error;
    // A resolver that fails or stalls is not a verdict about the host: fall through with no local
    // answer and let the public resolver speak, exactly as a private answer would.
    addresses = [];
  }
  // Rescue when the local answer is missing or private — both mean the local resolver is not the
  // authority on this name.
  if (!publicDnsServers().length || (addresses.length > 0 && !addresses.some((address) => isPrivateHostname(address)))) return addresses;

  const published = await resolvePublicly(hostname);
  if (published.length === 0) {
    // Nothing public either: the caller still gets the local answer (possibly none), which is what
    // "did not resolve" was before the rescue existed.
    if (addresses.length === 0) throw new Error(`The host ${hostname} did not resolve.`);
    return addresses;
  }
  // A name blocked locally is the common case; a name that is private *everywhere* keeps every
  // private answer, so the judgement below still refuses it.
  const systemIsAllPrivate = addresses.every((address) => isPrivateHostname(address));
  return systemIsAllPrivate ? published : [...addresses, ...published];
}

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
  const addresses = await resolveForDestinationCheck(hostname, signal);
  if (addresses.length === 0) throw new Error(`The host ${hostname} did not resolve.`);
  if (addresses.some((address) => isPrivateHostname(address))) {
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
