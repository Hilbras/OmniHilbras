/**
 * The one sign-in session lifecycle.
 *
 * `KiroSessionStore` and `OpencodeConsoleSessionStore` were 67 and 76 lines, and a diff of the two
 * showed the lifecycle is **byte-for-byte identical** — same `create`, same `get`, same `claim`,
 * same `release`, same `resolve`, same `publicStatus`, same `sweep`, the same id pattern, and the
 * same "expired" message. The only differences were the class name, two comment wordings, and a
 * session shape that nested its payload in one provider and flattened it in the other.
 *
 * That mattered most for `claim`:
 *
 * ```ts
 * // Returns the session only if the grant has not already been exchanged.
 * claim(id: string): Session | undefined {
 *   const session = this.get(id);
 *   if (!session || session.claimed) return undefined;
 *   session.claimed = true;
 *   return session;
 * }
 * ```
 *
 * That is the guard which stops two polls spending the same device code — one OAuth grant, billed
 * once. It was implemented twice, in two files, and the copies were free to drift. One
 * implementation of a rule that spends someone's money is worth more than two consistent ones.
 *
 * ## What stays with a provider
 *
 * The session's own shape. Callers read `session.authorization` for Kiro and `session.deviceCode`
 * for OpenCode Console, and both of those are the provider's business. What is *not* a provider's
 * business — how a session expires, how a grant is claimed exactly once, how a public status is
 * projected — is here, and a provider supplies the two functions that decide its shape.
 */

export type SignInStatus = 'pending' | 'connected' | 'failed' | 'expired';

/**
 * The rule that a grant is spent exactly once, with no session shape assumed.
 *
 * This exists because the rule is implemented in *three* places and only two of them share a
 * lifecycle. `SignInSessionStore.claim` and `KiroSocialStore.claim` are the same six lines, and they
 * are six lines about whether someone's OAuth code can be spent twice — not something to have in
 * three files.
 *
 * The third store, `KiroSocialStore`, differs in almost everything else: it expires on `createdAt`
 * rather than an expiry, it *deletes* an expired session instead of marking it, its `create`
 * returns only an id, and it has no public status. None of that is the same rule, so none of it is
 * unified here. Only the spending is.
 */
export function claimOnce<TSession extends { claimed?: boolean }>(read: () => TSession | undefined): TSession | undefined {
  const session = read();
  if (!session || session.claimed) return undefined;
  session.claimed = true;
  return session;
}

/** Puts a grant back in play after a failed exchange, so a retry can finish it. */
export function releaseClaim(session: { claimed?: boolean }) {
  session.claimed = false;
}

/** The fields every sign-in session has, whatever the provider puts alongside them. */
export type SignInSessionBase = {
  id: string;
  expiresAt: number;
  status: SignInStatus;
  connection?: unknown;
  error?: string;
  /**
   * Set once the grant has been claimed, so two polls cannot spend the same one.
   *
   * The most consequential field in this file. A session whose grant can be claimed twice is an
   * OAuth grant spent twice, and the second spend fails at the provider with an error that looks
   * like a bug rather than a race.
   */
  claimed: boolean;
};

/** What a client is told while a sign-in is in progress. */
export type SignInPublicStatus = {
  status: SignInStatus;
  userCode?: string;
  verificationUrl?: string;
  expiresAt?: string;
  error?: string;
  connection?: unknown;
};

export type SignInSessionStoreOptions<TSession extends SignInSessionBase, TInput> = {
  /**
   * The hard ceiling on a session's life, whatever the provider asks for.
   *
   * A provider that says its grant is good for a day must not be able to park a credential-bearing
   * payload in memory for a day, because the window a user actually signs in within is minutes.
   */
  ttlMs: number;
  /** Whether an id is even shaped like one of ours, checked before the map is touched. */
  isPlausibleId: (id: string) => boolean;
  /**
   * Builds the provider's own session shape from its own input and the id and expiry this store
   * computed. The provider decides what a session *carries*; this store decides when it *dies*.
   */
  build: (input: TInput, base: { id: string; expiresAt: number }) => TSession;
  /** The code the user types, and the URL they open. The two fields a public status must carry. */
  read: (session: TSession) => { userCode?: string; verificationUrl?: string };
  now?: () => number;
};

export class SignInSessionStore<TSession extends SignInSessionBase, TInput = void> {
  private readonly sessions = new Map<string, TSession>();
  private readonly ttlMs: number;
  private readonly isPlausibleId: (id: string) => boolean;
  private readonly build: (input: TInput, base: { id: string; expiresAt: number }) => TSession;
  private readonly read: (session: TSession) => { userCode?: string; verificationUrl?: string };
  private readonly now: () => number;

  constructor(options: SignInSessionStoreOptions<TSession, TInput>) {
    this.ttlMs = options.ttlMs;
    this.isPlausibleId = options.isPlausibleId;
    this.build = options.build;
    this.read = options.read;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Opens a session, capped by this store's ceiling.
   *
   * The cap is the point: the provider says how long its grant is good for, and this store decides
   * how long it will *hold* it. A provider asking for a day gets the ceiling.
   *
   * When the provider says nothing, it gets the ceiling too — which is this store's own opinion
   * about how long to hold a sign-in, and the only number here whose units are known.
   *
   * The two stores this replaced both wrote the fallback as `(ttlMs / 60000) * 1000`, which is
   * `ttlMs / 60`: a 15-minute ceiling silently became a **15-second** session. It hid because every
   * provider that works happens to send `expires_in`, and the conversion only runs on the path
   * where one does not. It is spelled out here in seconds and milliseconds so the arithmetic
   * cannot be wrong quietly again.
   */
  create(input: TInput, expiresInSeconds?: number): TSession {
    this.sweep();
    const id = crypto.randomUUID().replace(/-/g, '');
    const requestedMs = expiresInSeconds === undefined ? this.ttlMs : expiresInSeconds * 1000;
    const ttl = Math.min(this.ttlMs, requestedMs);
    const session = this.build(input, { id, expiresAt: this.now() + ttl });
    this.sessions.set(id, session);
    return session;
  }

  /**
   * A session by id, expired on the way out.
   *
   * Expiry is applied here rather than by the sweeper so a session that has just timed out reads as
   * `expired` with a message the user can act on, rather than as absent. "Not found" and "you let
   * it lapse" are different problems and the dashboard says different things about them.
   */
  get(id: string): TSession | undefined {
    if (!this.isPlausibleId(id)) return undefined;
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (session.status === 'pending' && this.now() >= session.expiresAt) {
      session.status = 'expired';
      session.error = 'This sign-in expired before it was approved. Start again from OmniHilbras.';
    }
    return session;
  }

  /** Returns the session only if the grant has not already been claimed. */
  claim(id: string): TSession | undefined {
    return claimOnce(() => this.get(id));
  }

  /**
   * Puts a session back in play after a failed exchange, so a retry can finish it.
   *
   * Without this, a transient network failure during the exchange would burn the sign-in and leave
   * starting over as the only option — for a failure that was ours, not the user's.
   */
  release(session: TSession) {
    releaseClaim(session);
  }

  resolve(id: string, patch: { status: SignInStatus; connection?: unknown; error?: string }) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.status = patch.status;
    if (patch.connection !== undefined) session.connection = patch.connection;
    if (patch.error !== undefined) session.error = patch.error;
  }

  /**
   * The projection a client sees.
   *
   * Only what the user needs in order to continue — never the provider's own payload. A sign-in
   * session holds a device code, and a device code is a credential.
   */
  publicStatus(session: TSession): SignInPublicStatus {
    const { userCode, verificationUrl } = this.read(session);
    return {
      status: session.status,
      ...(userCode !== undefined ? { userCode } : {}),
      ...(verificationUrl !== undefined ? { verificationUrl } : {}),
      expiresAt: new Date(session.expiresAt).toISOString(),
      ...(session.error ? { error: session.error } : {}),
      ...(session.connection !== undefined ? { connection: session.connection } : {}),
    };
  }

  /** Forgets sessions old enough that nothing can still claim them. */
  private sweep() {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, session] of this.sessions) {
      if (session.expiresAt < cutoff) this.sessions.delete(id);
    }
  }

  /** How many sessions are held, for a diagnostic and for tests. */
  get size(): number {
    return this.sessions.size;
  }
}
