import { codebuddyCnProviderId, codebuddyIntlProviderId, CODEBUDDY_CN, CODEBUDDY_INTL, type CodeBuddyAdapterOptions, type CodeBuddyRegion } from '@omnihilbras/sdk-codebuddy';
import { createCodeBuddyAdapter } from '@omnihilbras/sdk-codebuddy';
import { SignInSessionStore, type SignInSessionBase } from '../core/sign-in-sessions.js';

/**
 * CodeBuddy sign-in.
 *
 * Despite the field names upstream uses, this is not a typed device code: the start call returns an
 * approval URL, the user approves in a browser, and the poll asks for the token. `userCode` is
 * therefore empty by design, and the dashboard opens `verificationUrl` instead of showing a code.
 *
 * Both regions share one lifecycle; only the adapter behind it differs, so the store keeps a region per
 * session and the service picks the adapter from it.
 */

const sessionIdPattern = /^[A-Za-z0-9_-]{16,128}$/;
const defaultTtlMs = 10 * 60_000;

export const CODEBUDDY_PROVIDER_IDS = [codebuddyCnProviderId, codebuddyIntlProviderId] as const;

export type CodeBuddySessionStatus = {
  status: 'pending' | 'connected' | 'failed' | 'expired';
  userCode?: string;
  verificationUrl?: string;
  expiresAt?: string;
  error?: string;
  connection?: unknown;
};

type Session = SignInSessionBase & {
  deviceCode: string;
  verificationUrl: string;
  region: CodeBuddyRegion;
  /** The connection this sign-in saves to, chosen when it starts (add-account vs repair). */
  connectionId?: string;
};

type CreateInput = { deviceCode: string; verificationUrl: string; region: CodeBuddyRegion; connectionId?: string };

export class CodeBuddySessionStore {
  private readonly store: SignInSessionStore<Session, CreateInput>;

  constructor(options: { ttlMs?: number } = {}) {
    this.store = new SignInSessionStore<Session, CreateInput>({
      ttlMs: options.ttlMs ?? defaultTtlMs,
      isPlausibleId: (id) => sessionIdPattern.test(id),
      build: (input, { id, expiresAt }) => ({
        id,
        deviceCode: input.deviceCode,
        verificationUrl: input.verificationUrl,
        region: input.region,
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
        expiresAt,
        status: 'pending',
        claimed: false,
      }),
      // There is no code to show; the URL is the whole instruction.
      read: (session) => ({ verificationUrl: session.verificationUrl }),
    });
  }

  create(input: { deviceCode: string; verificationUrl: string; region: CodeBuddyRegion; connectionId?: string; expiresIn?: number }): Session {
    return this.store.create({ deviceCode: input.deviceCode, verificationUrl: input.verificationUrl, region: input.region, ...(input.connectionId ? { connectionId: input.connectionId } : {}) }, input.expiresIn);
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

  publicStatus(session: Session): CodeBuddySessionStatus {
    return this.store.publicStatus(session);
  }

  get size(): number {
    return this.store.size;
  }
}

/** Region for either of the two CodeBuddy provider ids; anything else is answered with the CN region. */
export function codebuddyRegionFor(providerId: string): CodeBuddyRegion {
  return providerId === codebuddyIntlProviderId ? 'intl' : 'cn';
}

/** The endpoint a card should display for a region. */
export function codebuddyEndpointFor(providerId: string): string {
  return providerId === codebuddyIntlProviderId ? CODEBUDDY_INTL.server : CODEBUDDY_CN.server;
}

/** A fresh sign-in adapter for a region — it holds no per-connection state. */
export function codebuddySignInAdapter(region: CodeBuddyRegion, options: CodeBuddyAdapterOptions = {}) {
  return createCodeBuddyAdapter(region, options);
}

export { codebuddyCnProviderId, codebuddyIntlProviderId };
