import { createHash, randomBytes } from 'node:crypto';
import { claudeCodeAuthorizeUrl, claudeCodeProviderId, exchangeClaudeCodeCode, splitCallbackFragment } from '@hilbras/omnihilbras';
import { SignInSessionStore } from './sign-in-sessions.js';
import { claudeCodeCallbackPath } from './oauth.js';
import type { ProviderCredential } from '@hilbras/omnihilbras';

/**
 * Claude Code sign-in — an authorization-code flow with PKCE, and a browser redirect.
 *
 * ## Why this is not the Kimi device flow
 *
 * Kimi issues a device code the user approves on a page; there is no callback to receive. Claude Code
 * redirects the browser back to a URL the gateway must answer, so it needs somewhere to send the user and
 * something to receive what comes back.
 *
 * That last part is the whole reason the authorize endpoint cannot be fetched server-side: probed, it
 * answers `403 "Just a moment..."` — a Cloudflare interstitial, not a code. So the browser is not a
 * convenience here, it is the only path that works.
 *
 * ## Why the verifier lives on the session
 *
 * PKCE's verifier is the half of the pair that must not be sent to the authorization endpoint, and it has
 * to still exist when the user comes back. Storing it on the sign-in session rather than in a local
 * variable is what makes the flow survive the redirect at all — a verifier kept in a closure is a verifier
 * gone by the time the callback arrives, and the exchange then fails with `invalid_grant` for a code that
 * was correct.
 */

const sessionIdPattern = /^[A-Za-z0-9_-]{16,128}$/;
const defaultTtlMs = 15 * 60_000;

export type ClaudeCodeSessionStatus = {
  status: 'pending' | 'connected' | 'failed' | 'expired';
  /** The URL the user opens. Never the verifier. */
  verificationUrl?: string;
  expiresAt?: string;
  error?: string;
  connection?: unknown;
};

type Session = {
  id: string;
  /** The PKCE verifier. Never leaves this object except in the token exchange. */
  codeVerifier: string;
  redirectUri: string;
  state: string;
  /** Set after creation, because the authorize URL is only known once the challenge is computed. */
  verificationUrl: string;
  expiresAt: number;
  status: ClaudeCodeSessionStatus['status'];
  connection?: unknown;
  error?: string;
  claimed: boolean;
};

/**
 * What `beginClaudeCodeSignIn` hands the store.
 *
 * **Spelled out rather than `Pick<Session, ...>`, and the reason is worth more than the shape.**
 *
 * As the store's own second type argument, `Pick<Session, 'a' | 'b'>` made TypeScript parse `Pick` as a
 * **value** rather than a utility type, and it reported that at the *constructor*: fifteen errors spread
 * across nine lines, none of which mentioned the `Pick` that caused them, and every one pointing at code
 * that was correct. A bisection through the file, a standalone compile, a byte-level read for stray
 * control characters, and three wrong hypotheses all came up empty before the real cause was found.
 *
 * An inline object type compiles immediately. Recorded because the next `Pick` over a locally-declared
 * type in this position will cost the same hour.
 */
type ClaudeCodeSessionInput = {
  codeVerifier: string;
  redirectUri: string;
  state: string;
  verificationUrl: string;
};

export class ClaudeCodeSessionStore {
  /** The input is the whole payload the caller supplies; `read` is what the client ever sees. */
  private readonly store: SignInSessionStore<Session, ClaudeCodeSessionInput>;

  constructor(options: { ttlMs?: number } = {}) {
    this.store = new SignInSessionStore<Session, ClaudeCodeSessionInput>({
      ttlMs: options.ttlMs ?? defaultTtlMs,
      isPlausibleId: (id) => sessionIdPattern.test(id),
      build: (input, { id, expiresAt }) => ({ id, ...input, expiresAt, status: 'pending', claimed: false }),
      // The projection the dashboard polls with. The verifier is not among these fields, and must not be:
      // it is the value that proves the exchange, and this object travels through a browser.
      read: (session) => ({ verificationUrl: session.verificationUrl }),
    });
  }

  /**
   * `verificationUrl` is passed empty and assigned by the caller once the challenge exists, because the
   * URL *is* the challenge — minting the verifier and building the URL are one step.
   */
  create(input: Omit<Session, 'id' | 'expiresAt' | 'status' | 'claimed'>, expiresIn?: number): Session {
    return this.store.create(input, expiresIn);
  }

  get(id: string): Session | undefined {
    return this.store.get(id);
  }

  claim(id: string): Session | undefined {
    return this.store.claim(id);
  }

  /**
   * Releases a claim so the session can be retried.
   *
   * Needed by the failure path: a code the user can re-copy. A session left claimed after a failed
   * exchange would answer 404 for every subsequent callback, which reads as "this sign-in never existed"
   * rather than "that one code did not work".
   */
  release(session: Session) {
    this.store.release(session);
  }

  resolve(id: string, patch: { status: Session['status']; connection?: unknown; error?: string }) {
    this.store.resolve(id, patch);
  }

  /**
   * The projection the dashboard polls with.
   *
   * `verificationUrl` is read out of the store's own projection rather than rebuilt from the session, so
   * the two cannot disagree. **Not cast**: the shared store's projection type also carries `userCode`,
   * and narrowing it here is what made the compiler reject the store's generic — with errors pointing at
   * the *constructor* rather than at the cast. That misdirection is why this took a bisection to find.
   */
  publicStatus(session: Session): ClaudeCodeSessionStatus {
    const { verificationUrl } = this.store.publicStatus(session);
    return {
      status: session.status,
      ...(verificationUrl !== undefined ? { verificationUrl } : {}),
      expiresAt: new Date(session.expiresAt).toISOString(),
      ...(session.error ? { error: session.error } : {}),
      ...(session.connection ? { connection: session.connection } : {}),
    };
  }
}

/**
 * A verifier and its S256 challenge.
 *
 * RFC 7636 requires 43–128 characters of unreserved ASCII from a CSPRNG. 64 bytes of base64url is 86
 * characters, comfortably inside the range, and `Math.random` is not used because a guessable verifier
 * makes PKCE decorative.
 */
export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(64).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** The redirect the user comes back to, derived from the gateway's own public base URL. */
export function claudeCodeRedirectUri(publicBaseUrl: string, sessionId: string): string {
  return `${publicBaseUrl.replace(/\/+$/, '')}${claudeCodeCallbackPath}/${sessionId}`;
}

/**
 * Starts a sign-in: mints the pair, opens the session, and returns the URL to open.
 *
 * `state` is minted here and checked on the way back. It is a CSPRNG value, not a timestamp, because it
 * is the value that decides whether a callback belongs to this sign-in.
 *
 * **The session id rides in the redirect path, and that is not decoration.** Claude Code's callback
 * carries `code` and `state` as query parameters, but a provider that does not echo `state` — or echoes
 * a different one — would otherwise leave the callback with no way to say *which* sign-in it belongs to,
 * and the code could not be exchanged against the right PKCE verifier. The path is the part of the
 * redirect a provider must honour verbatim, so the id is put there, exactly as Cline's is. The verifier
 * stays on the session and never enters a URL.
 */
export function beginClaudeCodeSignIn(input: { store: ClaudeCodeSessionStore; publicBaseUrl: string }): ClaudeCodeSessionStatus & { sessionId: string } {
  const { verifier, challenge } = generatePkcePair();
  const state = randomBytes(24).toString('base64url');
  // Two steps rather than one: the redirect embeds the id, and the id only exists once the session does.
  // `verificationUrl` is assigned below, once the challenge is known, because the URL *is* the challenge.
  const session = input.store.create({ codeVerifier: verifier, redirectUri: '', state, verificationUrl: '' });
  const redirectUri = claudeCodeRedirectUri(input.publicBaseUrl, session.id);
  session.redirectUri = redirectUri;
  const verificationUrl = claudeCodeAuthorizeUrl({ redirectUri, state, codeChallenge: challenge });
  session.verificationUrl = verificationUrl;
  return { sessionId: session.id, ...input.store.publicStatus(session) };
}

/** The session id carried in a callback path, if the path carries one. Declared with the path in `oauth.ts`. */
export { claudeCodeSessionIdFromCallbackPath } from './oauth.js';

/**
 * Finishes a sign-in from a callback query.
 *
 * The session is **claimed before** the exchange. An authorization code is single-use, and two callbacks
 * arriving together would otherwise spend it twice: the second be told `invalid_grant`, and a success that
 * already happened be overwritten with a failure.
 */
export async function completeClaudeCodeSignIn(input: {
  store: ClaudeCodeSessionStore;
  sessionId: string;
  /** The whole callback query, so both `code` and `#state` survive. */
  raw: string;
  saveConnection: (connection: { providerId: string; credential: ProviderCredential; label?: string }) => Promise<unknown>;
  transport?: Parameters<typeof exchangeClaudeCodeCode>[0]['transport'];
  signal?: AbortSignal;
}): Promise<ClaudeCodeSessionStatus | undefined> {
  const { store, sessionId, raw, saveConnection, transport, signal } = input;
  const session = store.get(sessionId);
  if (!session) return undefined;

  let code: string;
  let state: string | undefined;
  try {
    ({ code, state } = splitCallbackFragment(raw, session.state));
  } catch (error) {
    store.resolve(sessionId, { status: 'failed', error: error instanceof Error ? error.message : 'That callback does not belong to this sign-in.' });
    return store.publicStatus(store.get(sessionId) ?? session);
  }

  const claimed = store.claim(sessionId);
  if (!claimed) return store.publicStatus(store.get(sessionId) ?? session);

  let credential: ProviderCredential;
  try {
    credential = await exchangeClaudeCodeCode({
      code,
      state,
      codeVerifier: claimed.codeVerifier,
      redirectUri: claimed.redirectUri,
      ...(transport ? { transport } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    // Released so the user can retry with a fresh code, and the reason is Anthropic's own wording.
    store.release(claimed);
    store.resolve(sessionId, { status: 'failed', error: error instanceof Error ? error.message : 'Claude did not complete the sign-in.' });
    return store.publicStatus(store.get(sessionId) ?? claimed);
  }

  const connection = await saveConnection({ providerId: claudeCodeProviderId, credential, label: 'Claude Code subscription' });
  store.resolve(sessionId, { status: 'connected', connection });
  return store.publicStatus(store.get(sessionId) ?? claimed);
}