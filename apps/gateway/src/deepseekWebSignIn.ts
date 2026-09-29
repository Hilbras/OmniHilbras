import { mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Signing in to chat.deepseek.com to get a `userToken`.
 *
 * **A browser is needed here and nowhere else.** The turn itself is plain HTTP with a bearer
 * token — no page to drive, no DOM to read — so this file exists purely to obtain the one
 * credential, and the profile it leaves behind is the durable copy.
 *
 * The token is in **localStorage, not a cookie**, which is why the sign-in reads it from the
 * page rather than from the cookie jar: `context.cookies()` would return nothing useful and
 * the connection would look signed out forever.
 *
 * The terms position is the same as for any web-session provider and the warning on the card
 * stands. Nothing here is a circumvention of an access control: the user signs in with their
 * own credentials and OmniHilbras reads the session their own browser created.
 */

export type DeepSeekSignInStatus =
  | { status: 'pending' }
  | { status: 'denied'; error: string }
  | { status: 'connected'; userToken: string };

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const PAGE_READ_TIMEOUT_MS = 20_000;
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7922.34 Safari/537.36';
const BROWSER_LOCALE = 'en-US';
const BROWSER_TIMEZONE = 'America/New_York';

export const DEEPSEEK_WEB_ORIGIN = 'https://chat.deepseek.com';
/** The localStorage key the web client keeps its session token under. */
export const DEEPSEEK_TOKEN_KEY = 'userToken';

export function deepSeekProfileDir(connectionKey = 'default'): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'omnihilbras', 'deepseek-web', createHash('sha256').update(connectionKey).digest('hex').slice(0, 32));
}

type SignInPage = {
  goto: (url: string, options: Record<string, unknown>) => Promise<unknown>;
  title: () => Promise<string>;
  waitForTimeout: (ms: number) => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<T>;
};

type SignInContext = {
  newPage: () => Promise<SignInPage>;
  close: () => Promise<void>;
};

async function loadPlaywright(): Promise<{ chromium: { launchPersistentContext: (dir: string, options: Record<string, unknown>) => Promise<SignInContext> } } | null> {
  try {
    return (await import('playwright-core')) as unknown as {
      chromium: { launchPersistentContext: (dir: string, options: Record<string, unknown>) => Promise<SignInContext> };
    };
  } catch {
    return null;
  }
}

/**
 * Reads the session token out of the page's own storage.
 *
 * Runs in the page, so it takes no arguments. `userToken` is sometimes stored as
 * `{"value":"…"}` and sometimes as the bare string, so both are read — same reason the SDK's
 * parser accepts both.
 */
function readTokenFromStorage(): { userToken: string | null; signedIn: boolean } {
  const raw = localStorage.getItem('userToken');
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { value?: unknown };
      if (typeof parsed.value === 'string' && parsed.value) return { userToken: parsed.value, signedIn: true };
    } catch {
      // Not the wrapper; the raw string is the token.
    }
    if (raw.trim()) return { userToken: raw.trim(), signedIn: true };
  }
  const text = document.body?.innerText ?? '';
  // A sign-in wall is the other unambiguous half, and the one thing on a signed-out page
  // that is not also on a signed-in one.
  const signedOut = document.querySelectorAll('a[href*="/signin"], a[href*="/login"]').length > 0;
  return { userToken: null, signedIn: !signedOut && /chat|deepseek|new chat/i.test(text) };
}

export type StartedDeepSeekSignIn = {
  read: () => Promise<DeepSeekSignInStatus>;
  close: () => Promise<void>;
  headed: boolean;
};

export async function startDeepSeekWebSignIn(
  options: { connectionKey?: string } = {},
): Promise<StartedDeepSeekSignIn | { error: string }> {
  const playwright = await loadPlaywright();
  if (!playwright) {
    return {
      error:
        'Signing in to DeepSeek Web needs a browser, and Playwright is not installed. Run `pnpm add -D playwright-core` in the gateway, then `npx playwright install chromium`. You can still connect by pasting a userToken instead.',
    };
  }

  const profile = deepSeekProfileDir(options.connectionKey);
  await mkdir(profile, { recursive: true });
  const display = process.env.CHATGPT_DISPLAY || process.env.DISPLAY;
  const headed = Boolean(display);

  const context = await playwright.chromium.launchPersistentContext(profile, {
    headless: !headed,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    // The same user agent the request path sends, so the session is not created under one
    // identity and then used from another.
    userAgent: BROWSER_USER_AGENT,
    locale: BROWSER_LOCALE,
    timezoneId: BROWSER_TIMEZONE,
    viewport: { width: 1200, height: 900 },
  });

  const close = async () => {
    await context.close().catch(() => undefined);
  };

  let page: SignInPage;
  try {
    page = await context.newPage();
    // Retried once, because a dropped connection reports itself as ERR_NETWORK_CHANGED and
    // is indistinguishable from chat.deepseek.com being unreachable.
    let navigated = false;
    for (let attempt = 1; attempt <= 2 && !navigated; attempt += 1) {
      try {
        await page.goto(`${DEEPSEEK_WEB_ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        navigated = true;
      } catch (error) {
        if (attempt === 2) throw error;
        await page.waitForTimeout(2_000).catch(() => undefined);
      }
    }
  } catch (error) {
    await close();
    return { error: `Could not open chat.deepseek.com: ${error instanceof Error ? error.message : String(error)}` };
  }

  const read = async (): Promise<DeepSeekSignInStatus> => {
    const state = await Promise.race([
      page.evaluate(readTokenFromStorage),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), PAGE_READ_TIMEOUT_MS)),
    ]).catch(() => ({ userToken: null, signedIn: false }) as { userToken: string | null; signedIn: boolean });

    if (state.userToken) return { status: 'connected', userToken: state.userToken };

    const title = await page.title().catch(() => '');
    if (/just a moment|captcha/i.test(title)) {
      return {
        status: 'denied',
        error:
          'chat.deepseek.com served a bot-protection challenge instead of the app. That is a block on the network OmniHilbras runs from, not a problem with your account — a residential connection with no VPN or datacenter is the usual fix.',
      };
    }
    return { status: 'pending' };
  };

  return { read, close, headed };
}

type Session = StartedDeepSeekSignIn & { id: string; expiresAt: number; claimed?: boolean };

export class DeepSeekSignInStore {
  private readonly sessions = new Map<string, Session>();
  private readonly ttlMs: number;

  constructor(options: { ttlMs?: number } = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  create(started: StartedDeepSeekSignIn): string {
    this.sweep();
    const id = randomUUID().replace(/-/g, '');
    this.sessions.set(id, { ...started, id, expiresAt: Date.now() + this.ttlMs });
    return id;
  }

  get(id: string): Session | undefined {
    if (!/^[a-f0-9]{32}$/.test(id)) return undefined;
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (Date.now() >= session.expiresAt) {
      void session.close();
      this.sessions.delete(id);
      return undefined;
    }
    return session;
  }

  /** Claimed before the page is read, so two polls cannot save two connections from one sign-in. */
  claim(id: string): Session | undefined {
    const session = this.get(id);
    if (!session || session.claimed) return undefined;
    session.claimed = true;
    return session;
  }

  async discard(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    await session.close().catch(() => undefined);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now < session.expiresAt) continue;
      this.sessions.delete(id);
      void session.close().catch(() => undefined);
    }
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.discard(id);
  }
}
