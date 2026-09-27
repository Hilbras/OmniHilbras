import { mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Signing in to chatgpt.com, in a browser the user can see.
 *
 * Everything else about this provider follows from one awkward fact: the credential is a
 * whole-account browser session, and the only way to get one is to sign in. Asking for it by
 * hand meant asking the user to pick a cookie out of DevTools, cope with a `Cookie:` prefix
 * they had been told to omit, and reassemble a token the browser had split into numbered
 * chunks. Every one of those is a way to fail at something OmniHilbras could simply do.
 *
 * So it does them instead: a window opens on the user's desktop, they sign in with their own
 * password and their own second factor, and the session is read straight out of the browser
 * that produced it.
 *
 * **This is the same automation, with the same whole-account credential, and the same terms
 * problem.** Signing in as yourself does not make automating chatgpt.com any more permitted
 * than pasting its cookie was. The warning in the connect dialog stands unchanged; what
 * changes is that you are no longer asked to do the fragile part by hand.
 *
 * **The window is on the machine running the gateway**, not inside the dashboard. A dashboard
 * on a different machine cannot put a browser on your desktop, and pretending otherwise would
 * mean showing a sign-in page that could never complete.
 */

export type SignInStatus =
  | { status: 'pending' }
  | { status: 'denied'; error: string }
  | { status: 'connected'; storageState: string; plan: string | null };

/** How long a sign-in window is held open before it is closed and the attempt abandoned. */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** How long one page read is given before it is treated as not-yet-signed-in. */
const PAGE_READ_TIMEOUT_MS = 20_000;

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7922.34 Safari/537.36';
const BROWSER_LOCALE = 'en-US';
const BROWSER_TIMEZONE = 'America/New_York';

/**
 * Where the ChatGPT Web browser profile lives.
 *
 * A persistent profile is not an optimisation, it is a requirement. ChatGPT shows a first-use
 * "Temporary Chat" modal, and with a throwaway profile it is shown on *every* request — holding
 * focus, intercepting the click on Send, and turning a working flow into a timeout.
 *
 * It is also where the session already lives: this profile is what makes the sign-in flow
 * possible, and what a turn reuses afterwards.
 */
export function chatGptWebProfileDir(connectionKey = 'default'): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'omnihilbras', 'chatgpt-web', createHash('sha256').update(connectionKey).digest('hex').slice(0, 32));
}

type Cookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
};

type SignInPage = {
  goto: (url: string, options: Record<string, unknown>) => Promise<unknown>;
  title: () => Promise<string>;
  waitForTimeout: (ms: number) => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<T>;
};

type SignInContext = {
  newPage: () => Promise<SignInPage>;
  cookies: (urls: string[]) => Promise<Cookie[]>;
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
 * Whether an account is signed in, read off the page text.
 *
 * Measured against a real session and a deliberately invalid one, **every DOM marker is
 * identical** — both render two textareas, no profile button, no sign-in link, the same form,
 * the same URL. A selector picked from either page passes the other, which is exactly how a
 * check came to accept a token that was not valid. The page *text* is the one thing that
 * differs, so that is what is read.
 *
 * Runs in the page, so it takes no arguments and closes over nothing.
 */
function readPageState(): { plan: string | null; signedIn: boolean } {
  const text = document.body?.innerText ?? '';
  // "Free" is checked first: it is the plan most accounts are on, and the paid names are
  // ordinary English words that turn up in page copy.
  if (/\bFree\b/.test(text)) return { plan: 'Free', signedIn: true };
  const paid = /\b(Plus|Pro|Team|Business|Enterprise|Go)\b/.exec(text)?.[1];
  if (paid) return { plan: paid, signedIn: true };
  return { plan: null, signedIn: false };
}

export type StartedSignIn = {
  /** Reads the page and reports whether an account is signed in yet. */
  read: () => Promise<SignInStatus>;
  close: () => Promise<void>;
  /** Whether the window is actually visible, so the dialog can tell the truth about it. */
  headed: boolean;
};

/**
 * Opens chatgpt.com in a window and waits for an account to appear.
 *
 * Headed when there is a display to draw on, which is what lets the user type their password.
 * With no display the flow still completes — the profile is the same one the turns use — but
 * there is nowhere to type into, so the caller is told and offered the paste path instead.
 */
export async function startChatGptWebSignIn(
  options: { connectionKey?: string } = {},
): Promise<StartedSignIn | { error: string }> {
  const playwright = await loadPlaywright();
  if (!playwright) {
    return {
      error:
        'Signing in to ChatGPT Web needs a browser, and Playwright is not installed. Run `pnpm add -D playwright-core` in the gateway, then `npx playwright install chromium`. You can still connect by pasting a Cookie header instead.',
    };
  }

  const profile = chatGptWebProfileDir(options.connectionKey);
  await mkdir(profile, { recursive: true });

  // Headed only when there is a display. `CHATGPT_DISPLAY` lets a gateway name which one.
  const display = process.env.CHATGPT_DISPLAY || process.env.DISPLAY;
  const headed = Boolean(display);

  const context = await playwright.chromium.launchPersistentContext(profile, {
    headless: !headed,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    // The same user agent the turns use, because the edge answers 403 before the page exists
    // otherwise — and a session signed in under one user agent would look odd under another.
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
    /**
     * Navigation is retried once, for the same reason the turn path retries it.
     *
     * A dropped connection here reports itself as `ERR_NETWORK_CHANGED`, which is
     * indistinguishable from chatgpt.com being unreachable — and it happens on this network
     * often enough to be worth the two seconds. Failing here would close a window the user
     * was about to type their password into, for a blip.
     */
    let navigated = false;
    for (let attempt = 1; attempt <= 2 && !navigated; attempt += 1) {
      try {
        await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
        navigated = true;
      } catch (error) {
        if (attempt === 2) throw error;
        await page.waitForTimeout(2_000).catch(() => undefined);
      }
    }
  } catch (error) {
    await close();
    return { error: `Could not open chatgpt.com: ${error instanceof Error ? error.message : String(error)}` };
  }

  const read = async (): Promise<SignInStatus> => {
    const state = await Promise.race([
      page.evaluate(readPageState),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), PAGE_READ_TIMEOUT_MS)),
    ]).catch(() => ({ plan: null, signedIn: false }) as { plan: string | null; signedIn: boolean });

    if (!state.signedIn) {
      // A challenge rather than a sign-in wall. Named, because the fix is the network and
      // re-exporting a session would not touch it.
      const title = await page.title().catch(() => '');
      if (/just a moment/i.test(title)) {
        return {
          status: 'denied',
          error:
            'chatgpt.com served its bot-protection challenge instead of the sign-in page. That is a block on the network OmniHilbras runs from, not a problem with your account — a residential connection with no VPN or datacenter is the usual fix.',
        };
      }
      return { status: 'pending' };
    }

    /**
     * Read out of the browser that signed in.
     *
     * Not reconstructed from a header: these are the cookies this profile will keep using, so
     * the session the turn replays is the same session the user just created — including the
     * Cloudflare clearance the edge set, which is the piece most likely to go stale if it is
     * copied somewhere else.
     */
    const cookies = await context.cookies(['https://chatgpt.com', 'https://auth.openai.com']).catch(() => []);
    if (cookies.length === 0) return { status: 'pending' };
    return {
      status: 'connected',
      plan: state.plan,
      storageState: JSON.stringify({ cookies, origins: [] }),
    };
  };

  return { read, close, headed };
}

/**
 * Sign-in attempts in progress, each holding a browser window open.
 *
 * In memory and on purpose: the window is a process, and a gateway restart should abandon
 * attempts rather than resume them against a browser that no longer exists.
 */
type Session = StartedSignIn & { id: string; expiresAt: number };

export class ChatGptWebSignInStore {
  private readonly sessions = new Map<string, Session>();
  private readonly ttlMs: number;

  constructor(options: { ttlMs?: number } = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  create(started: StartedSignIn): string {
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

  /**
   * Claims a session for a caller.
   *
   * Claimed *before* the read, so two concurrent polls cannot both read a signed-in page and
   * race to save two connections from one sign-in.
   */
  claim(id: string): Session | undefined {
    const session = this.get(id);
    if (!session || (session as Session & { claimed?: boolean }).claimed) return undefined;
    (session as Session & { claimed?: boolean }).claimed = true;
    return session;
  }

  /** Closes and forgets a session, whether it succeeded, failed, or was abandoned. */
  async discard(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    await session.close().catch(() => undefined);
  }

  /** Closes windows nobody came back for. A leaked window is a signed-in session left open. */
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
