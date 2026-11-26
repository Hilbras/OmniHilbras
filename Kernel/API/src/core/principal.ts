import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthContext } from './runtime.js';
import type { Budget } from './budgets.js';

/**
 * Who a request belongs to, for the records it writes.
 *
 * ## Why this is ambient rather than a parameter
 *
 * A usage record is written from the inference handlers, the fetch/search handlers and the video
 * route — more than twenty call sites, some deep inside streaming callbacks that outlive the
 * handler's lexical scope. Threading a principal through every one is a change that is easy to
 * finish ninety percent of, and the missing ten percent would be exactly the routes nobody looks
 * at. The request already has an ambient identity (its abort signal, its request id); this adds the
 * answer to "who" to that ambient set, set once at the HTTP boundary where authentication happened.
 *
 * `AsyncLocalStorage` keeps it correct under concurrency: two requests being served at once have
 * two stores, so a slow stream cannot borrow a later request's key.
 *
 * The fallback is deliberate. A call outside a request — a test, a background sweep, the CLI —
 * records `anonymous`, which is a fact, not a guess.
 */
export type RequestPrincipal = {
  actor: 'key' | 'dashboard' | 'anonymous';
  apiKeyId?: string;
  apiKeyPrefix?: string;
  workspaceId?: string;
  /** The key's own budget, carried so the gate does not read the key store per request. */
  budget?: Budget;
  /** The key's tokens-per-minute limit. */
  tpm?: number;
  /** The key's provider allowlist, if it has one. */
  allowedProviders?: string[];
  /** The key's model allowlist, if it has one. */
  allowedModels?: string[];
  /** The key's route allowlist, if it has one. */
  allowedRoutes?: string[];
};

const storage = new AsyncLocalStorage<RequestPrincipal>();

/** Maps the HTTP auth decision to the record's vocabulary. One place, so the two cannot drift. */
export function principalFromAuth(auth: AuthContext | undefined): RequestPrincipal {
  if (auth?.kind === 'api-key' && auth.apiKey) {
    return {
      actor: 'key',
      apiKeyId: auth.apiKey.id,
      apiKeyPrefix: auth.apiKey.prefix,
      ...(auth.apiKey.workspaceId === undefined ? {} : { workspaceId: auth.apiKey.workspaceId }),
      ...(auth.apiKey.budget === undefined ? {} : { budget: auth.apiKey.budget }),
      ...(auth.apiKey.tpm === undefined ? {} : { tpm: auth.apiKey.tpm }),
      ...(auth.apiKey.allowedProviders === undefined ? {} : { allowedProviders: auth.apiKey.allowedProviders }),
      ...(auth.apiKey.allowedModels === undefined ? {} : { allowedModels: auth.apiKey.allowedModels }),
      ...(auth.apiKey.allowedRoutes === undefined ? {} : { allowedRoutes: auth.apiKey.allowedRoutes }),
    };
  }
  if (auth?.kind === 'dashboard') return { actor: 'dashboard' };
  return { actor: 'anonymous' };
}

/** Runs `fn` with this request's principal visible to everything it calls, including async work. */
export function runWithPrincipal<T>(principal: RequestPrincipal, fn: () => T): T {
  return storage.run(principal, fn);
}

/** The principal of the request being served, if there is one. */
export function currentPrincipal(): RequestPrincipal | undefined {
  return storage.getStore();
}

/** The fields a usage record carries, with `anonymous` as the honest default. */
export function principalUsageFields(
  principal: RequestPrincipal | undefined,
): Pick<RequestPrincipal, 'actor' | 'apiKeyId' | 'apiKeyPrefix' | 'workspaceId'> {
  const resolved = principal ?? { actor: 'anonymous' as const };
  return {
    actor: resolved.actor,
    ...(resolved.apiKeyId === undefined ? {} : { apiKeyId: resolved.apiKeyId }),
    ...(resolved.apiKeyPrefix === undefined ? {} : { apiKeyPrefix: resolved.apiKeyPrefix }),
    ...(resolved.workspaceId === undefined ? {} : { workspaceId: resolved.workspaceId }),
  };
}
