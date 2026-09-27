import { CHATGPT_WEB, type ChatGptCookie, type ChatGptWebDriver } from '@hilbras/omnihilbras';

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
  fill: (selector: string, value: string) => Promise<void>;
  click: (selector: string, options?: Record<string, unknown>) => Promise<void>;
  locator: (selector: string) => PlaywrightLocator;
  waitForFunction: (pageFunction: string, arg?: unknown, options?: Record<string, unknown>) => Promise<void>;
  close: () => Promise<void>;
};

type PlaywrightLocator = {
  count: () => Promise<number>;
  allTextContents: () => Promise<string[]>;
  textContent: () => Promise<string | null>;
};

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
  };
}

/**
 * The signed-out check.
 *
 * A browser with stale cookies still renders a page, and it renders it perfectly well. The
 * only honest difference is that the composer is absent and the sign-in link is present, so
 * that is what is looked for — and it is checked *before* the turn, because a signed-out
 * page otherwise looks like a model that returned nothing.
 */
async function readPageState(page: PlaywrightPage) {
  const loginLink = page.locator(CHATGPT_WEB.signedOutMarker);
  const composer = page.locator(CHATGPT_WEB.composer);
  const [loginLinkCount, composerCount] = await Promise.all([loginLink.count(), composer.count()]);
  // A blocked request renders a real page — just not the application. It is caught by its
  // own wording, because "no composer" would otherwise be reported as a signed-out session
  // and send the user off to re-export a perfectly good one.
  const bodyText = await page.locator('body').textContent().catch(() => '');
  const blocked = /unable to load site|attention required|access denied|checking your browser/i.test(bodyText ?? '');
  return { loginLinkCount, composerCount, blocked };
}

function describeBlocked(): string {
  return 'chatgpt.com returned its anti-bot block page instead of the application, so no turn was attempted. This is a network-level block on the address OmniHilbras is running from, not a problem with your session — a residential connection without a VPN is the usual fix.';
}

function describeSignedOut(): string {
  return 'The ChatGPT page is showing a sign-in wall, which means the exported session is no longer valid. Export storage state again while signed in to chatgpt.com.';
}

export function createChatGptWebDriver(): ChatGptWebDriver {
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

    async ask({ cookies, messages, timeoutMs }) {
      const playwright = await loadPlaywright();
      if (!playwright) {
        throw new Error(
          'ChatGPT Web needs a browser, and Playwright is not installed. Run `pnpm add -D playwright-core` in the gateway, then `npx playwright install chromium`.',
        );
      }
      const prompt = messages[messages.length - 1]?.text ?? '';
      if (!prompt.trim()) throw new Error('There is nothing to ask ChatGPT Web.');

      const browser = await playwright.chromium.launch({
        headless: true,
        // The container this often runs in has no shared memory and no sandbox namespaces.
        // Both are required by a default Chromium and neither is fixable by the user here.
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      });
      let context: PlaywrightContext | undefined;
      try {
        context = await browser.newContext({ userAgent: undefined, viewport: { width: 1280, height: 900 } });
        await context.addCookies(cookies.map(toPlaywrightCookie));
        const page = await context.newPage();

        await page.goto(CHATGPT_WEB.startUrl, { waitUntil: 'domcontentloaded', timeout: CHATGPT_WEB.navigationTimeoutMs });

        // Checked before typing, so a stale export is named as a stale export — and a
        // blocked edge is named as a blocked edge rather than mistaken for one.
        const state = await readPageState(page);
        if (state.blocked) throw new Error(describeBlocked());
        if (state.loginLinkCount > 0 && state.composerCount === 0) throw new Error(describeSignedOut());

        await page.waitForSelector(CHATGPT_WEB.composer, { timeout: CHATGPT_WEB.navigationTimeoutMs });
        const before = await page.locator(CHATGPT_WEB.assistantMessage).count();

        await page.fill(CHATGPT_WEB.composer, prompt);
        // The send button is disabled until the composer holds text, so it is clicked only
        // once it is actually there.
        await page.waitForSelector(CHATGPT_WEB.sendButton, { timeout: 10_000 });
        await page.click(CHATGPT_WEB.sendButton);

        /**
         * Waiting for the turn to finish is waiting for the stop button to *disappear*,
         * which is the only completion signal the page exposes. Then the new assistant
         * message is read.
         */
        await page.waitForSelector(CHATGPT_WEB.stopButton, { timeout: 15_000 }).catch(() => undefined);
        await page.waitForFunction(
          `(() => { const stop = document.querySelector(${JSON.stringify(CHATGPT_WEB.stopButton)}); const sent = document.querySelectorAll(${JSON.stringify(CHATGPT_WEB.assistantMessage)}).length; return !stop && sent > ${before}; })()`,
          undefined,
          { timeout: timeoutMs },
        );

        const messages_ = await page.locator(CHATGPT_WEB.assistantMessage).allTextContents();
        const text = (messages_[messages_.length - 1] ?? '').trim();
        return { text };
      } catch (error) {
        if (error instanceof Error && /Timeout .* exceeded/i.test(error.message)) {
          throw new Error(`The ChatGPT page did not finish within ${Math.round(timeoutMs / 1000)}s. The page may have shown a sign-in prompt or a challenge instead of the conversation.`);
        }
        throw error;
      } finally {
        await context?.close().catch(() => undefined);
        await browser.close().catch(() => undefined);
      }
    },
  };
}
