import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

/**
 * The accessibility gate.
 *
 * axe runs against the real dashboard, not a component fixture: the violations worth failing on are
 * the ones a page composes (a label lost in a list, contrast inherited from a token, a control with
 * no name). `serious` and `critical` fail; `moderate` and `minor` are reported by axe but do not stop a
 * release, so the gate is a floor rather than a claim of full conformance.
 */
for (const route of [
  '/dashboard',
  '/dashboard/providers',
  '/dashboard/models',
  '/dashboard/routing',
  '/dashboard/keys',
  '/dashboard/usage',
  '/dashboard/prompts',
  '/dashboard/logs',
  '/dashboard/settings',
  '/dashboard/about',
  '/dashboard/token-saver',
  '/dashboard/mitm',
  '/dashboard/proxy-pools',
  '/dashboard/tunnels',
  '/dashboard/skills',
  '/dashboard/translators',
  '/dashboard/cli-tools',
]) {
  test(`${route} has no serious or critical axe violations`, async ({ page }) => {
    await page.goto(route);
    await expect(page.locator('main')).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 20_000 });
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    const blocking = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
    expect(
      blocking.map((violation) => ({ id: violation.id, impact: violation.impact, nodes: violation.nodes.length })),
      JSON.stringify(blocking.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => ({ html: node.html, why: node.failureSummary })).slice(0, 8) })), null, 2),
    ).toEqual([]);
  });
}
