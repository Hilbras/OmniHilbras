import { test, expect, type Page } from '@playwright/test';

/**
 * The translator inspector against a fake gateway.
 *
 * The page has no translate/send/save surface: the only thing it can honestly render is the pair list
 * from `GET /v1/translators`. A distinct pair in the stub proves the row came from the gateway rather
 * than from a hardcoded placeholder, and a refused answer must be printed instead of looking like an
 * empty-but-healthy inventory.
 */

async function stub(page: Page) {
  await page.route('**/v1/**', (route) => route.fulfill({
    json: { object: 'list', data: [], models: [], connections: [], keys: [], requireApiKey: false, failureThreshold: 3, strategies: {} },
  }));
  await page.route('**/health', (route) => route.fulfill({
    json: { status: 'ok', providers: [], build: { version: 'test', startedAt: new Date().toISOString() } },
  }));
}

test('the translator page renders only the pairs the gateway returned', async ({ page }) => {
  await stub(page);
  const requested: string[] = [];
  await page.route('**/v1/translators', async (route) => {
    requested.push(new URL(route.request().url()).pathname);
    await route.fulfill({ json: { object: 'list', data: [{ source: 'messages-api', target: 'openai-chat' }] } });
  });
  await page.goto('/dashboard/translators');
  await expect(page.getByRole('heading', { name: 'Translators' })).toBeVisible();
  await expect(page.getByText('messages-api → openai-chat')).toBeVisible();
  expect(requested).toContain('/v1/translators');
});

test('a refused inventory is shown verbatim, not as an empty healthy list', async ({ page }) => {
  await stub(page);
  await page.route('**/v1/translators', (route) => route.fulfill({
    status: 501,
    json: { error: { code: 'NOT_SUPPORTED', message: 'Translators are not available in this gateway build.' } },
  }));
  await page.goto('/dashboard/translators');
  // Scope to the page's own alert: the shell also has a failure-feed toast with role=alert, and an
  // unscoped getByRole would match both after the stubbed gateway error.
  await expect(page.getByRole('alert').filter({ hasText: 'Translators are not available' })).toContainText('Translators are not available in this gateway build.');
});
