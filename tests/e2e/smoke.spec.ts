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
  await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok', providers: [], build: { version: 'test', startedAt: new Date().toISOString() } } }));
  // The live log tail and the state-change channel are EventSources, and a JSON body makes the browser refuse
  // the stream with a console error that is about the stub, not the dashboard. `/v1/events` opened on **every**
  // dashboard route by the shell's status hook, so a missing stub here failed the whole-routes spec everywhere
  // at once — the MIME error CI reported. Empty event-streams keep both connections quiet and idle.
  await page.route('**/v1/logs/stream*', (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, body: '' }));
  await page.route('**/v1/events*', (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, body: '' }));
}

test('the model dialog closes on Escape and gives focus back to its opener', async ({ page }) => {
  await stubGateway(page);
  await page.route('**/v1/connections*', (route) => route.fulfill({ json: { object: 'list', data: [{ id: 'c1', providerId: 'openai', name: 'Main', endpoint: 'https://api.openai.com/v1', priority: 1, proxyPool: 'none', enabled: true, hasCredential: true, credentialType: 'api-key', credentialState: 'valid', modelPolicy: 'all', modelIds: ['gpt-4o-mini'], customModelIds: [], resilience: {} }] } }));
  await page.goto('/dashboard/models');
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 20_000 });
  const opener = page.getByRole('button', { name: 'Create model' }).first();
  await opener.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('input').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('a toast can be dismissed without a JavaScript fault', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    // The deliberately failing health fetch logs its own 500; that is the fixture, not a page fault.
    if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) errors.push(message.text());
  });
  await stubGateway(page);
  await page.route('**/health*', (route) => route.fulfill({ status: 500, json: { error: 'gateway down' } }));
  await page.goto('/dashboard/providers');
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 20_000 });
  const dismiss = page.getByRole('button', { name: 'Dismiss notification' });
  await expect(dismiss.first()).toBeVisible();
  await dismiss.first().click();
  // The health probe keeps failing and can add a new notice while we click. The property under test is that a
  // dismiss does not throw, not that the page has no toasts at all.
  await page.waitForTimeout(200);
  expect(errors, `the page reported errors: ${errors.join(' | ')}`).toEqual([]);
});

test('the servers page paints an honest empty state for a partial system sample', async ({ page }) => {
  await stubGateway(page);
  await page.route('**/v1/system*', (route) => route.fulfill({ json: { object: 'system' } }));
  await page.goto('/dashboard');
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator('main')).toBeVisible();
  await expect(page.getByText(/Waiting for the gateway to answer/).first()).toBeVisible();
});

test('the token saver page paints an honest empty state for a partial stats body', async ({ page }) => {
  await stubGateway(page);
  await page.route('**/v1/token-saver/stats*', (route) => route.fulfill({ json: { totalTokensSaved: 12 } }));
  await page.goto('/dashboard/token-saver');
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator('main')).toBeVisible();
  await expect(page.getByText(/No compression telemetry in this period/)).toBeVisible();
  await expect(page.getByText(/No per-provider savings in this period/)).toBeVisible();
});

test('a later providers notice is not cleared by an earlier notice timer', async ({ page }) => {
  await stubGateway(page);
  await page.route('**/health*', (route) => route.fulfill({ json: { status: 'ok', providers: [], build: { version: 'test', startedAt: new Date().toISOString() } } }));
  await page.goto('/dashboard/providers');
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 20_000 });
  const button = page.getByRole('button', { name: 'Test all' });
  await button.click();
  await expect(page.getByRole('status')).toContainText('provider connections are healthy');
  await expect(button).toBeEnabled();
  await button.click();
  // The first notice's 3.5 s timer used to clear this one early.
  await page.waitForTimeout(3_800);
  await expect(page.getByRole('status')).toContainText('provider connections are healthy');
});

test('the Settings enforcement switch states that enforcement is unknown until the gateway answers', async ({ page }) => {
  await stubGateway(page);
  await page.route('**/v1/settings*', (route) => route.fulfill({ status: 500, json: { error: 'gateway down' } }));
  await page.route('**/v1/keys*', (route) => route.fulfill({ status: 500, json: { error: 'gateway down' } }));
  await page.goto('/dashboard/settings');
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 20_000 });
  const control = page.getByRole('switch', { name: 'Require an API key' });
  await expect(control).toHaveAttribute('aria-checked', 'false');
  await expect(control).toBeDisabled();
  await expect(page.getByText(/unknown until the gateway answers/i)).toBeVisible();
});

test('the Settings connection check reports a gateway failure, never a green answer', async ({ page }) => {
  await stubGateway(page);
  // Registered after the catch-all: Playwright's newest handler wins, so this failing pair is what the page sees.
  await page.route('**/v1/settings*', (route) => route.fulfill({ status: 500, json: { error: 'gateway down' } }));
  await page.route('**/v1/keys*', (route) => route.fulfill({ status: 500, json: { error: 'gateway down' } }));
  await page.goto('/dashboard/settings');
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 20_000 });
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText('Gateway connection OK.')).toHaveCount(0);
  await expect(page.getByText(/did not answer|down|failed|error/i).first()).toBeVisible();
});

// `/dashboard/token-saver` is deliberately absent: it reads a stats object with `cache`, `savers` and per-provider
// totals, and a stub rich enough to satisfy it would be a second implementation of the gateway's own response. It is
// covered by the build (the chunk exists) and by its own page tests, not by a fixture that guesses.
const ROUTES = ['/dashboard', '/dashboard/providers', '/dashboard/models', '/dashboard/routing', '/dashboard/keys', '/dashboard/usage', '/dashboard/token-saver', '/dashboard/logs', '/dashboard/settings', '/dashboard/about'];

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
