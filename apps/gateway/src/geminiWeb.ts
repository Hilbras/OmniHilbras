import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  GEMINI_WEB,
  GEMINI_WEB_PRIMARY_COOKIE,
  geminiWebProviderId,
  mergeRotatedGeminiWebCookies,
  normalizeGeminiWebCookie,
  parseGeminiWebCookieHeader,
  parseGeminiWebStreamResponse,
  type GeminiWebCookie,
  type GeminiWebDriver,
  type GeminiWebModel,
} from '@hilbras/omnihilbras';
import { ProviderError } from '@hilbras/omnihilbras';

/**
 * The browser half of Gemini Web.
 *
 * `gemini-web` in the SDK owns everything that can be reasoned about without a browser: the cookie, the
 * `StreamGenerate` payload, the model table, the refusals. This file owns the part that needs one — launch,
 * navigate, type, and read the response the page makes for itself.
 *
 * ## What it does, and the two things it deliberately does not do
 *
 * It launches Chromium, injects the cookies for `.google.com`, opens `gemini.google.com/app`, selects the
 * requested mode, types the prompt into the composer and presses Enter. The answer is not read from the DOM:
 * the page issues its own `StreamGenerate` request and this **observes that response**, which is the only place
 * the answer exists in full.
 *
 * It does not type character by character — `insertText` fires one DOM input event, so a newline in a prompt
 * cannot press Enter early and a long prompt cannot race the timeout. And it does not concatenate the captured
 * frames: they are cumulative snapshots, and joining them duplicates the reply.
 *
 * ## Cost
 *
 * Each turn launches a browser. A persistent profile is used for the same reason the ChatGPT driver uses one —
 * a cold browser is slower and re-challenges the page every time — and it is closed in `finally` whichever way
 * the turn ends.
 */

type PlaywrightModule = {
  chromium: {
    launchPersistentContext: (dir: string, options: Record<string, unknown>) => Promise<PlaywrightContext>;
  };
};

type PlaywrightContext = {
  addCookies: (cookies: unknown[]) => Promise<void>;
  cookies: () => Promise<Array<{ name: string; value: string }>>;
  newPage: () => Promise<PlaywrightPage>;
  close: () => Promise<void>;
};

type PlaywrightPage = {
  goto: (url: string, options: Record<string, unknown>) => Promise<unknown>;
  waitForSelector: (selector: string, options: Record<string, unknown>) => Promise<unknown | null>;
  waitForTimeout: (ms: number) => Promise<void>;
  keyboard: {
    insertText: (text: string) => Promise<void>;
    press: (key: string) => Promise<void>;
  };
  locator: (selector: string) => PlaywrightLocator;
  on: (event: string, handler: (arg: never) => void) => void;
  title: () => Promise<string>;
  close: () => Promise<void>;
};

type PlaywrightLocator = {
  count: () => Promise<number>;
  first: () => PlaywrightLocator;
  click: (options?: { timeout?: number }) => Promise<void>;
  textContent: () => Promise<string | null>;
  innerText: () => Promise<string>;
  isVisible: () => Promise<boolean>;
};

// The same fix as the ChatGPT driver, for the same reason: Playwright's default headless user agent announces
// itself, and Google's edge treats that as automation. The version is the one this Chromium actually reports.
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7922.34 Safari/537.36';
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

/** A profile directory per connection, so a session's profile is not another session's. */
function profileDir(connectionKey: string): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'omnihilbras', 'gemini-web', createHash('sha256').update(connectionKey).digest('hex').slice(0, 32));
}

/**
 * Whether an error is Chromium not being installed.
 *
 * Classified because the fix is different in kind from every other failure here: nothing about the credential
 * or the network is wrong, and the same message names the command that fixes it.
 */
function isMissingBrowser(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("executable doesn't exist")
    || lower.includes('executablenotfound')
    || lower.includes('playwright install')
    || (lower.includes('chromium') && lower.includes('download'));
}

/**
 * Injects the pasted cookies.
 *
 * A bare `__Secure-1PSID` value has no name in it, so it is normalised first — the same rule the SDK applies,
 * applied once more here because this is the last place before the browser sees it.
 */
async function addGeminiCookies(context: PlaywrightContext, header: string): Promise<void> {
  const pairs = parseGeminiWebCookieHeader(normalizeGeminiWebCookie(header));
  if (pairs.length === 0) {
    throw new ProviderError('AUTHENTICATION_FAILED', 'No Gemini cookie was provided.', {
      providerId: geminiWebProviderId,
      publicMessage: `Paste the value of \`${GEMINI_WEB_PRIMARY_COOKIE}\` (and \`__Secure-1PSIDTS\` if you have it).`,
    });
  }
  await context.addCookies(pairs.map((pair) => ({ name: pair.name, value: pair.value, domain: '.google.com', path: '/', secure: true })));
}

/**
 * Drives the mode menu, and **fails closed**.
 *
 * A click that lands is not evidence: the menu may not have opened, the item may not have been there, or the
 * page may already be on a different mode. So the active mode is read back and matched against the pattern, and
 * anything else is a refusal. The alternative — assume the click worked — answers with a model nobody asked for
 * and calls it the one they did.
 */
async function selectModel(page: PlaywrightPage, model: GeminiWebModel | undefined): Promise<void> {
  if (!model || model.isDefault) return;
  const failure = (reason: string) => new ProviderError('NOT_SUPPORTED', `Gemini Web could not select ${model.name} (${reason}).`, {
    providerId: geminiWebProviderId,
    publicMessage: `Gemini Web could not switch the page to ${model.name}. The page's mode menu did not confirm the change, so nothing was sent.`,
  });
  if (!model.toggleSelector || !model.indicatorSelector || !model.indicatorPattern) throw failure('no selector');

  const toggle = page.locator(model.toggleSelector).first();
  if ((await toggle.count()) === 0) throw failure('control not found');
  await toggle.click({ timeout: 5_000 }).catch(() => { throw failure('control not clickable'); });

  const indicator = page.locator(model.indicatorSelector).first();
  if ((await indicator.count()) === 0) throw failure('indicator not found');
  const text = (await indicator.textContent().catch(() => null)) ?? (await indicator.innerText().catch(() => ''));
  if (!model.indicatorPattern.test(text)) throw failure(`the page still reports ${JSON.stringify(text.trim())}`);
}

export function createGeminiWebDriver(connectionKey = 'default'): GeminiWebDriver {
  return {
    async available() {
      const playwright = await loadPlaywright();
      if (!playwright) {
        return {
          ok: false,
          reason: 'Gemini Web needs a browser, and Playwright is not installed. Run `pnpm add playwright-core` in the gateway, then `npx playwright install chromium`.',
        };
      }
      return { ok: true };
    },

    /**
     * Confirms the session is signed in, by opening the page.
     *
     * This is what the connect dialog's "Check cookie" button means, and it is why the button costs a page load:
     * cookie presence and expiry are local checks, and neither can tell a working session from one Google has
     * revoked. Only the page knows.
     */
    async verify({ cookie, timeoutMs = GEMINI_WEB.navigationTimeoutMs + GEMINI_WEB.settleMs }) {
      const { context, close } = await open(connectionKey, cookie);
      try {
        const page = await context.newPage();
        await page.goto(GEMINI_WEB.startUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        await page.waitForTimeout(GEMINI_WEB.settleMs);

        /**
         * The sign-in wall is checked **first**, and a composer alone is not enough.
         *
         * Both halves are load-bearing, and both were got wrong once. Gemini's signed-out page carries hidden
         * contenteditable nodes, so `waitForSelector` resolves against one of them while `locator().count()` for
         * a real composer is zero — measured on this machine with a bogus cookie:
         *
         *   url: https://gemini.google.com/app
         *   ql-editor: 0     [contenteditable=true]: 0     sign-in link: 1
         *   waitForSelector('.ql-editor, [contenteditable="true"]') -> resolved truthy
         *
         * So a check built on `waitForSelector` alone reported a signed-out session as **connected**, which is
         * the worst answer this button can give: the user saves a dead connection and only finds out when a turn
         * fails. The composer must therefore be counted *and* visible, and the wall checked before it.
         */
        const signedOut = await page.locator(GEMINI_WEB.signedOutLink).count();
        if (signedOut > 0) {
          return { ok: false, note: 'The page is showing a Google sign-in wall, so the pasted session is no longer valid. Copy fresh cookies from gemini.google.com while you are signed in.' };
        }

        const composer = page.locator(GEMINI_WEB.composer).first();
        if ((await composer.count()) > 0 && (await composer.isVisible().catch(() => false))) return { ok: true };

        return { ok: false, note: 'The Gemini page opened but no usable composer was found, so a turn could not be sent. The page may have changed, or the session may be signed out.' };
      } finally {
        await close();
      }
    },

    async ask({ cookies, model, messages, timeoutMs, signal, onRotatedCookies }) {
      const header = cookies.map((pair) => `${pair.name}=${pair.value}`).join('; ');
      const prompt = messages.at(-1)?.text ?? '';
      // The budget the adapter set bounds waiting for the answer; the navigation has its own smaller timeout.
      // Taking it rather than ignoring it keeps a caller's shorter deadline meaningful.
      const answerTimeoutMs = Math.max(1_000, timeoutMs - GEMINI_WEB.navigationTimeoutMs - GEMINI_WEB.settleMs);
      const { context, close } = await open(connectionKey, header);

      let responseText = '';
      let captured = false;
      try {
        if (signal?.aborted) throw new ProviderError('CANCELLED', 'The request was cancelled before the page opened.', { providerId: geminiWebProviderId });
        const page = await context.newPage();

        // The answer is not in the DOM; it is in the response the page makes for itself. **Only the first
        // `StreamGenerate` is taken** — later ones belong to whatever the page does next — and the promise
        // resolves even when reading the body fails, so a failure falls through to the empty-answer refusal
        // instead of burning the whole wait.
        let resolveResponse: () => void = () => {};
        const responsePromise = new Promise<void>((resolve) => { resolveResponse = resolve; });
        page.on('response', (response: never) => {
          const url = (response as { url: () => string }).url();
          if (!url.includes(GEMINI_WEB.streamMarker) || captured) return;
          captured = true;
          void (response as unknown as { text: () => Promise<string> })
            .text()
            .then((text) => { responseText = parseGeminiWebStreamResponse(text); })
            .catch(() => undefined)
            .finally(() => resolveResponse());
        });

        await page.goto(GEMINI_WEB.startUrl, { waitUntil: 'domcontentloaded', timeout: GEMINI_WEB.navigationTimeoutMs });
        await page.waitForTimeout(GEMINI_WEB.settleMs);
        if (signal?.aborted) throw new ProviderError('CANCELLED', 'The request was cancelled while the page loaded.', { providerId: geminiWebProviderId });

        await selectModel(page, model);

        // The same check the connect path makes, and for the same reason: `waitForSelector` resolves against a
        // hidden contenteditable on a signed-out page, so the sign-in wall is looked for first and the composer
        // must be counted **and visible** before a prompt is typed into it.
        if ((await page.locator(GEMINI_WEB.signedOutLink).count()) > 0) {
          throw new ProviderError('AUTHENTICATION_FAILED', 'The Gemini page is showing a sign-in wall.', {
            providerId: geminiWebProviderId,
            publicMessage: 'Gemini is showing a sign-in wall, so the pasted session is no longer valid. Copy fresh cookies from gemini.google.com while signed in, then connect again.',
          });
        }
        const composer = page.locator(GEMINI_WEB.composer).first();
        if ((await composer.count()) === 0 || !(await composer.isVisible().catch(() => false))) {
          throw new ProviderError('AUTHENTICATION_FAILED', 'No visible Gemini composer was found.', {
            providerId: geminiWebProviderId,
            publicMessage: 'The Gemini page did not show a usable composer. Copy fresh cookies from gemini.google.com while signed in, then try again.',
          });
        }
        await composer.click({ timeout: 5_000 });
        // `insertText`, not per-character typing: one DOM input event, so a newline in the prompt cannot press
        // Enter early and a long prompt cannot race the timeout.
        await page.keyboard.insertText(prompt);
        await page.waitForTimeout(300);
        await page.keyboard.press('Enter');

        await Promise.race([responsePromise, page.waitForTimeout(answerTimeoutMs)]);

        // Google rotates the session cookies during a turn, and only the jar knows the new values. Handed back
        // for storage; a failure to store them must not fail the turn, which is why the callback is optional
        // and its rejection is swallowed here.
        if (onRotatedCookies) {
          const jar = await context.cookies().catch(() => []);
          const merged = mergeRotatedGeminiWebCookies(header, jar as GeminiWebCookie[]);
          if (merged !== header) await Promise.resolve(onRotatedCookies(merged)).catch(() => undefined);
        }

        return { text: responseText };
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        if (isMissingBrowser(message)) {
          const text = 'Gemini Web needs a browser that is not installed. Run `npx playwright install chromium` in the gateway.';
          throw new ProviderError('PROVIDER_UNAVAILABLE', text, { providerId: geminiWebProviderId, retryable: false, publicMessage: text });
        }
        throw new ProviderError('PROVIDER_REQUEST_FAILED', `The Gemini page could not be driven: ${message}`, {
          providerId: geminiWebProviderId,
          retryable: true,
          publicMessage: 'The Gemini page could not be driven to an answer. The session may have expired, or the page changed.',
        });
      } finally {
        await close();
      }
    },
  };

  /** Launches the persistent profile, injects the cookies, and returns a closer that always runs. */
  async function open(key: string, cookie: string): Promise<{ context: PlaywrightContext; close: () => Promise<void> }> {
    const playwright = await loadPlaywright();
    if (!playwright) {
      const message = 'Gemini Web needs a browser, and Playwright is not installed. Run `pnpm add playwright-core` in the gateway, then `npx playwright install chromium`.';
      throw new ProviderError('PROVIDER_UNAVAILABLE', message, { providerId: geminiWebProviderId, retryable: false, publicMessage: message });
    }
    const context = await playwright.chromium.launchPersistentContext(profileDir(key), {
      headless: true,
      userAgent: BROWSER_USER_AGENT,
      locale: BROWSER_LOCALE,
      timezoneId: BROWSER_TIMEZONE,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    try {
      await addGeminiCookies(context, cookie);
    } catch (error) {
      await context.close().catch(() => undefined);
      throw error;
    }
    return { context, close: async () => { await context.close().catch(() => undefined); } };
  }
}