import { expect, test, type Page } from '@playwright/test';

/**
 * The Logs page names a tool contract that was stripped, instead of leaving a successful turn looking
 * like a completed agent step. The record is a stub: no provider is called and no tool name is needed.
 */

async function stubGateway(page: Page) {
  await page.route('**/v1/**', (route) => route.fulfill({
    json: { object: 'list', data: [], models: [], connections: [], keys: [], usage: [] },
  }));
  await page.route('**/v1/usage*', (route) => route.fulfill({
    json: {
      recording: true,
      totals: { requests: 1, succeeded: 1, failed: 0, cancelled: 0, inputTokens: 10, outputTokens: 5, tokensUnmeasured: false, tokensEstimated: false },
      records: [{
        id: 'req_tools', at: new Date().toISOString(), model: 'm', providerId: 'new-provider',
        outcome: 'success', attempts: 1, latencyMs: 42,
        toolContract: { declared: 2, forwarded: 0, stripped: 2, dropped: 0 },
      }],
    },
  }));
  await page.route('**/v1/logs/stream*', (route) => route.fulfill({
    status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, body: '',
  }));
  await page.route('**/v1/events*', (route) => route.fulfill({
    status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, body: '',
  }));
}

test('a stripped tool contract is visible and searchable in the log', async ({ page }) => {
  await stubGateway(page);
  await page.goto('/dashboard/logs');
  await expect(page.getByText('2 tools stripped')).toBeVisible({ timeout: 15_000 });

  await page.getByPlaceholder(/search/i).fill('tools stripped');
  await expect(page.getByText('2 tools stripped')).toBeVisible();
  await expect(page.getByText('m · new-provider · 1 attempt')).toBeVisible();
});
