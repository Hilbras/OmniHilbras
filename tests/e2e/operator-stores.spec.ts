import { test, expect, type Page } from '@playwright/test';

/**
 * The four operator pages against a fake gateway.
 *
 * Each page renders only what its own list route returned, so a stub with a distinct row per store is
 * enough to tell a working page from one that shows another store's data or a hardcoded placeholder.
 * A `NOT_SUPPORTED` answer is asserted verbatim on one page, because "this build has no store" and
 * "the store is empty" must not look the same to an operator.
 */

const pages = [
  { path: '/mitm', route: '**/v1/mitm', title: 'MITM', row: { id: 'mitm_1', name: 'Local intercept', port: 8443, enabled: true } },
  { path: '/proxy-pools', route: '**/v1/proxy-pools', title: 'Proxy pools', row: { id: 'pool_1', name: 'Residential', size: 3, enabled: true } },
  { path: '/tunnels', route: '**/v1/tunnels', title: 'Tunnels', row: { id: 'tunnel_1', name: 'Edge', provider: 'cloudflared', publicUrl: 'https://edge.example.test', hasToken: true } },
  { path: '/skills', route: '**/v1/skills', title: 'Skills', row: { id: 'skill_1', name: 'Triage', description: 'A saved skill', enabled: true } },
];

async function stub(page: Page) {
  await page.route('**/v1/**', (route) => route.fulfill({
    json: { object: 'list', data: [], models: [], connections: [], keys: [], requireApiKey: false, failureThreshold: 3, strategies: {} },
  }));
  await page.route('**/health', (route) => route.fulfill({
    json: { status: 'ok', providers: [], build: { version: 'test', startedAt: new Date().toISOString() } },
  }));
}

for (const entry of pages) {
  test(`${entry.title} page shows only its own gateway rows`, async ({ page }) => {
    await stub(page);
    const requested: string[] = [];
    await page.route(entry.route, async (route) => {
      requested.push(new URL(route.request().url()).pathname);
      await route.fulfill({ json: { object: 'list', data: [entry.row] } });
    });
    await page.goto(`/dashboard${entry.path}`);
    await expect(page.getByRole('heading', { name: entry.title })).toBeVisible();
    await expect(page.getByText(String(entry.row.name))).toBeVisible();
    expect(requested).toContain(entry.route.replace('**', ''));
  });
}

test('an operator page prints a gateway NOT_SUPPORTED refusal verbatim', async ({ page }) => {
  await stub(page);
  await page.route('**/v1/skills', (route) => route.fulfill({
    status: 501,
    json: { error: { code: 'NOT_SUPPORTED', message: 'Skills are not available in this gateway build.' } },
  }));
  await page.goto('/dashboard/skills');
  await expect(page.getByRole('alert')).toContainText('Skills are not available in this gateway build.');
});
