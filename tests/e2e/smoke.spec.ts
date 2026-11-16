import { test, expect } from '@playwright/test';

test('home page renders', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/.+/);
  await expect(page.locator('body')).toBeVisible();
});

test('dashboard route is served', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page.locator('body')).toBeVisible();
});

/**
 * Every dashboard page, actually rendered — the one thing a source-level guard cannot prove.
 *
 * Each page is its own chunk (`src/lib/pageChunks.ts`), so a page can fail to exist in the bundle while every
 * source test stays green: a renamed named export, a `lazy()` pointing at the wrong module, a route whose component
 * is not in the map. The earlier version of this file asserted `body` was visible, which a blank shell with a
 * broken route also satisfies — and it was in fact testing the marketing page, because `vite preview` had no
 * `/dashboard` fallback until that was fixed in `vite.config.ts`.
 *
 * The gateway is stubbed, not bypassed: a preview build calls the real gateway on 20138 from an origin its CORS
 * allowlist does not contain, and eleven CORS errors would drown any real one.
 *
 * **Not asserted here:** the account row's expiry badge. A stubbed `/v1/connections` row did not survive into the
 * rendered page, and asserting the fixture's own words back would be a test of the fixture. That badge is guarded
 * statically (`tests/dashboard-wiring.test.js`) and was verified against a live gateway, which reported
 * `credentialState=expiring` and `credentialExpiresAt` on a real OAuth row.
 */
async function stubGateway(page: import('@playwright/test').Page) {
  // Order matters, and backwards from how it reads: Playwright consults the most recently registered handler first,
  // so the catch-all goes in first and the specific answers after it. The glob carries a `*` for the query string,
  // which an exact path does not match.
  // The shapes are the gateway's own, read off it: `/v1/routing` carries `connections`, `/v1/keys` carries `keys`,
  // and the rest carry `data`. A page that asks for `keys` and is handed `data` throws on `keys.filter`, which is a
  // blank screen — so a stub with a plausible-but-wrong shape is worse than no stub at all.
  await page.route('**/v1/**', (route) => route.fulfill({
    json: { object: 'list', data: [], models: [], connections: [], keys: [], requireApiKey: false, failureThreshold: 3, strategies: {}, usage: [] },
  }));
  await page.route('**/v1/connections*', (route) => route.fulfill({ json: { object: 'list', data: [], build: { version: 'test' } } }));
  await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok', build: { version: 'test', startedAt: new Date().toISOString() } } }));
  // The live log tail is an EventSource, and a JSON body makes the browser refuse the stream with a console error
  // that is about the stub, not the dashboard. An empty event-stream keeps the connection quiet and idle.
  await page.route('**/v1/logs/stream*', (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, body: '' }));
}

// `/dashboard/token-saver` is deliberately absent: it reads a stats object with `cache`, `savers` and per-provider
// totals, and a stub rich enough to satisfy it would be a second implementation of the gateway's own response. It is
// covered by the build (the chunk exists) and by its own page tests, not by a fixture that guesses.
const ROUTES = ['/dashboard/providers', '/dashboard/models', '/dashboard/routing', '/dashboard/keys', '/dashboard/usage', '/dashboard/logs', '/dashboard/settings', '/dashboard/about'];

test('every dashboard route paints its own chunk', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() !== 'error' || !text) return;
    errors.push(`${text} @ ${message.location().url || '(no url)'}`);
  });
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
  await stubGateway(page);

  for (const path of ROUTES) {
    await page.goto(path);
    // The skeleton carries `aria-busy`; a page whose chunk never loads leaves it there, which is the failure a
    // visibility check on `body` cannot see.
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator('main')).toBeVisible();
    // The shell's own title, so a fallback to the marketing document fails here instead of passing quietly.
    await expect(page).toHaveTitle(/Dashboard/);
  }

  expect(errors, `the dashboard reported errors: ${errors.join(' | ')}`).toEqual([]);
});
