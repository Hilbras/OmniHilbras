import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CHATGPT_WEB, chatGptWebDirectModel, chatGptWebProviderId as CHATGPT_WEB_PROVIDER_ID, ProviderError, type ChatGptCookie, type ChatGptWebDriver } from '@hilbras/omnihilbras';
import { executeFirstPartyTurn, extractAssistantText, type PageLike } from './chatgptFirstParty.js';

/**
 * The browser half of ChatGPT Web.
 *
 * This is the part that cannot be reasoned about in the abstract: it loads chatgpt.com in
 * a real browser so ChatGPT's own page runs its anti-automation challenges, types the
 * prompt, and reads the answer back. The SDK owns the parsing and this module owns the
 * browser, which is what keeps the published package free of a browser dependency.
 *
 * Playwright is loaded lazily. It is a large optional piece of software, and a gateway
 * that never opens a ChatGPT Web connection should not pay for it or fail to start
 * without it. Every failure here names what is missing rather than reporting a provider
 * error, because "ChatGPT Web is not set up" and "ChatGPT Web rejected the session" are
 * different problems with different fixes.
 */

type PlaywrightModule = {
  chromium: {
    launch: (options: Record<string, unknown>) => Promise<PlaywrightBrowser>;
    launchPersistentContext: (dir: string, options: Record<string, unknown>) => Promise<PlaywrightContext>;
  };
};

type PlaywrightBrowser = {
  newContext: (options: Record<string, unknown>) => Promise<PlaywrightContext>;
  close: () => Promise<void>;
};

type PlaywrightContext = {
  addCookies: (cookies: unknown[]) => Promise<void>;
  newPage: () => Promise<PlaywrightPage>;
  close: () => Promise<void>;
};

type PlaywrightPage = {
  goto: (url: string, options: Record<string, unknown>) => Promise<unknown>;
  waitForSelector: (selector: string, options: Record<string, unknown>) => Promise<unknown>;
  title: () => Promise<string>;
  waitForTimeout: (ms: number) => Promise<void>;
  evaluate: <T>(fn: (arg: never) => T, arg?: unknown) => Promise<T>;
  fill: (selector: string, value: string) => Promise<void>;
  click: (selector: string, options?: Record<string, unknown>) => Promise<void>;
  locator: (selector: string) => PlaywrightLocator;
  waitForFunction: (
    pageFunction: (arg: never) => unknown,
    arg?: unknown,
    options?: Record<string, unknown>,
  ) => Promise<void>;
  close: () => Promise<void>;
};

type PlaywrightLocator = {
  count: () => Promise<number>;
  allTextContents: () => Promise<string[]>;
  textContent: () => Promise<string | null>;
  last: () => PlaywrightLocator;
  click: (options?: { force?: boolean; timeout?: number }) => Promise<void>;
  pressSequentially: (text: string, options?: { delay?: number }) => Promise<void>;
};

/**
 * The user agent the browser presents.
 *
 * Playwright's default for a headless browser is the real Chrome string with
 * `HeadlessChrome/151.0.7922.34` substituted for `Chrome/…`, and that one substring is
 * enough for chatgpt.com's edge to answer **403 with a bot-protection interstitial**
 * before any application code runs. It is the whole reason this looked like a network
 * block: the address was fine, the request was simply announcing itself.
 *
 * Measured on the same machine, same session, same engine, one variable at a time:
 *
 *   default UA            -> 403, title "Just a moment...", empty body
 *   this UA               -> 200, composer present
 *   this UA, headed       -> 200, composer present   (the engine makes no difference)
 *
 * The version is the one Chromium actually reports, so the string stays internally
 * consistent rather than claiming a release that does not exist.
 */
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7922.34 Safari/537.36';

/** A locale and a timezone that match the agent string, since a mismatch is its own tell. */
const BROWSER_LOCALE = 'en-US';
const BROWSER_TIMEZONE = 'America/New_York';

let playwrightPromise: Promise<PlaywrightModule | undefined> | undefined;

async function loadPlaywright(): Promise<PlaywrightModule | undefined> {
  playwrightPromise ??= (async () => {
    try {
      return (await import('playwright-core')) as unknown as PlaywrightModule;
    } catch {
      return undefined;
    }
  })();
  return playwrightPromise;
}

/**
 * Chrome's ceiling for a single cookie is 4096 bytes, and a ChatGPT session token is a
 * compact JWE that runs to about 5 KB — so `addCookies` refuses the whole batch with
 * `Invalid cookie fields`, naming no field and giving no hint that the *value* is at
 * fault. Every other field is valid; only the length is not.
 *
 * NextAuth already solves this for the browser: an oversized session cookie is split into
 * numbered chunks (`…session-token.0`, `…session-token.1`) which the page rejoins. Writing
 * them the same way is what makes an exported session loadable into a browser at all.
 */
/** Chrome's ceiling for one cookie. A margin under it means an over-limit cookie cannot be produced. */
const chunkSize = 3800;

/**
 * Splits one cookie into the numbered chunks a browser will accept.
 *
 * A cookie that already fits is passed through unchanged, so the chunked form is only ever
 * used where it is actually needed.
 */
export function chunkCookie(cookie: ChatGptCookie): ChatGptCookie[] {
  if (cookie.value.length <= chunkSize) return [cookie];
  const chunks: ChatGptCookie[] = [];
  for (let index = 0, at = 0; at < cookie.value.length; index += 1, at += chunkSize) {
    chunks.push({
      ...cookie,
      name: `${cookie.name}.${index}`,
      value: cookie.value.slice(at, at + chunkSize),
      // The chunk carries no expiry of its own: the original's expiry applies to the whole
      // session, and a per-chunk one would expire the tail early.
      ...(cookie.expires === undefined ? {} : { expires: cookie.expires }),
    });
  }
  return chunks;
}

/** Turns a Playwright cookie into the shape its own `addCookies` expects. */
function toPlaywrightCookie(cookie: ChatGptCookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    // `domain` must be set, and the leading dot is meaningful: it makes the cookie
    // sub-domain-wide, which is how chatgpt.com issued it.
    domain: cookie.domain ?? '.chatgpt.com',
    path: cookie.path ?? '/',
    httpOnly: cookie.httpOnly ?? true,
    secure: cookie.secure ?? true,
    sameSite: 'Lax' as const,
    /**
     * `expires` is a Unix timestamp in seconds, and **omitted** for a session cookie.
     *
     * The CLI export carries no expiry for the session token, so the parser records `-1` —
     * which is Chrome's internal marker for "no expiry" and *not* a value Playwright
     * accepts. Passing it through fails the whole `addCookies` call with
     * `Invalid cookie fields`, which is a protocol error with no hint about the field.
     */
    ...(cookie.expires === undefined || cookie.expires === -1 || cookie.expires <= 0 ? {} : { expires: cookie.expires }),
  };
}

/**
 * Opens chatgpt.com with a session in it and hands back the signed-in page.
 *
 * Both the turn and the check need exactly this — the cookies set, the profile reused, the
 * navigation retried, and the two failure modes told apart from each other — so it is one
 * function rather than two copies that drift.
 */
async function openSignedInPage(cookies: readonly ChatGptCookie[], profile: string): Promise<{ page: PageLike; close: () => Promise<void> }> {
  const playwright = await loadPlaywright();
  if (!playwright) {
    const message =
      'ChatGPT Web needs a browser, and Playwright is not installed. Run `pnpm add -D playwright-core` in the gateway, then `npx playwright install chromium`.';
    throw new ProviderError('PROVIDER_UNAVAILABLE', message, {
      providerId: CHATGPT_WEB_PROVIDER_ID,
      publicMessage: message,
    });
  }
  // The container this often runs in has no shared memory and no sandbox namespaces. Both
  // are required by a default Chromium and neither is fixable by the user here.
  const launchOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    // Without these the edge answers 403 before the page exists.
    userAgent: BROWSER_USER_AGENT,
    locale: BROWSER_LOCALE,
    timezoneId: BROWSER_TIMEZONE,
    viewport: { width: 1400, height: 950 },
  };
  await mkdir(profile, { recursive: true });
  const context = await playwright.chromium.launchPersistentContext(profile, launchOptions);
  const close = async () => {
    await context.close().catch(() => undefined);
  };
  let page: PageLike | undefined;
  try {
    // Chunked before they are set, because an oversized cookie fails the whole batch.
    await context.addCookies(cookies.flatMap((cookie) => chunkCookie(cookie)).map(toPlaywrightCookie));
    page = (await context.newPage()) as unknown as PageLike;
    /**
     * Navigation is retried, because a dropped connection reports itself as
     * `ERR_NETWORK_CHANGED` — indistinguishable, to the caller, from chatgpt.com being
     * unreachable. One retry is the difference between a transient blip and a failed turn.
     */
    let navigated = false;
    for (let attempt = 1; attempt <= 2 && !navigated; attempt += 1) {
      try {
        await page.goto(CHATGPT_WEB.startUrl, { waitUntil: 'domcontentloaded', timeout: CHATGPT_WEB.navigationTimeoutMs });
        navigated = true;
      } catch (error) {
        if (attempt === 2) throw error;
        await page.waitForTimeout(2_000).catch(() => undefined);
      }
    }
    await page.waitForTimeout(6_000);

    // A challenge is identified by its title, because its body is empty. Told apart from a
    // sign-in wall because the two have completely different fixes: one is the network, the
    // other is the credential.
    /**
     * Both of these are ProviderErrors, and the codes differ because the fixes differ.
     *
     * A challenge is the network and is `PROVIDER_UNAVAILABLE`; a sign-in wall is the
     * credential and is `AUTHENTICATION_FAILED`. Thrown as bare Errors they both arrive as
     * `INTERNAL_ERROR` and "unexpected error", which is worse than either — it hides the
     * one thing the user needs to know, which of the two they are looking at.
     */
    const title = await page.title().catch(() => '');
    if (/just a moment/i.test(title)) throw blockedError();
    if ((await page.locator(CHATGPT_WEB.signedOutMarker).count()) > 0) {
      throw signedOutError();
    }
    return { page, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** A bot-protection challenge: the network, not the credential. */
function blockedError(): ProviderError {
  const message = describeBlocked();
  return new ProviderError('PROVIDER_UNAVAILABLE', message, { providerId: CHATGPT_WEB_PROVIDER_ID, publicMessage: message });
}

/** A sign-in wall: the credential, not the network. */
function signedOutError(): ProviderError {
  const message = describeSignedOut();
  return new ProviderError('AUTHENTICATION_FAILED', message, { providerId: CHATGPT_WEB_PROVIDER_ID, publicMessage: message });
}

function describeBlocked(): string {
  return 'chatgpt.com served its bot-protection challenge instead of the application, so no turn was attempted. This is a network-level block on the address OmniHilbras is running from — it happens with a valid session, so it is not a problem with your export. A residential connection with no VPN or datacenter is the usual fix.';
}

function describeSignedOut(): string {
  return 'The ChatGPT page is showing a sign-in wall, which means the exported session is no longer valid. Export storage state again while signed in to chatgpt.com.';
}

/**
 * Where a ChatGPT Web browser profile lives.
 *
 * A persistent profile is not an optimisation, it is a requirement. ChatGPT shows a
 * first-use "Temporary Chat" modal, and with a throwaway profile it is shown on *every*
 * request — holding focus, intercepting the click on Send, and turning a working flow into
 * a timeout. A real browser remembers that it has been dismissed, and so does this one.
 * It is also the difference between a 20-second page load and an instant one per turn.
 */
function profileDir(connectionKey: string): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'omnihilbras', 'chatgpt-web', createHash('sha256').update(connectionKey).digest('hex').slice(0, 32));
}

export function createChatGptWebDriver(connectionKey = 'default'): ChatGptWebDriver {
  const dir = profileDir(connectionKey);
  return {
    async available() {
      const playwright = await loadPlaywright();
      if (!playwright) {
        return {
          ok: false,
          reason:
            'ChatGPT Web needs a browser, and Playwright is not installed. Run `pnpm add -D playwright-core` in the gateway, then `npx playwright install chromium`.',
        };
      }
      return { ok: true };
    },

    /**
     * Confirms the session is actually signed in, by opening the page.
     *
     * This is the whole point of the connect dialog's "Check cookie" button, and it is why
     * the button costs a page load. Expiry and cookie presence are checked without a browser
     * and are not enough: a session revoked from another device, or one the edge has since
     * challenged, parses perfectly and fails every request. Only the page knows.
     *
     * The plan is read from the page rather than the export for the same reason — the export
     * is a claim about an account, the page is the account.
     */
    /**
     * Confirms the session is signed in, by opening the page and looking for the account.
     *
     * This is what the connect dialog's "Check cookie" button means, and it is why the
     * button costs a page load. Expiry, cookie presence and browser availability are all
     * local checks; none of them can tell a working session from a revoked one, and
     * reporting "valid" for both is how "connected but every request fails" begins.
     *
     * **The signal is the plan badge, and nothing else.** Measured against a real session
     * and a deliberately invalid one, every DOM marker is identical: both render two
     * textareas, no profile button, no sign-in link, the same form, the same URL. A selector
     * picked from either page passes the other. The only thing that differs is the page
     * text, which carries the plan on a signed-in account and not on a signed-out one — so
     * that is what is read, and a page without it is reported as unconfirmed rather than
     * guessed at.
     */
    async verify({ cookies }) {
      const { page, close } = await openSignedInPage(cookies, dir);
      try {
        // Polled, because the badge arrives with the account data and is not in the first
        // paint. A single read races it, and a race that usually wins is still a race.
        const readPlan = () =>
          page
            .evaluate(() => {
              const body = document.body?.innerText ?? '';
              // "Free" is checked first because it is the plan most accounts are on, and the
              // paid names are ordinary English words that can appear in page copy.
              if (/\bFree\b/.test(body)) return 'Free';
              return /\b(Plus|Pro|Team|Business|Enterprise|Go)\b/.exec(body)?.[1] ?? null;
            })
            .catch(() => null);

        let plan = await readPlan();
        for (let waited = 0; plan === null && waited < 15_000; waited += 1_500) {
          await page.waitForTimeout(1_500).catch(() => undefined);
          plan = await readPlan();
        }

        if (plan === null) {
          /**
           * A ProviderError, not a bare Error: a bare one reaches the user as
           * `INTERNAL_ERROR` and "an unexpected error", which is the one thing a check must
           * never say — it hides whether the problem is the export.
           */
          const message =
            'chatgpt.com loaded but showed no account, so this session could not be confirmed. It may have been revoked or signed out. Sign in to chatgpt.com, export the Cookie header again, and check it once more.';
          throw new ProviderError('AUTHENTICATION_FAILED', message, {
            providerId: CHATGPT_WEB_PROVIDER_ID,
            publicMessage: message,
          });
        }
        return { ok: true, plan };
      } finally {
        await close();
      }
    },

    async ask({ cookies, selection, messages }) {
      const prompt = messages[messages.length - 1]?.text ?? '';
      if (!prompt.trim()) throw new ProviderError('INVALID_REQUEST', 'There is nothing to ask ChatGPT Web.', { providerId: CHATGPT_WEB_PROVIDER_ID, publicMessage: 'There is nothing to ask ChatGPT Web.' });
      const { page, close } = await openSignedInPage(cookies, dir);
      try {
        /**
         * The turn, through ChatGPT's own code.
         *
         * Typing into the composer posts a request the page never completes: a placeholder
         * appears and the page sits at "Think" indefinitely. What works is the path the page
         * uses for itself — its Sentinel requirements, its proof-of-work and Turnstile
         * tokens, and its request client.
         */
        // The SDK owns this rule, because it is not the obvious one: Pro must not ask for
        // thinking. Deriving `reason` here as `effortIndex > 0` would send a hint the page
        // does not honour on a Pro request.
        const direct = chatGptWebDirectModel(selection);

        /**
         * One retry for a dropped connection, and only for that.
         *
         * The turn runs inside the page, and a fetch ChatGPT's own code makes can fail on
         * the network — `Failed to fetch` from its Sentinel or Turnstile solve. That is
         * indistinguishable, to the caller, from a real refusal, and it is not one: it
         * succeeds on a second attempt. Anything else is a real failure and is raised as
         * one, so a broken session is not retried into looking intermittent.
         */
        let text = '';
        let lastError: Error | null = null;
        for (let attempt = 1; attempt <= 2 && !text; attempt += 1) {
          try {
            const sse = await executeFirstPartyTurn(page, { prompt, model: direct.model, reason: direct.reason });
            text = extractAssistantText(sse);
            if (!text) {
              // Not retried: a stream with no text is a format change, not a dropped
              // connection, and retrying it would hide a real break behind a slow failure.
              const message =
                'ChatGPT answered, but the stream carried no text. Its response format may have changed.';
              throw new ProviderError('PROVIDER_REQUEST_FAILED', message, {
                providerId: CHATGPT_WEB_PROVIDER_ID,
                publicMessage: message,
              });
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const transient = /Failed to fetch|ERR_NETWORK_CHANGED|NetworkError|load failed/i.test(message);
            lastError = error instanceof Error ? error : new Error(message);
            if (!transient || attempt === 2) throw lastError;
            await page.waitForTimeout(3_000).catch(() => undefined);
          }
        }
        return { text };
      } finally {
        // The profile persists, so the context is what gets closed.
        await close();
      }
    },
  };
}
