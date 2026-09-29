import { ProviderError, type ProviderAdapter } from '@hilbras/omnihilbras';

/**
 * A capability an adapter does not have, named as such.
 *
 * Moved out of `service.ts` because a *second* consumer needed it and importing a private function
 * from the composition root would have been backwards.
 *
 * The message names the adapter and the capability rather than saying something generic, because
 * the two look identical from outside and mean opposite things to act on: an adapter that cannot do
 * this is not broken, and telling a user their provider is unavailable when the truth is that it
 * never advertised the feature sends them looking in the wrong place.
 */
export function notSupported(adapter: ProviderAdapter, capability: string): ProviderError {
  return new ProviderError('NOT_SUPPORTED', `${adapter.name} does not support ${capability}.`, {
    providerId: adapter.id,
    // Kept in the public message as well, because this is what a user sees and the provider's own
    // name is the part that tells them which card in the dashboard is responsible.
    publicMessage: `${adapter.name} does not support ${capability}.`,
  });
}
