import { ProviderError, type ProviderAdapter, type ProviderCredential } from '@hilbras/omnihilbras';

/**
 * Whether a stored credential is still usable, answered before anything is spent.
 *
 * Every credential this project stores carries an expiry, and for two of them nothing ever read it.
 * That is not an abstract concern: a ChatGPT Web health check *launches a browser*, so a connection
 * whose session ended an hour ago was launching one on every sweep to be told what the stored
 * credential already said in writing. Cline was the same shape at lower cost.
 *
 * ## What this does, and what it deliberately does not
 *
 * It **pre-checks**. A credential that is not expired may still have been revoked, so the network
 * check still happens and still decides. This only answers the one question that needs no network,
 * and a pre-check that could be wrong in the expensive direction would make things worse rather than
 * better — so every uncertainty here resolves to *"cannot say"*, which means "go and ask".
 *
 * That direction is the whole design. Three ways to be wrong, and only one of them is safe:
 *
 * - A credential is **not** expired when it is → a request is spent to find out. Cheap.
 * - The expiry is **unreadable** → the network check answers. Cheap.
 * - A credential **is** called expired when it is not → a working connection is ejected and a
 *   user's connection appears broken. Expensive, and why the parse guard exists at all.
 */

/** What the gateway can say about a credential without asking the provider. */
export type CredentialStanding =
  /** The credential says it has ended. No request was spent to learn this. */
  | { state: 'expired'; expiresAt?: string }
  /** The credential is valid as far as anyone can tell locally. Still worth a network check. */
  | { state: 'valid' }
  /** Nobody can say — no expiry, an unparseable one, or no adapter to ask. Go and ask the provider. */
  | { state: 'unknown' };

export type CredentialLifecycleDeps = {
  /**
   * The adapter that could answer, or `undefined` for a provider that has none.
   *
   * Asked rather than resolved, so a provider with no adapter — a saved connection whose provider
   * has been removed from the SDK — reports `unknown` instead of throwing. That is a configuration
   * state the operator needs to see, not an error to throw over a health sweep.
   */
  adapterFor: (providerId: string) => ProviderAdapter | undefined;
  now?: () => number;
};

export class CredentialLifecycle {
  private readonly now: () => number;

  constructor(private readonly deps: CredentialLifecycleDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * What the stored credential says about itself.
   *
   * Only an adapter that implements `isCredentialExpired` can answer; every other case is
   * `unknown`, including an absent credential, which is a *configuration* state rather than an
   * expired one — the dashboard says "no credential" for that, and must not say "expired".
   */
  standing(providerId: string, credential: ProviderCredential | undefined): CredentialStanding {
    if (!credential || credential.type === 'none') return { state: 'unknown' };
    const adapter = this.deps.adapterFor(providerId);
    if (!adapter?.isCredentialExpired) return { state: 'unknown' };
    try {
      // `undefined` from the adapter is *cannot say*, which is the whole reason the method returns
      // three states rather than a boolean. Reading it as `false` here would turn an adapter's
      // uncertainty into a confident "valid" and send a request that cannot succeed.
      const verdict = adapter.isCredentialExpired(credential, this.now());
      if (verdict === undefined) return { state: 'unknown' };
      return { state: verdict ? 'expired' : 'valid' };
    } catch {
      // A provider's expiry check throwing is the provider's bug, and the safe response is to go
      // and ask it. Letting it escape would take a health sweep down over one adapter.
      return { state: 'unknown' };
    }
  }

  /**
   * Whether a request may be attempted without first spending a check.
   *
   * The one question the health path asks. `valid` and `unknown` both mean *ask the provider*; only
   * `expired` means the answer is already known.
   */
  needsNetworkCheck(providerId: string, credential: ProviderCredential | undefined): boolean {
    return this.standing(providerId, credential).state !== 'expired';
  }

  /**
   * The refusal for a credential that is already known to have ended.
   *
   * `AUTHENTICATION_FAILED` and not `PROVIDER_UNAVAILABLE`, because this is the difference that
   * matters to the person reading it: a session that ended is fixed by signing in again, while a
   * provider being unavailable is not fixed by anything they can do. Getting it backwards sends
   * them to wait for a provider that is perfectly healthy.
   */
  expiredRefusal(providerId: string, standing: CredentialStanding): ProviderError {
    const message = standing.state === 'expired' && standing.expiresAt
      ? `This connection's session expired on ${new Date(standing.expiresAt).toISOString()}. Sign in again.`
      : 'This connection’s session has expired. Sign in again.';
    return new ProviderError('AUTHENTICATION_FAILED', message, { providerId, publicMessage: message });
  }
}
