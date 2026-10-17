import { createHash, randomBytes } from 'node:crypto';
import { CODEX, codexAuthorizeUrl, codexProviderId, exchangeCodexCode, ProviderError } from '@hilbras/omnihilbras';
import type { ProviderCredential } from '@hilbras/omnihilbras';
import { SignInSessionStore } from './sign-in-sessions.js';

const sessionIdPattern = /^[A-Za-z0-9_-]{16,128}$/;
const ttlMs = 15 * 60_000;

type Session = {
  id: string;
  codeVerifier: string;
  state: string;
  /**
   * The client this sign-in was started with, kept beside the redirect it was registered against.
   *
   * A provider validates the two as a pair, so the exchange must use exactly what the authorize
   * request asked with. Reading the client from configuration at exchange time instead broke that
   * pairing: with no local configuration the authorize step fell back to the public client while the
   * exchange sent an empty string, and OpenAI refused it with `invalid 'client_id'`.
   */
  clientId: string;
  redirectUri: string;
  callbackPath: string;
  verificationUrl: string;
  expiresAt: number;
  status: 'pending' | 'connected' | 'failed' | 'expired';
  connection?: unknown;
  error?: string;
  claimed: boolean;
};

type Input = Pick<Session, 'codeVerifier' | 'state' | 'clientId' | 'redirectUri' | 'callbackPath' | 'verificationUrl'>;

export type CodexSignInStatus = {
  status: Session['status'];
  verificationUrl?: string;
  expiresAt?: string;
  error?: string;
  connection?: unknown;
};

export class CodexSessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly store = new SignInSessionStore<Session, Input>({
    ttlMs,
    isPlausibleId: (id) => sessionIdPattern.test(id),
    build: (input, { id, expiresAt }) => ({ id, ...input, expiresAt, status: 'pending', claimed: false }),
    read: (session) => ({ verificationUrl: session.verificationUrl }),
  });

  create(input: Input) {
    const session = this.store.create(input);
    for (const [id, entry] of this.sessions) if (entry.status !== 'pending' || entry.expiresAt <= Date.now()) this.sessions.delete(id);
    this.sessions.set(session.id, session);
    return session;
  }
  findCallback(path: string, state: string) { return [...this.sessions.values()].find((session) => session.callbackPath === path && session.status === 'pending' && session.state === state); }
  failCallback(path: string, state: string, error: string) {
    const session = this.findCallback(path, state);
    if (!session) return undefined;
    const claimed = this.claim(session.id);
    if (!claimed) return this.get(session.id);
    this.resolve(session.id, { status: 'failed', error });
    this.discard(claimed);
    return this.get(session.id);
  }
  get(id: string) { return this.store.get(id); }
  claim(id: string) { return this.store.claim(id); }
  resolve(id: string, patch: { status: Session['status']; connection?: unknown; error?: string }) { this.store.resolve(id, patch); }
  publicStatus(session: Session): CodexSignInStatus {
    const { verificationUrl } = this.store.publicStatus(session);
    return { status: session.status, ...(verificationUrl ? { verificationUrl } : {}), expiresAt: new Date(session.expiresAt).toISOString(), ...(session.error ? { error: session.error } : {}), ...(session.connection ? { connection: session.connection } : {}) };
  }
  discard(session: Session) {
    this.sessions.delete(session.id);
  }
}

export function validateCodexRedirect(input: { redirectUri: string; clientId: string; publicBaseUrl: string }) {
  const clientId = input.clientId.trim();
  if (!clientId) throw new Error('Set OMNIHILBRAS_CODEX_CLIENT_ID to the approved public Codex OAuth client ID before starting sign-in.');
  const redirectUri = input.redirectUri.trim();
  if (!redirectUri) throw new Error('Set OMNIHILBRAS_CODEX_REDIRECT_URI to the exact registered Codex OAuth callback URI before starting sign-in.');
  let target: URL;
  let base: URL;
  try { target = new URL(redirectUri); base = new URL(input.publicBaseUrl); } catch { throw new Error('OMNIHILBRAS_CODEX_REDIRECT_URI must be a valid absolute URL.'); }
  if (base.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error('The Codex callback listener must use HTTP on a loopback host.');
  if (target.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) {
    throw new Error('OMNIHILBRAS_CODEX_REDIRECT_URI must use HTTP on a loopback host served by this local gateway.');
  }
  if (target.origin !== base.origin) throw new Error(`OMNIHILBRAS_CODEX_REDIRECT_URI origin must match the gateway listener (${base.origin}); configure the registered URI to use that listener.`);
  if (target.username || target.password || target.hash || target.search) throw new Error('OMNIHILBRAS_CODEX_REDIRECT_URI must not contain credentials, a query, or a fragment.');
  if (!target.pathname.startsWith('/') || target.pathname === '/' || target.pathname.includes('\\')) throw new Error('OMNIHILBRAS_CODEX_REDIRECT_URI must include a safe callback path.');
  const callbackPath = target.pathname;
  const reserved = [
    '/health', '/v1/models', '/v1/responses', '/v1/chat/completions', '/v1/embeddings',
    '/v1/connections', '/v1/keys', '/v1/usage', '/v1/settings', '/v1/routing', '/v1/logs',
    '/v1/oauth/codex/start', '/v1/oauth/codex/session', '/v1/oauth/claude-code', '/v1/oauth/cline', '/v1/oauth/kiro',
    '/v1/oauth/kimi-code', '/v1/oauth/opencode-console', '/v1/web-cookie',
  ];
  if (reserved.some((path) => callbackPath === path || callbackPath.startsWith(`${path}/`))) throw new Error('OMNIHILBRAS_CODEX_REDIRECT_URI conflicts with an existing gateway route.');
  return { clientId, redirectUri, callbackPath };
}

/**
 * Which client and redirect a sign-in uses: the operator's override, or the public Codex CLI pair.
 *
 * A provider only redirects to a URI registered for the client that asked, so the two are chosen
 * together — overriding the client alone would ask OpenAI for a redirect URI it never agreed to,
 * and the browser would be sent somewhere that answers "route not found". An override is therefore
 * validated as a pair, and a partial override is refused rather than silently completed from the
 * other half of the default.
 *
 * A refusal here is a `ProviderError` with a public message naming the settings to change, because
 * a plain `Error` would reach the dashboard as "the gateway encountered an unexpected error" — which
 * tells an operator nothing about the two environment variables that decide whether this works.
 */
export function resolveCodexConfig(input: { clientId?: string; redirectUri?: string; publicBaseUrl: string }) {
  const clientId = input.clientId?.trim();
  const redirectUri = input.redirectUri?.trim();
  if (!clientId && !redirectUri) {
    return { clientId: CODEX.publicClientId, redirectUri: CODEX.publicRedirectUri, callbackPath: CODEX.publicRedirectPath, redirectPort: CODEX.publicRedirectPort, overridden: false };
  }
  if (!clientId || !redirectUri) {
    throw new ProviderError('CONFIGURATION_ERROR', 'Codex OAuth is half-configured.', {
      providerId: codexProviderId,
      publicMessage: 'Codex OAuth is half-configured. Set both OMNIHILBRAS_CODEX_CLIENT_ID and OMNIHILBRAS_CODEX_REDIRECT_URI, or set neither to use the public Codex client.',
    });
  }
  try {
    const validated = validateCodexRedirect({ clientId, redirectUri, publicBaseUrl: input.publicBaseUrl });
    return { ...validated, redirectPort: new URL(redirectUri).port ? Number(new URL(redirectUri).port) : 80, overridden: true };
  } catch (error) {
    throw new ProviderError('CONFIGURATION_ERROR', error instanceof Error ? error.message : 'Codex OAuth is misconfigured.', {
      providerId: codexProviderId,
      publicMessage: error instanceof Error ? error.message : 'Codex OAuth is misconfigured.',
      cause: error,
    });
  }
}

/**
 * Why a Codex sign-in did not complete, in words the person watching can act on.
 *
 * The exchange and the save fail for very different reasons — a refused code versus a catalog the
 * gateway could not read — and collapsing both into one sentence is what made this undiagnosable.
 * A `ProviderError`'s message is its own reason; anything else is reported as a fault of ours
 * rather than blamed on the provider.
 */
function codexFailureReason(error: unknown): string {
  if (error instanceof ProviderError) {
    return error.publicMessage ?? error.message ?? 'Codex did not complete the sign-in. Start again from OmniHilbras.';
  }
  return 'The gateway could not store the Codex connection. Start again from OmniHilbras.';
}

export function beginCodexSignIn(input: { store: CodexSessionStore; clientId: string; redirectUri: string; callbackPath: string }) {
  const codeVerifier = randomBytes(64).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const state = randomBytes(24).toString('base64url');
  const session = input.store.create({ codeVerifier, state, clientId: input.clientId, redirectUri: input.redirectUri, callbackPath: input.callbackPath, verificationUrl: '' });
  session.verificationUrl = codexAuthorizeUrl({ clientId: input.clientId, redirectUri: input.redirectUri, state, codeChallenge });
  return { sessionId: session.id, ...input.store.publicStatus(session) };
}

export async function completeCodexSignIn(input: { store: CodexSessionStore; sessionId: string; code: string; state: string; saveConnection: (credential: ProviderCredential) => Promise<unknown>; transport?: Parameters<typeof exchangeCodexCode>[0]['transport']; signal?: AbortSignal }) {
  const session = input.store.get(input.sessionId);
  if (!session) return undefined;
  if (!input.state || input.state !== session.state || !input.code) {
    return { status: 'failed', error: 'This callback did not match the pending Codex sign-in. Start again.' };
  }
  const claimed = input.store.claim(input.sessionId);
  if (!claimed) return input.store.publicStatus(input.store.get(input.sessionId) ?? session);
  try {
    const credential = await exchangeCodexCode({ code: input.code, codeVerifier: claimed.codeVerifier, clientId: claimed.clientId, redirectUri: claimed.redirectUri, ...(input.transport ? { transport: input.transport } : {}), ...(input.signal ? { signal: input.signal } : {}) });
    const connection = await input.saveConnection(credential);
    input.store.resolve(input.sessionId, { status: 'connected', connection });
  } catch (error) {
    // The provider's own refusal is the only thing that tells a reused code apart from a wrong
    // client, so it is reported rather than replaced by one sentence that fits every failure.
    input.store.resolve(input.sessionId, { status: 'failed', error: codexFailureReason(error) });
  } finally {
    input.store.discard(claimed);
  }
  return input.store.publicStatus(input.store.get(input.sessionId) ?? claimed);
}

export { codexProviderId };
