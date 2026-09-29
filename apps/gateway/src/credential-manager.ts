import type { ProviderRequestContext, ProviderCredential, ModelImportPolicy } from '@hilbras/omnihilbras';
import type { ConnectionManager } from './connection-manager.js';
import { withRequestScope, type RequestScope } from './request-context.js';

/**
 * The credential surface one request is made with.
 *
 * Extracted because the answer to *"which connection serves this provider, and what context does it
 * need?"* was written in five places, with the local variable named differently at each — `owner`
 * twice, `connection` twice — and one of the five was already a method whose entire purpose was to
 * be the single answer. That method's own comment said the point was that *a credential cannot be
 * assembled one way for a health check and another for a real request*, which is precisely what
 * four inline copies undermine: nothing held them equal, and the provider-id-versus-connection-id
 * mix-up that this exact seam is prone to had already happened once, one layer up, in the adapter
 * factories.
 *
 * ## The one thing that must not vary
 *
 * A request is made in a context built from a **connection id**, not a provider id. Those are
 * usually the same string and sometimes not, and a credential looked up under the wrong one is
 * either missing — which fails as a confusing authentication error — or, worse, another
 * connection's. So the fallback to the provider id is confined to here, once, and every caller
 * goes through it.
 *
 * ## Why the model policy travels with the credential
 *
 * The connection's own import policy is read here rather than at the call site, because the
 * difference between a `free` import and an `all` import has to be the same whether a catalog is
 * read during a connect, during a manual refresh, or by a health poll. A dashboard that shows the
 * narrow list while a refresh silently restores the full one is a switch that stops working once
 * you stop looking at it.
 */

/** Reads and writes one connection's credential. */
export type CredentialReader = {
  get(connectionId: string, providerId: string): Promise<ProviderCredential | undefined>;
};

export class CredentialManager {
  constructor(
    private readonly secrets: CredentialReader,
    private readonly connections: ConnectionManager,
  ) {}

  /**
   * The context for one specific connection.
   *
   * The credential and the policy are read together because they come from two places and belong
   * to one decision: a request is made with this credential *under this policy*, and reading one
   * without the other is how a `free` connection comes back in full.
   */
  async context(connectionId: string, providerId: string, signal?: AbortSignal): Promise<ProviderRequestContext> {
    const [credential, policy] = await Promise.all([
      this.secrets.get(connectionId, providerId),
      // A store without `list` simply has no policy to honour, so this is optional rather than
      // fatal: an embedded service with a bare credential source is a supported shape.
      this.connections.list().then((all) => all.find((entry) => entry.id === connectionId)?.modelPolicy),
    ]);
    return {
      credential,
      ...(policy ? { importPolicy: policy as ModelImportPolicy } : {}),
      ...(signal ? { signal } : {}),
    };
  }

  /**
   * The context for whatever connection serves a provider, and the fallback when it has none.
   *
   * The fallback matters: a provider registered but not connected is still asked for a health
   * check, and there is no credential to look up, so the provider id stands in for the connection
   * id and the adapter's own "no credential" path reports it. Failing instead would make an
   * unconnected provider look broken rather than unconnected.
   */
  async contextForProvider(providerId: string, signal?: AbortSignal, scope?: RequestScope): Promise<ProviderRequestContext> {
    const owner = await this.connections.firstWithCredentialFor(providerId);
    const context = await this.context(owner?.id ?? providerId, providerId, signal);
    // Optional, because an embedded caller that does not track request identity still works — the
    // context is the SDK's type and the adapter boundary is published, so this only ever *adds* a
    // field that already existed.
    return scope ? withRequestScope(context, scope) : context;
  }
}
