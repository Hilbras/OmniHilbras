import { createMinimaxCodeAdapter, MINIMAX_CODE_SITES, minimaxCodeGlobalProviderId, minimaxCodeProviderId, type MinimaxCodeAdapterOptions } from '@omnihilbras/sdk-minimax-code';
import { SignInSessionStore, type SignInSessionBase } from '../core/sign-in-sessions.js';

/**
 * MiniMax Code sign-in — RFC 8628 device code with PKCE.
 *
 * Two regional cards (`minimax-code` for China, `minimax-code-global` for the international site)
 * share this flow; the site decides the host. MiniMax sometimes omits `device_code`, in which case
 * the poll uses the `user_code` instead, so both are kept on the session.
 */

const sessionIdPattern = /^[A-Za-z0-9_-]{16,128}$/;
const defaultTtlMs = 10 * 60_000;

export type MinimaxCodeSessionStatus = {
  status: 'pending' | 'connected' | 'failed' | 'expired';
  userCode?: string;
  verificationUrl?: string;
  expiresAt?: string;
  error?: string;
  connection?: unknown;
};

type Session = {
  id: string;
  deviceCode: string;
  userCode: string;
  codeVerifier: string;
  /** Poll with the `user_code` instead of `device_code` — only for the variant that issued no device code. */
  pollByUserCode: boolean;
  verificationUrl: string;
  expiresAt: number;
  status: MinimaxCodeSessionStatus['status'];
  connection?: unknown;
  error?: string;
  claimed: boolean;
  /** The connection this sign-in saves to, chosen when it starts (add-account vs repair). */
  connectionId?: string;
};

type CreateInput = { deviceCode: string; userCode: string; codeVerifier: string; verificationUrl: string; pollByUserCode?: boolean; connectionId?: string;
};

export class MinimaxCodeSessionStore {
  private readonly store: SignInSessionStore<Session, CreateInput>;

  constructor(options: { ttlMs?: number } = {}) {
    this.store = new SignInSessionStore<Session, CreateInput>({
      ttlMs: options.ttlMs ?? defaultTtlMs,
      isPlausibleId: (id) => sessionIdPattern.test(id),
      build: (input, { id, expiresAt }) => ({
        id,
        deviceCode: input.deviceCode,
        userCode: input.userCode,
        codeVerifier: input.codeVerifier,
        pollByUserCode: Boolean(input.pollByUserCode),
        verificationUrl: input.verificationUrl,
        expiresAt,
        status: 'pending',
        claimed: false,
      }),
      read: (session) => ({ userCode: session.userCode, verificationUrl: session.verificationUrl }),
    });
  }

  create(input: CreateInput & { connectionId?: string; expiresIn?: number }): Session {
    return this.store.create(
      { deviceCode: input.deviceCode, userCode: input.userCode, codeVerifier: input.codeVerifier, verificationUrl: input.verificationUrl, pollByUserCode: input.pollByUserCode, ...(input.connectionId ? { connectionId: input.connectionId } : {}) },
      input.expiresIn,
    );
  }

  get(id: string): Session | undefined {
    return this.store.get(id);
  }

  /** The connection this sign-in saves to, when it carries one. */
  connectionId(id: string): string | undefined {
    return this.get(id)?.connectionId;
  }

  claim(id: string): Session | undefined {
    return this.store.claim(id);
  }

  release(session: Session) {
    this.store.release(session);
  }

  resolve(id: string, patch: { status: SignInSessionBase['status']; connection?: unknown; error?: string }) {
    this.store.resolve(id, patch);
  }

  publicStatus(session: Session): MinimaxCodeSessionStatus {
    return this.store.publicStatus(session);
  }
}

const adapterCache = new Map<string, ReturnType<typeof createMinimaxCodeAdapter>>();

/** A memoised adapter per provider id, so sign-in and inference share one transport. */
export function minimaxCodeSignInAdapter(providerId: string, transport?: MinimaxCodeAdapterOptions['transport']) {
  const memo = adapterCache.get(providerId);
  if (memo) return memo;
  const siteName = providerId === minimaxCodeGlobalProviderId ? 'global' : 'cn';
  const adapter = createMinimaxCodeAdapter(siteName, transport ? { transport } : {});
  adapterCache.set(providerId, adapter);
  return adapter;
}

export function minimaxCodeSiteEndpoint(providerId: string): string {
  return providerId === minimaxCodeGlobalProviderId ? MINIMAX_CODE_SITES.global.agent : MINIMAX_CODE_SITES.cn.agent;
}

export { minimaxCodeProviderId, minimaxCodeGlobalProviderId, MINIMAX_CODE_SITES };
