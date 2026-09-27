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
  title: () => Promise<string>;
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
  const documentTitle = await page.title().catch(() => '');
  // A Cloudflare interstitial has an empty body, so the title is what identifies it.
  const blocked = /just a moment|unable to load site|attention required|access denied|checking your browser/i.test(
    `${documentTitle ?? ''} ${bodyText ?? ''}`,
  );
  return { loginLinkCount, composerCount, blocked, title: documentTitle, bodyHead: bodyText ?? '' };
}

function describeBlocked(): string {
  return 'chatgpt.com served its bot-protection challenge instead of the application, so no turn was attempted. This is a network-level block on the address OmniHilbras is running from — it happens with a valid session, so it is not a problem with your export. A residential connection with no VPN or datacenter is the usual fix.';
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
      // Hoisted so the failure path can re-read the page and name what it actually showed,
      // rather than reporting a bare timeout that helps nobody.
      let page: PlaywrightPage | undefined;
      try {
        context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        // Chunked before they are set, because an oversized cookie fails the whole batch.
        await context.addCookies(cookies.flatMap((cookie) => chunkCookie(cookie)).map(toPlaywrightCookie));
        page = await context.newPage();

        await page.goto(CHATGPT_WEB.startUrl, { waitUntil: 'domcontentloaded', timeout: CHATGPT_WEB.navigationTimeoutMs });

        // Checked before typing, so a stale export is named as a stale export — and a
        // blocked edge is named as a blocked edge rather than mistaken for one.
        const state = await readPageState(page);
        if (state.blocked) throw new Error(describeBlocked());
        if (state.loginLinkCount > 0 && state.composerCount === 0) throw new Error(describeSignedOut());

        /**
         * A challenge page is not necessarily present the instant `goto` returns, so the
         * page is re-inspected when the composer never arrives. Reporting only "it timed
         * out" is what made this look like a model problem rather than a refused request.
         */
        const composerAppeared = await page
          .waitForSelector(CHATGPT_WEB.composer, { timeout: CHATGPT_WEB.navigationTimeoutMs })
          .then(() => true)
          .catch(() => false);
        if (!composerAppeared) {
          const after = await readPageState(page);
          if (after.blocked) throw new Error(describeBlocked());
          if (after.loginLinkCount > 0) throw new Error(describeSignedOut());
          throw new Error(
            `The ChatGPT page loaded but never showed a composer. The document title was ${JSON.stringify(after.title)}${
              after.bodyHead ? ` and the page said ${JSON.stringify(after.bodyHead.slice(0, 120))}` : ' with an empty body'
            }.`,
          );
        }
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
          // The turn itself timed out, which is a different thing from the page never
          // loading — so the page is re-read before saying so.
          const after = page ? await readPageState(page).catch(() => undefined) : undefined;
          if (after?.blocked) throw new Error(describeBlocked());
          if (after?.loginLinkCount) throw new Error(describeSignedOut());
          throw new Error(`The ChatGPT page never finished the turn within ${Math.round(timeoutMs / 1000)}s.`);
        }
        throw error;
      } finally {
        await page?.close().catch(() => undefined);
        await context?.close().catch(() => undefined);
        await browser.close().catch(() => undefined);
      }
    },
  };
}
