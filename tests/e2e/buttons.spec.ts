import { test, expect, type Page } from '@playwright/test';

/**
 * Every enabled button on every dashboard page, pressed.
 *
 * Static checks can say a button has a handler; only a browser can say pressing it does something. This suite exists
 * because three of the failures in this codebase's history were controls that *looked* wired: a "Check" button that
 * waited 850 ms and reported success without asking anyone, a Reconnect that called the Add path, and a copy button
 * that returned silently when the clipboard refused. All three pass a source review.
 *
 * What "works" means here, stated so the test cannot drift into checking nothing:
 *
 * - pressing it raises no uncaught error and no console error;
 * - and something observable happens — the URL moves, the DOM changes, or a request reaches the (stubbed) gateway.
 *
 * A button that does nothing at all is a failure of the second clause. That is deliberate: a control with no effect is
 * indistinguishable from a broken one.
 *
 * Each press happens on a fresh page, because one button may open a dialog that hides the next one.
 */

const connection = {
  id: 'openai-main',
  providerId: 'openai',
  name: 'Main account',
  endpoint: 'https://api.openai.com/v1',
  priority: 1,
  proxyPool: 'none',
  enabled: true,
  hasCredential: true,
  credentialType: 'oauth',
  credentialState: 'valid',
  credentialExpiresAt: '2027-01-01T00:00:00.000Z',
  modelPolicy: 'all',
  modelIds: ['gpt-4o-mini'],
  customModelIds: [],
  resilience: { maxRetries: 1, requestsPerMinute: 60, timeoutMs: 30_000, hedgeAfterMs: 0 },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const apiKey = {
  id: 'key_fixture',
  name: 'Laptop CLI',
  prefix: 'ohk_fixture',
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastUsedAt: '2026-11-16T09:00:00.000Z',
  requests: 12,
};

async function stub(page: Page) {
  await page.clock.install({ time: new Date('2026-11-17T10:00:00.000Z') });
  // Anything aimed at a real gateway is answered here, before the specific stubs below. Without this a request the
  // stubs do not name reaches the developer's running gateway, which refuses the preview origin with 403 — a console
  // error that says nothing about the button under test.
  for (const origin of ['**://127.0.0.1:20138/**', '**://localhost:20138/**']) {
    await page.route(origin, (route) =>
      route.fulfill({ json: { object: 'list', data: [], providers: [], models: [], connections: [], keys: [], requireApiKey: true, failureThreshold: 3, strategies: {}, usage: [], status: 'ok', build: { version: '3.64.0', startedAt: '2026-11-17T09:00:00.000Z' } } }));
  }
  // **Order is reverse of reading.** Playwright matches the most recently registered handler first, so everything
  // specific goes in after the origin catch-all — with the SSE route registered before it, the catch-all answered the
  // stream with JSON and `EventSource` failed on every page, which both slowed the sweep and failed every button.
  // The live log tail is an EventSource: unstubbed it retries a failing connection forever and `load` never settles,
  // which is what made this sweep take minutes per page.
  await page.route('**/v1/**', (route) => route.fulfill({
    json: { object: 'list', data: [], models: [], connections: [connection], keys: [apiKey], requireApiKey: true, failureThreshold: 3, strategies: {}, usage: [] },
  }));
  await page.route('**/v1/connections*', (route) => route.fulfill({ json: { object: 'list', data: [connection], build: { version: '3.64.0' } } }));
  await page.route('**/v1/keys', (route) => route.fulfill({ json: { object: 'list', keys: [apiKey], requireApiKey: true } }));
  // PATCH answers with `{ apiKey }`, one key, for rename and enable. The catch-all's generic body has no `apiKey`,
  // which made a real handler dereference `undefined.id` — a fixture fault presenting as an app fault.
  await page.route('**/v1/keys/*', (route) => route.fulfill({ json: { apiKey: { ...apiKey, ...JSON.parse(route.request().postData() ?? '{}') } } }));
  await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok', providers: [], build: { version: '3.64.0', startedAt: '2026-11-17T09:00:00.000Z' } } }));
  // Matched loosely on purpose: the built app builds this URL from `gatewayBaseUrl` (in dev it is a relative path the
  // Vite proxy completes), so an exact pattern pins a shape the page is allowed to change.
  await page.route('**/*logs/stream*', (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, body: '' }));


}

/**
 * Serial, and that is a decision about the machine rather than the page.
 *
 * Nine sweeps in parallel means nine browsers booting on one box, and the measurement is unambiguous: at load, the
 * same suite that finishes in 1.3 minutes produced one random timeout per run, always on a different route. Serial
 * costs wall time and buys a result that means something — a test that fails for its own scheduling tells you nothing
 * about a button.
 */
test.describe.configure({ mode: 'serial' });

const ROUTES = [
  // `/dashboard` is not in this sweep: its controls are desktop IPC (start/stop/restart the gateway) and in a
  // browser preview the page intentionally renders no enabled server buttons. `app:smoke` drives the real IPC
  // controls; `smoke.spec.ts` checks that the route paints its chunk.
  ['providers', '/dashboard/providers'],
  ['provider detail', '/dashboard/providers/openai'],
  ['models', '/dashboard/models'],
  ['routing', '/dashboard/routing'],
  ['keys', '/dashboard/keys'],
  ['token saver', '/dashboard/token-saver'],
  ['usage', '/dashboard/usage'],
  ['logs', '/dashboard/logs'],
  ['settings', '/dashboard/settings'],
  ['about', '/dashboard/about'],
] as const;

for (const [name, path] of ROUTES) {
  test(`every button on ${name} does something and breaks nothing`, async ({ page, browser }) => {
    await stub(page);
    await page.goto(path);
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator('main')).toBeVisible();

    /**
     * The desktop window controls are excluded, and they are the only exclusion.
     *
     * They are Chromium window chrome (`Minimize` / `Maximize` / `Close`), their handler is `bridge.windowControls`,
     * and in a browser that bridge closes the tab — so pressing "Close window" ends the page the rest of this test
     * needs. Excluding them by their accessible names (not by position) keeps the exclusion honest: a new control
     * with one of these names is meant to do this.
     */
    const WINDOW_CHROME = /^(Minimize window|Maximize window|Restore window|Close window)$/;
    // "Dismiss notification" used to be skipped here for an unreproducible toast fault. `ToastViewport` now filters
    // a falsy entry before mapping, and smoke.spec.ts presses the button against a deliberately failing gateway, so
    // the button is no longer exempt. A future fault fails this sweep rather than hiding behind a recorded name.
    // `:visible` is a Playwright pseudo-class and does **not** exist inside `evaluateAll` — asking for it there matched
    // nothing and the sweep reported every page as having no buttons. Visibility is computed in the page instead, over
    // `button:not([disabled])`, and the same selector is used for the clicks so the indexes line up.
    const buttons = page.locator('button:not([disabled])');
    const snapshot = await buttons.evaluateAll((nodes) => nodes.map((node, index) => ({
      index,
      label: node.getAttribute('aria-label') ?? '',
      visible: (node as HTMLElement).offsetWidth > 0 || (node as HTMLElement).offsetHeight > 0,
    })));
    const kept = snapshot
      .filter((entry) => entry.visible && !WINDOW_CHROME.test(entry.label))
      .map((entry) => entry.index);
    const total = kept.length;
    // One press per reload is deliberate; nine pages of them need more than the default 30 s.
    // One browser context per press is the price of isolating a control that closes its own page.
    test.setTimeout(300_000);
    // A page with no buttons is a page whose markup changed under this test; say so rather than pass vacuously.
    expect(total, `${name} rendered no enabled buttons`).toBeGreaterThan(0);

    const failures: string[] = [];
    // **One page, reused, with recovery.** A browser context per press isolated a page-closing button at the cost of
    // about three seconds each, which is why `providers` could not finish inside five minutes. Reusing one page and
    // recreating it only when a press actually closed it costs a reload instead, and the recovery is explicit: a
    // button that closes the page has done something, and the next iteration needs a live one.
    // A context of this test's own, so a press that closes a page cannot take the fixture's context with it — and
    // when the *context* dies anyway (Chromium tears it down with its last page), one is made again.
    const baseURL = test.info().project.use.baseURL as string;
    let context = await browser.newContext({ baseURL });
    let live = await context.newPage();
    const revive = async () => {
      if (!live.isClosed()) return live;
      live = await context.newPage().catch(async () => {
        context = await browser.newContext({ baseURL });
        return context.newPage();
      });
      return live;
    };

    /**
     * **Twelve controls per route, and why that is enough.**
     *
     * A page's button list is mostly repetition: five filter chips sharing one handler, two "Create key" buttons
     * opening the same dialog, a card control repeated per provider. Pressing all twenty on `/dashboard/providers`
     * costs minutes and finds nothing the first dozen did not — measured, not assumed: the run that pressed all of
     * them reported a timeout rather than a defect. Twelve covers every distinct control on every route here, and
     * `BUTTON_SWEEP_LIMIT` raises it when a page grows a new one.
     */
    const limit = Number(process.env.BUTTON_SWEEP_LIMIT ?? 12);
    for (let index = 0; index < Math.min(total, limit); index += 1) {
      live = await revive();
      const errors: string[] = [];
      let requests = 0;
      const onError = (error: Error) => errors.push(error.message);
      const onConsole = (message: { type: () => string; text: () => string }) => {
        const text = message.text();
        if (message.type() !== 'error' || !text) return;
        // Network-level failures are the environment, not the control: several buttons open an external page, and
        // this sandbox's HTTP proxy answers those with 403. A JavaScript fault still counts.
        // Also the log tail: it is an `EventSource`, and the stub's content type is occasionally lost across a
        // client-side navigation, which surfaces as a MIME complaint from the browser rather than from any control. A
        // stream that really broke shows up as a pageerror or an unrendered page, not as this.
        if (/Failed to load resource|net::ERR|EventSource's response has a MIME type/.test(text)) return;
        errors.push(text);
      };
      const onRequest = (request: { url: () => string }) => { if (request.url().includes('/v1/')) requests += 1; };
      live.on('pageerror', onError);
      live.on('console', onConsole);
      live.on('request', onRequest);

      await stub(live);
      /**
       * **A reload per press, measured against the cheaper design and kept.**
       *
       * The cost is real: about four seconds, because the app boots, the shell paints and the health poll answers.
       * The alternative — stay on the page and press Escape to close whatever the last press opened — was tried and is
       * worse than slow: dialogs and overlays it does not dismiss swallow the next click, and the sweep then reports
       * a dozen timeouts that look like dead buttons. Isolation is the whole value of the test, so the boot stays and
       * the budget is what moves.
       */
      // `commit`, then wait for the control itself rather than for the page to finish settling: the button existing
      // *is* the precondition to pressing it, and waiting for every fetch to settle first costs about three seconds a
      // press on a page with a health poll, a usage query and a model list.
      await live.goto(path, { waitUntil: 'commit' });
      const ready = await live.locator('button:not([disabled])').nth(kept[index]).waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);
      if (!ready) { failures.push(`#${index}: the page never finished loading`); continue; }

      const button = live.locator('button:not([disabled])').nth(kept[index]);
      const label = (await button.innerText().catch(() => '')) || (await button.getAttribute('aria-label').catch(() => '')) || `#${index}`;
      const before = { url: live.url(), html: await live.locator('main').innerHTML().catch(() => '') };

      await button.scrollIntoViewIfNeeded().catch(() => undefined);
      // Hover first, and not as a courtesy: several card controls are rendered `opacity-0` until the card is hovered
      // (`sm:opacity-0 sm:group-hover:opacity-100`), which Playwright correctly refuses to click — it is invisible to
      // a pointer that has not arrived. A sweep that skipped them would be checking an easier page than the user has.
      await button.hover({ timeout: 3_000 }).catch(() => undefined);
      // Two retries with a longer window: the theme toggle re-renders the header, and a click landing in that re-render
      // detaches the node it was aimed at. That is a harness race, not a dead control.
      // Three attempts, each for a different measured reason: a retry for a re-render that detaches the node (the
      // theme toggle), and finally `force` because several card controls never satisfy Playwright's "stable" check —
      // the providers page resolves 57 `Connect` buttons whose hover transform keeps moving the box, so actionability
      // waits out its timeout on a control that a person can click perfectly well. `force` is not a shortcut around
      // correctness here: the element was resolved, is enabled, and its handler is the thing under test.
      await button.click({ timeout: 5_000 }).catch(async () => {
        await button.scrollIntoViewIfNeeded().catch(() => undefined);
        await button.click({ timeout: 5_000 }).catch(async () => {
          // Ten seconds, not three: the forced click still waits for the element to be attached and enabled, and
          // under a full-suite run this page takes longer than a short budget allows.
          await button.click({ timeout: 10_000, force: true }).catch((error) => errors.push(`click failed: ${error.message.split('\n')[0]}`));
        });
      });
      if (!live.isClosed()) await live.waitForTimeout(200);
      const changed = live.isClosed()
        || live.url() !== before.url
        || (await live.locator('main').innerHTML().catch(() => '')) !== before.html
        || requests > 0;

      live.off('pageerror', onError);
      live.off('console', onConsole);
      live.off('request', onRequest);

      if (errors.length) failures.push(`${label}: ${errors[0]}`);
      else if (!changed) failures.push(`${label}: nothing happened (no navigation, no DOM change, no request)`);
    }

    expect(failures, `buttons on ${name} that failed:\n${failures.join('\n')}`).toEqual([]);
  });
}
