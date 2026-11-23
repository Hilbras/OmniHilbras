import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  CLAUDE,
  exchangeClaudeCode,
  splitCallbackFragment,
  claudeAuthorizeUrl,
} from '@omnihilbras/sdk-claude';
import type { ProviderCredential } from '../core/index.js';
import { SignInSessionStore } from '../core/sign-in-sessions.js';
import { claudeCallbackPath } from '../core/oauth.js';
import { generatePkcePair } from './claudeCode.js';

/**
 * The `claude` sign-in: authorization code + PKCE S256 in the user's own browser.
 *
 * This is the same shape as Claude Code's flow, but it is a **separate id, card, connection and
 * adapter**. Two cards that share one grant would show the other card's catalog and usage, which is
 * the defect Cline and ClinePass had to be split apart to fix.
 *
 * Two checks are enforced here rather than left to the provider:
 *
 * - **Exact redirect matching.** The `redirect_uri` sent at creation is stored on the session. A
 *   later exchange that names any other string is refused before a token request is made. A prefix
 *   or URL-object comparison would accept a same-origin path with an extra query parameter, which is
 *   enough to send the code to a callback the operator never registered.
 * - **The PKCE verifier is the session's, not the caller's.** A caller may present a `codeVerifier`
 *   to the exchange route; if it does, it must match the stored one byte-for-byte in constant time.
 *   The value actually sent upstream is always the stored verifier. A wrong verifier therefore fails
 *   here, and a wrong verifier that reaches the provider fails there as `invalid_grant`.
 */

const sessionIdPattern = /^[A-Za-z0-9_-]{16,128}$/;
const defaultTtlMs = 15 * 60_000;

export type ClaudeSessionStatus = {
  status: 'pending' | 'connected' | 'failed' | 'expired';
  /** The URL the user opens. Never the verifier. */
  verificationUrl?: string;
  redirectUri?: string;
  expiresAt?: string;
  error?: string;
  connection?: unknown;
};

type Session = {
  id: string;
  codeVerifier: string;
  redirectUri: string;
  state: string;
  verificationUrl: string;
  expiresAt: number;
  status: ClaudeSessionStatus['status'];
  connection?: unknown;
  error?: string;
  claimed: boolean;
  connectionId?: string;
};

type SessionInput = {
  codeVerifier: string;
  redirectUri: string;
  state: string;
  verificationUrl: string;
  connectionId?: string;
};

export class ClaudeSessionStore {
  private readonly store: SignInSessionStore<Session, SessionInput>;

  constructor(options: { ttlMs?: number } = {}) {
    this.store = new SignInSessionStore<Session, SessionInput>({
      ttlMs: options.ttlMs ?? defaultTtlMs,
      isPlausibleId: (id) => sessionIdPattern.test(id),
      build: (input, { id, expiresAt }) => ({ id, ...input, expiresAt, status: 'pending', claimed: false }),
      // The verifier is proof, not status. It is never in the object the browser polls.
      read: (session) => ({ verificationUrl: session.verificationUrl }),
    });
  }

  create(input: Omit<Session, 'id' | 'expiresAt' | 'status' | 'claimed'>): Session {
    return this.store.create(input);
  }

  get(id: string): Session | undefined {
    return this.store.get(id);
  }

  claim(id: string): Session | undefined {
    return this.store.claim(id);
  }

  release(session: Session): void {
    this.store.release(session);
  }

  resolve(id: string, patch: { status: Session['status']; connection?: unknown; error?: string }): void {
    this.store.resolve(id, patch);
  }

  publicStatus(session: Session): ClaudeSessionStatus {
    const { verificationUrl } = this.store.publicStatus(session);
    return {
      status: session.status,
      ...(verificationUrl ? { verificationUrl } : {}),
      redirectUri: session.redirectUri,
      expiresAt: new Date(session.expiresAt).toISOString(),
      ...(session.error ? { error: session.error } : {}),
      ...(session.connection ? { connection: session.connection } : {}),
    };
  }
}

/** The redirect is derived from the gateway's public base URL and carries the session in its path. */
export function claudeRedirectUri(publicBaseUrl: string, sessionId: string): string {
  return `${publicBaseUrl.replace(/\/+$/, '')}${claudeCallbackPath}/${sessionId}`;
}

export function beginClaudeSignIn(input: {
  store: ClaudeSessionStore;
  publicBaseUrl: string;
  connectionId?: string;
}): ClaudeSessionStatus & { sessionId: string } {
  const { verifier, challenge } = generatePkcePair();
  const state = randomBytes(24).toString('base64url');
  const session = input.store.create({
    codeVerifier: verifier,
    redirectUri: '',
    state,
    verificationUrl: '',
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
  });
  const redirectUri = claudeRedirectUri(input.publicBaseUrl, session.id);
  session.redirectUri = redirectUri;
  session.verificationUrl = claudeAuthorizeUrl({ redirectUri, state, codeChallenge: challenge });
  return { sessionId: session.id, ...input.store.publicStatus(session) };
}

/** Constant-time comparison of two strings that must be identical. */
function sameVerifier(presented: string, expected: string): boolean {
  const left = Buffer.from(presented, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function completeClaudeSignIn(input: {
  store: ClaudeSessionStore;
  sessionId: string;
  /** The whole callback query (`code`, optionally `#state`) or a pasted code. */
  raw: string;
  /** When supplied by the exchange route, compared to the session's redirect exactly. */
  redirectUri?: string;
  /** When supplied by the exchange route, compared to the session's verifier in constant time. */
  codeVerifier?: string;
  saveConnection: (connection: { providerId: string; credential: ProviderCredential; label?: string }) => Promise<unknown>;
  transport?: Parameters<typeof exchangeClaudeCode>[0]['transport'];
  signal?: AbortSignal;
}): Promise<ClaudeSessionStatus | undefined> {
  const { store, sessionId, raw, saveConnection, transport, signal } = input;
  const session = store.get(sessionId);
  if (!session) return undefined;

  if (input.redirectUri !== undefined && input.redirectUri !== session.redirectUri) {
    store.resolve(sessionId, { status: 'failed', error: 'That redirect does not belong to this sign-in. Start again.' });
    return store.publicStatus(store.get(sessionId) ?? session);
  }
  if (input.codeVerifier !== undefined && !sameVerifier(input.codeVerifier, session.codeVerifier)) {
    store.resolve(sessionId, { status: 'failed', error: 'That PKCE verifier does not match this sign-in. Start again.' });
    return store.publicStatus(store.get(sessionId) ?? session);
  }

  let code: string;
  let state: string | undefined;
  try {
    ({ code, state } = splitCallbackFragment(raw, session.state));
  } catch (error) {
    store.resolve(sessionId, { status: 'failed', error: error instanceof Error ? error.message : 'That callback does not belong to this sign-in.' });
    return store.publicStatus(store.get(sessionId) ?? session);
  }
  if (!code) {
    store.resolve(sessionId, { status: 'failed', error: 'The callback carried no authorization code. Start again.' });
    return store.publicStatus(store.get(sessionId) ?? session);
  }

  const claimed = store.claim(sessionId);
  if (!claimed) return store.publicStatus(store.get(sessionId) ?? session);

  let credential: ProviderCredential;
  try {
    credential = await exchangeClaudeCode({
      code,
      state,
      codeVerifier: claimed.codeVerifier,
      redirectUri: claimed.redirectUri,
      ...(transport ? { transport } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    store.release(claimed);
    store.resolve(sessionId, { status: 'failed', error: error instanceof Error ? error.message : 'Claude did not complete the sign-in.' });
    return store.publicStatus(store.get(sessionId) ?? claimed);
  }

  let connection;
  try {
    connection = await saveConnection({
      providerId: 'claude',
      credential,
      label: `Claude (${CLAUDE.authorizeOrigin})`,
    });
  } catch (error) {
    store.resolve(sessionId, { status: 'failed', error: error instanceof Error ? error.message : 'The Claude connection could not be saved.' });
    return store.publicStatus(store.get(sessionId) ?? claimed);
  }
  store.resolve(sessionId, { status: 'connected', connection });
  return store.publicStatus(store.get(sessionId) ?? claimed);
}
