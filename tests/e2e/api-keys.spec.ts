import { test, expect, type Page } from '@playwright/test';

/**
 * Every control on the API keys page, exercised.
 *
 * The page is small and its buttons are few, which is exactly why they get a test: a control that does nothing is
 * indistinguishable from a control that works until somebody presses it, and this page can revoke a client's access
 * with one. Nothing here asserts the gateway's own behaviour — that is `Kernel/API/test/api-keys*.test.js` — it
 * asserts that each button on the page reaches the gateway at all, sends what it claims, and updates the row.
 *
 * The gateway is stubbed with state, not with a fixed body: a stub that answers the same thing every time cannot show
 * a rename landing, and would pass a page that never sent the request.
 */

const createdSecret = 'ohk_secretOnlyShownOnce000000000000000000000000';

type Key = {
  id: string;
  name: string;
  prefix: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  requests: number;
};

function makeKey(overrides: Partial<Key> = {}): Key {
  const now = new Date().toISOString();
  return { id: 'key_a1', name: 'Cline', prefix: 'ohk_aaaaaaaa', enabled: true, createdAt: now, updatedAt: now, lastUsedAt: now, requests: 7, ...overrides };
}

/** A gateway that remembers what happened, so each test can assert the request *and* the row it produced. */
async function stubGateway(page: Page, initial: Key[] = [makeKey()]) {
  const state = { keys: initial.map((key) => ({ ...key })), requireApiKey: true, calls: [] as string[] };

  await page.route('**/v1/**', (route) => route.fulfill({ json: { object: 'list', data: [], connections: [], keys: [], requireApiKey: true, failureThreshold: 3, strategies: {} } }));
  await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok', build: { version: 'test', startedAt: new Date().toISOString() } } }));
  await page.route('**/v1/logs/stream*', (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: '' }));

  await page.route('**/v1/settings/require-api-key', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}');
    state.requireApiKey = body.requireApiKey;
    state.calls.push(`PUT require-api-key ${body.requireApiKey}`);
    await route.fulfill({ json: { requireApiKey: state.requireApiKey } });
  });

  await page.route('**/v1/keys/*', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop();
    const request = route.request();
    if (request.method() === 'DELETE') {
      state.keys = state.keys.filter((key) => key.id !== id);
      state.calls.push(`DELETE ${id}`);
      await route.fulfill({ json: { deleted: true, id } });
      return;
    }
    const body = JSON.parse(request.postData() ?? '{}');
    const target = state.keys.find((key) => key.id === id);
    if (!target) {
      await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'The API key was not found.' } } });
      return;
    }
    if ('name' in body) state.calls.push(`PATCH ${id} name ${body.name}`);
    if ('enabled' in body) state.calls.push(`PATCH ${id} enabled ${body.enabled}`);
    if ('name' in body) target.name = body.name;
    if ('enabled' in body) target.enabled = body.enabled;
    await route.fulfill({ json: { apiKey: { ...target } } });
  });

  await page.route('**/v1/keys', async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      const body = JSON.parse(request.postData() ?? '{}');
      const record = makeKey({ id: `key_new${state.keys.length}`, name: body.name, requests: 0, lastUsedAt: undefined });
      state.keys.push(record);
      state.calls.push(`POST ${body.name}`);
      await route.fulfill({ status: 201, json: { apiKey: record, key: createdSecret } });
      return;
    }
    state.calls.push('GET keys');
    await route.fulfill({ json: { object: 'list', keys: state.keys, requireApiKey: state.requireApiKey } });
  });

  return state;
}

test('every control is reachable and named', async ({ page }) => {
  await stubGateway(page);
  await page.goto('/dashboard/keys');
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create key' }).first()).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Pause Cline' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rename Cline' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete Cline' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Require API key' })).toBeVisible();
  for (const label of ['Base URL', 'Header', 'Also accepted']) {
    await expect(page.getByRole('button', { name: `Copy ${label}` })).toBeVisible();
  }
});

test('create: the dialog sends a name, shows the secret once, and the row appears at zero requests', async ({ page }) => {
  const state = await stubGateway(page, []);
  await page.goto('/dashboard/keys');
  await page.getByRole('button', { name: 'Create key' }).first().click();
  await page.getByLabel('Key name').fill('  Laptop CLI  ');
  await page.getByRole('button', { name: 'Create', exact: true }).click();

  await expect.poll(() => state.calls.filter((call) => call.startsWith('POST')).length).toBe(1);
  expect(state.calls).toContain('POST Laptop CLI');
  // The secret is shown, and it is the one the gateway minted.
  await expect(page.getByText(createdSecret)).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText(createdSecret)).toBeHidden();
  await expect(page.getByText('Laptop CLI')).toBeVisible();
  await expect(page.getByText(/0 requests/)).toBeVisible();
});

test('rename: the pencil, Enter, and Escape all do what they say', async ({ page }) => {
  const state = await stubGateway(page);
  await page.goto('/dashboard/keys');

  // Escape abandons without a request.
  await page.getByRole('button', { name: 'Rename Cline' }).click();
  await page.getByLabel('New name for Cline').fill('Abandoned');
  await page.getByLabel('New name for Cline').press('Escape');
  await expect(page.getByRole('button', { name: 'Rename Cline' })).toBeVisible();
  expect(state.calls.filter((call) => call.includes('name'))).toEqual([]);

  // Enter saves, and the row shows the new name.
  await page.getByRole('button', { name: 'Rename Cline' }).click();
  await page.getByLabel('New name for Cline').fill('Cline on the laptop');
  await page.getByLabel('New name for Cline').press('Enter');
  // Exact, because the success notice also contains the new name — the row is the assertion, not the toast.
  await expect(page.getByText('Cline on the laptop', { exact: true })).toBeVisible();
  expect(state.calls).toContain('PATCH key_a1 name Cline on the laptop');
  // The prefix and the count are untouched: a rename is not a rotation.
  await expect(page.getByText(/ohk_aaaaaaaa/)).toBeVisible();
  await expect(page.getByText(/7 requests/)).toBeVisible();
});

test('pause and resume move the switch and the badge together', async ({ page }) => {
  const state = await stubGateway(page);
  await page.goto('/dashboard/keys');
  await expect(page.getByText('active', { exact: true })).toBeVisible();

  await page.getByRole('switch', { name: 'Pause Cline' }).click();
  await expect.poll(() => state.calls).toContain('PATCH key_a1 enabled false');
  await expect(page.getByText('paused', { exact: true })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Resume Cline' })).toBeVisible();

  await page.getByRole('switch', { name: 'Resume Cline' }).click();
  await expect.poll(() => state.calls).toContain('PATCH key_a1 enabled true');
  await expect(page.getByText('active', { exact: true })).toBeVisible();
});

test('delete asks once, and cancel really cancels', async ({ page }) => {
  const state = await stubGateway(page);
  await page.goto('/dashboard/keys');

  await page.getByRole('button', { name: 'Delete Cline' }).click();
  await expect(page.getByRole('button', { name: 'Confirm' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: 'Confirm' })).toBeHidden();
  expect(state.calls).not.toContain('DELETE key_a1');

  await page.getByRole('button', { name: 'Delete Cline' }).click();
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect.poll(() => state.calls).toContain('DELETE key_a1');
  await expect(page.getByText('Cline', { exact: true })).toBeHidden();
  await expect(page.getByText('No API keys yet')).toBeVisible();
});

test('the enforcement switch sends the value it shows, and a refresh re-reads the list', async ({ page }) => {
  const state = await stubGateway(page);
  await page.goto('/dashboard/keys');
  await expect(page.getByRole('switch', { name: 'Require API key' })).toHaveAttribute('aria-checked', 'true');

  await page.getByRole('switch', { name: 'Require API key' }).click();
  await expect.poll(() => state.calls).toContain('PUT require-api-key false');
  await expect(page.getByRole('switch', { name: 'Require API key' })).toHaveAttribute('aria-checked', 'false');

  const before = state.calls.filter((call) => call === 'GET keys').length;
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect.poll(() => state.calls.filter((call) => call === 'GET keys').length).toBeGreaterThan(before);
});

test('copy says it copied only when the clipboard write succeeded', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await stubGateway(page);
  await page.goto('/dashboard/keys');
  const copy = page.getByRole('button', { name: 'Copy Header' });
  await copy.click();
  // The label flips only after the write resolves — a button that says "copied" regardless was the defect this
  // component was written to avoid.
  await expect(page.getByRole('button', { name: 'Header copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Authorization: Bearer <key>');
});
