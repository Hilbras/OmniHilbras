import type { ProviderAdapter, ProviderCredential, ProviderRequestContext } from './index.js';
import type { ConnectionSecretStore } from './runtime.js';

/**
 * One contract for a credential's lifecycle, with the Core owning *when* and the adapter owning *how*.
 *
 * `CredentialLifecycle` already answers "has this expired?" without a request. This is the other
 * half: describe what the credential is, refresh it when the adapter can, and revoke it by removing
 * the secret from the store. It wraps the adapter methods the renewal pass already trusts, so the
 * first implementation changes no wire behavior; lifecycle providers can adopt it without each one
 * teaching the Core a new branch.
 */
export type CredentialDescription = {
  type: ProviderCredential['type'];
  expiresAt?: string;
  /** Within the renewal window, or already past it. */
  expiring: boolean;
  /** The adapter has a renewal path. */
  renewable: boolean;
  /** The store can forget it. */
  revocable: boolean;
};

export interface CredentialProvisioner {
  describe(credential: ProviderCredential, now?: number): CredentialDescription;
  refresh(credential: ProviderCredential, context?: ProviderRequestContext): Promise<ProviderCredential | undefined>;
  revoke(connectionId: string): Promise<boolean>;
}

export type ProvisionerAdapter = Pick<ProviderAdapter, 'renewCredential'> & { isCredentialExpired?: ProviderAdapter['isCredentialExpired'] };

const defaultRenewalWindowMs = 30 * 60_000;

export class AdapterCredentialProvisioner implements CredentialProvisioner {
  constructor(
    private readonly adapter: ProvisionerAdapter,
    private readonly secrets: Pick<ConnectionSecretStore, 'delete'>,
    private readonly renewalWindowMs = defaultRenewalWindowMs,
  ) {}

  describe(credential: ProviderCredential, now = Date.now()): CredentialDescription {
    const expiresAt = credential.type === 'oauth' && typeof credential.expiresAt === 'string' ? credential.expiresAt : undefined;
    const expires = expiresAt ? Date.parse(expiresAt) : Number.NaN;
    let expiring = false;
    if (Number.isFinite(expires)) {
      const horizon = now + this.renewalWindowMs;
      expiring = typeof this.adapter.isCredentialExpired === 'function'
        ? this.adapter.isCredentialExpired(credential, horizon) === true
        : expires <= horizon;
    }
    return {
      type: credential.type,
      ...(expiresAt ? { expiresAt } : {}),
      expiring,
      renewable: typeof this.adapter.renewCredential === 'function',
      revocable: true,
    };
  }

  async refresh(credential: ProviderCredential, _context?: ProviderRequestContext) {
    if (typeof this.adapter.renewCredential !== 'function') return undefined;
    const renewed = await this.adapter.renewCredential(credential);
    return renewed ?? undefined;
  }

  revoke(connectionId: string) {
    return this.secrets.delete(connectionId);
  }
}
