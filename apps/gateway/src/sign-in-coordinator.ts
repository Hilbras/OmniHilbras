import { ProviderError, type ProviderCredential } from '@hilbras/omnihilbras';
import { providerSaid } from './oauth.js';
import type { ConnectionInput, ConnectionRecord } from './connections.js';
import type { SignInSessionBase } from './sign-in-sessions.js';

/**
 * Finishing a sign-in: poll, store, and say what went wrong.
 *
 * Extracted because three places were doing it and they had already drifted. The failure describer
 * existed three times, and the copies were not equal:
 *
 * ```ts
 * const said = error instanceof ProviderError ? providerSaid(error) : undefined;
 * const message = error instanceof ProviderError
 *   ? [error.publicMessage ?? error.message, said].filter(Boolean).join(' ')
 *   : error instanceof Error ? error.message : '…could not be completed.';
 * ```
 *
 * One of the three had lost its `error instanceof Error` branch. That is not a cosmetic difference:
 * a Cline sign-in that failed with a plain error — a socket closed, a body that would not parse —
 * reported *"The sign-in could not be completed."* and nothing else. The user is told the sign-in
 * did not work and not why, which is the one thing a failed sign-in must never do. The three copies
 * also carried three different generic fallbacks, so there was nothing to keep them equal.
 *
 * ## What the describer prefers, and why
 *
 * **The provider's own words, then ours, then a fallback.** A gateway's generic refusal is written
 * for a log line and says nothing actionable; the provider's status and body are the part that
 * names the cause. Both are kept, in that order, because they are not the same information: the
 * public message is what the user reads, and the provider's words are what identifies the fault.
 * When there is no `ProviderError` at all, an `Error`'s own message is used rather than the
 * fallback — which is the branch one of the three copies was missing.
 */

/**
 * The best available description of why a sign-in failed.
 *
 * `fallback` is only reached when there is genuinely nothing to say: a thrown value that is not an
 * `Error` at all.
 */
export function describeSignInFailure(error: unknown, fallback: string): string {
  if (error instanceof ProviderError) {
    return [error.publicMessage ?? error.message, providerSaid(error)].filter(Boolean).join(' ');
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/** What polling a provider's device or browser flow can conclude. */
export type SignInPollOutcome =
  | { status: 'pending' }
  | { status: 'denied'; error: string }
  | { status: 'connected'; credential: ProviderCredential };

/**
 * The session store surface this coordinator needs.
 *
 * Structural rather than a concrete class, because the two flows that use it hold differently
 * shaped sessions — Kiro nests its device authorization, Console flattens it — and the coordinator
 * has no business knowing which.
 */
export type SignInSessions<TStatus, TSession extends SignInSessionBase> = {
  get(id: string): TSession | undefined;
  claim(id: string): TSession | undefined;
  release(session: TSession): void;
  resolve(id: string, patch: { status: SignInSessionBase['status']; connection?: unknown; error?: string }): void;
  publicStatus(session: TSession): TStatus;
};

export type CompleteSignInOptions<TStatus, TSession extends SignInSessionBase> = {
  sessions: SignInSessions<TStatus, TSession>;
  sessionId: string;
  /** Asks the provider. Must not itself claim the session; the coordinator does that. */
  poll: () => Promise<SignInPollOutcome>;
  /** The connection to store, given the credential the provider handed over. */
  connection: (credential: ProviderCredential) => ConnectionInput | Promise<ConnectionInput>;
  save: (input: ConnectionInput, credential: ProviderCredential, signal?: AbortSignal) => Promise<ConnectionRecord>;
  signal?: AbortSignal;
  /**
   * Takes the note left by a tolerated discovery failure, clearing it.
   *
   * Taken rather than read, so a note cannot be shown twice: the dashboard reads this status once
   * and a second read of the same failure is a stale message on a healthy connection.
   */
  takeDiscoveryNote: () => string | undefined;
  /** Used only when the thrown value is not an `Error` at all. */
  fallback: string;
};

/**
 * Runs one poll of a sign-in to its conclusion.
 *
 * The order is the substance:
 *
 * 1. **Claim before polling.** Two browser tabs polling the same session would otherwise both spend
 *    the same grant, and the second attempt fails at the provider with an error that looks like a
 *    bug rather than a race.
 * 2. **Release on `pending`.** Nothing was spent, so the next poll may try again. Not releasing here
 *    would strand the sign-in: the claim is spent, so no later poll could ever finish it.
 * 3. **Save before resolving as connected.** A session that says `connected` with no connection
 *    behind it is the half-connect this whole file exists to prevent — the dashboard renders it as
 *    working and the first request fails.
 * 4. **A failed save resolves as `failed`, not `connected`.** So the user is told the truth, and
 *    the credential is not silently dropped.
 */
export async function completeSignIn<TStatus, TSession extends SignInSessionBase>(
  options: CompleteSignInOptions<TStatus, TSession>,
): Promise<TStatus | undefined> {
  const { sessions, sessionId, signal, fallback, takeDiscoveryNote } = options;
  const session = sessions.get(sessionId);
  if (!session) return undefined;

  // Another poll owns the exchange. Report the session as it stands rather than racing it, and let
  // that poll publish the outcome.
  if (!sessions.claim(sessionId)) return sessions.publicStatus(session);

  const outcome = await options.poll();

  if (outcome.status === 'pending') {
    sessions.release(session);
    return sessions.publicStatus(session);
  }
  if (outcome.status === 'denied') {
    sessions.resolve(sessionId, { status: 'failed', error: outcome.error });
    return sessions.publicStatus(session);
  }

  try {
    const connection = await options.save(
      await options.connection(outcome.credential),
      outcome.credential,
      signal,
    );
    const note = takeDiscoveryNote();
    sessions.resolve(sessionId, {
      status: 'connected',
      connection,
      // Connected *and* something worth saying, rather than one or the other: a user whose models
      // did not load needs to see the connection succeed and the reason it is still empty.
      ...(note ? { error: `Connected, but the model list could not be read: ${note}` } : {}),
    });
  } catch (error) {
    sessions.resolve(sessionId, { status: 'failed', error: describeSignInFailure(error, fallback) });
  }
  return sessions.publicStatus(session);
}
