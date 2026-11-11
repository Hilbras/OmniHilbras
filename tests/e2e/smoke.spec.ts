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
