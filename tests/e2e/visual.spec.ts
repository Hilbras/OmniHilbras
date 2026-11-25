import { test, expect, type Page } from '@playwright/test';

/**
 * The dashboard as pixels, in both themes.
 *
 * The reason this exists is in the git history: five hand-rolled switches in three sizes, two with a hard-coded
 * `#f0643b` and one animating `left`, and nothing noticed for releases. Every guard we had read source code, and a
 * control can be correct in source and wrong on screen.
 *
 * Three decisions make this a test rather than a source of noise:
 *
 * - **The clock is fixed.** The keys page renders `Last used 5 min ago`, which would change the pixels every morning
 *   and turn a baseline into a chore. `page.clock.install` pins `Date.now()` inside the page.
 * - **The gateway is stubbed with fixed dates**, for the same reason.
 * - **Animations are off and the skeleton must be gone** before the shot, so a slow machine does not photograph a
 *   half-loaded page.
 *
 * Baselines are per-platform (`-linux` in the filename) because font rasterisation differs, and the e2e job runs on
 * `ubuntu-latest` — the same platform they were recorded on.
 *
 * A baseline is a claim about how the dashboard is *supposed* to look. When it fails, the first question is whether
 * the change was intended — and regenerating it is `--update-snapshots`, which is a commit, not a reflex.
 */

const FIXED_NOW = new Date('2026-11-17T10:00:00.000Z');

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
  credentialState: 'expiring',
  credentialExpiresAt: '2026-11-17T10:10:00.000Z',
  modelPolicy: 'all',
  modelIds: ['gpt-4o-mini'],
  customModelIds: [],
  resilience: { maxRetries: 1, requestsPerMinute: 60, timeoutMs: 30_000, hedgeAfterMs: 0 },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const apiKey = {
  id: 'key_fixture1',
  name: 'Laptop CLI',
  prefix: 'ohk_fixture',
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastUsedAt: '2026-11-17T09:00:00.000Z',
  requests: 128,
  rpm: 60,
  expiresAt: '2027-01-01T00:00:00.000Z',
};

async function prepare(page: Page, theme: 'dark' | 'light') {
  await page.clock.install({ time: FIXED_NOW });
  await page.addInitScript((value) => window.localStorage.setItem('omnihilbras-theme', value), theme);

  await page.route('**/v1/**', (route) => route.fulfill({
    json: { object: 'list', data: [], models: [], connections: [], keys: [], requireApiKey: false, failureThreshold: 3, strategies: {}, usage: [] },
  }));
  await page.route('**/v1/connections*', (route) => route.fulfill({ json: { object: 'list', data: [connection], build: { version: '3.64.0' } } }));
  await page.route('**/v1/keys', (route) => route.fulfill({ json: { object: 'list', keys: [apiKey], requireApiKey: true } }));
  await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok', providers: [], build: { version: '3.64.0', startedAt: '2026-11-17T09:00:00.000Z' } } }));
  await page.route('**/v1/logs/stream*', (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: '' }));
}

/**
 * Two of the three pages are not deterministic yet, measured rather than felt.
 *
 * Taking the same shot twice in a row and comparing it to itself gave **1,845 different pixels** on `providers` and
 * **541** on `settings` — far above the 40-pixel tolerance that catches a colour change, which means those pages render
 * something that moves between runs (a relative time, a poll, an order). A baseline that differs from itself is not a
 * baseline; it is a coin toss with a screenshot attached.
 *
 * `keys` is stable and stays. The other two are `fixme` with the number, so the gap is visible and the next person
 * knows exactly what to make deterministic first.
 */
const ROUTES = [
  ['keys', '/dashboard/keys'],
] as const;

const NOT_YET_DETERMINISTIC = [
  ['providers', '/dashboard/providers'],
  ['settings', '/dashboard/settings'],
] as const;

for (const [name] of NOT_YET_DETERMINISTIC) {
  test.fixme(`${name} has a deterministic screenshot baseline`, async () => {
    // 1,845 and 541 pixels respectively between two identical runs. See the note above.
  });
}

for (const theme of ['dark', 'light'] as const) {
  for (const [name, path] of ROUTES) {
    test(`${name} looks the same in ${theme}`, async ({ page }) => {
      await prepare(page, theme);
      await page.goto(path);
      // The skeleton carries `aria-busy`; photographing a page that is still loading bakes the loading state in.
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 20_000 });
      await expect(page.locator('main')).toBeVisible();
      await expect(page).toHaveScreenshot(`dashboard-${name}-${theme}.png`, {
        animations: 'disabled',
        timeout: 20_000,
        // **Absolute pixels, not a ratio.** A 1% ratio on a 1280×720 shot is 9,216 pixels, and changing the gold token
        // to magenta slipped under it — the guard passed while the dashboard was the wrong colour. 40 pixels is
        // enough for subpixel font rendering and far too few to hide a control, a badge or a token change.
        maxDiffPixels: 40,
        threshold: 0.2,
      });
    });
  }
}
