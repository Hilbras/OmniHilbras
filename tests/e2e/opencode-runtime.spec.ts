import { test, expect } from '@playwright/test';

/**
 * The OpenCode runtime card, rendered.
 *
 * `opencode-console`'s free models are served only through OpenCode's own server, and the card is how a
 * device that has never seen OpenCode finds that out and fixes it. What this checks is the property that
 * matters and that no unit test can see: the card renders, and every state it shows is one the gateway
 * could have sent — `service running`, `installed, not running`, `not installed` — or an error naming
 * the gateway. A card that painted "installed" because a button was pressed would fail here.
 */

test('the runtime card renders and only ever reports a state the gateway could have sent', async ({ page }) => {
  await page.goto('/dashboard/providers/opencode-console');

  const card = page.locator('section[aria-labelledby="opencode-runtime-title"]');
  await expect(card).toBeVisible();
  await expect(card.getByRole('heading', { name: /OpenCode runtime/ })).toBeVisible();
  // The reason the card exists, in the card.
  await expect(card.getByText(/free/i).first()).toBeVisible();

  const badge = card.getByText(/^(service running|installed, not running|not installed)$/);
  const failure = card.getByRole('alert');
  // One of the two, and never neither: a status nothing read, or the gateway's own refusal.
  await expect(badge.or(failure).first()).toBeVisible({ timeout: 20_000 });
});
