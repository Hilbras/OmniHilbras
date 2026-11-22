import { expect, test, type Page } from '@playwright/test';

/**
 * The two update questions, driven through the real dashboard with a fake desktop bridge.
 *
 * Source guards can prove the dialogs exist; only a rendered test proves that a detected update actually
 * asks, that accepting starts the right IPC call, and that declining leaves the badge in place. Nothing
 * here downloads or installs a real release: the bridge records calls and the test pushes states.
 */

async function installFakeDesktop(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    const calls: unknown[][] = [];
    const listeners: Array<(state: unknown) => void> = [];
    let state: Record<string, unknown> = {
      status: 'available', version: '99.0.0', canInstall: true, signed: false,
      trustReason: 'No release-signing key is configured.', installMethod: 'auto',
    };
    const push = (next: Record<string, unknown>) => {
      state = next;
      for (const listener of [...listeners]) listener(next);
    };
    w.__omniCalls = calls;
    w.__pushUpdate = push;
    w.omnihilbras = {
      desktop: true,
      platform: 'linux',
      smokeMode: true,
      appInfo: async () => ({ version: '3.92.2', platform: 'linux' }),
      updates: {
        getState: async () => state,
        check: async () => state,
        download: async () => { calls.push(['download']); return state; },
        install: async (options: unknown) => { calls.push(['install', options]); },
        openRelease: async () => undefined,
        onState: (callback: (state: unknown) => void) => {
          listeners.push(callback);
          return () => { const at = listeners.indexOf(callback); if (at >= 0) listeners.splice(at, 1); };
        },
      },
      settings: { get: async () => ({ gatewayPort: 20138, gatewayPortConfigured: 20138, dashboardPort: 20137, dashboardPortConfigured: 20137, startAtLogin: false, checkUpdatesOnLaunch: false }), set: async (patch: unknown) => patch },
      server: {
        getState: async () => ({ status: 'stopped', reason: 'test' }),
        start: async () => ({ status: 'running' }),
        stop: async () => ({ status: 'stopped' }),
        restart: async () => ({ status: 'running' }),
        onState: () => () => undefined,
        onLog: () => () => undefined,
      },
      windowControls: {
        isMaximized: async () => false,
        onMaximized: () => () => undefined,
        minimize: async () => undefined,
        toggleMaximize: async () => undefined,
        close: async () => undefined,
      },
      gateway: {
        request: async () => ({ ok: true, status: 200, text: '{"build":{"version":"test"}}' }),
        streamChat: () => () => undefined,
        onLog: () => () => undefined,
        onLogState: () => () => undefined,
      },
    };
  });
}

async function stubStreams(page: Page) {
  await page.route('**/v1/**', (route) => route.fulfill({
    json: { object: 'list', data: [], models: [], connections: [], keys: [], routing: [], usage: [] },
  }));
  await page.route('**/v1/logs/stream*', (route) => route.fulfill({
    status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, body: '',
  }));
  await page.route('**/v1/events*', (route) => route.fulfill({
    status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, body: '',
  }));
}

test('a found update asks to download, and a finished download asks to install', async ({ page }) => {
  await installFakeDesktop(page);
  await stubStreams(page);
  await page.goto('/dashboard');

  const downloadDialog = page.getByRole('dialog', { name: 'Update available' });
  await expect(downloadDialog).toBeVisible();
  await expect(downloadDialog).toContainText('Version 99.0.0 is available');
  await downloadDialog.getByRole('button', { name: 'Download' }).click();
  await expect.poll(async () => page.evaluate(() => (window as unknown as { __omniCalls: unknown[][] }).__omniCalls.length)).toBe(1);

  await page.evaluate(() => (window as unknown as { __pushUpdate: (state: unknown) => void }).__pushUpdate({
    status: 'downloaded', version: '99.0.0', canInstall: true, signed: false,
    trustReason: 'No release-signing key is configured.', installMethod: 'auto',
  }));
  const installDialog = page.getByRole('dialog', { name: 'Update downloaded' });
  await expect(installDialog).toBeVisible();
  await expect(installDialog).toContainText('No release-signing key is configured.');
  await installDialog.getByRole('button', { name: 'Install and restart' }).click();

  await expect.poll(async () => page.evaluate(() => (window as unknown as { __omniCalls: unknown[][] }).__omniCalls)).toEqual([
    ['download'], ['install', { allowUnsigned: true }],
  ]);
});

test('declining a question starts nothing and leaves the badge for later', async ({ page }) => {
  await installFakeDesktop(page);
  await stubStreams(page);
  await page.goto('/dashboard');

  const dialog = page.getByRole('dialog', { name: 'Update available' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Not now' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('New version: v99.0.0')).toBeVisible();

  // The automatic question does not reopen on the same state, but the badge can ask again.
  await page.evaluate(() => (window as unknown as { __pushUpdate: (state: unknown) => void }).__pushUpdate({
    status: 'available', version: '99.0.0', canInstall: true, signed: false,
    trustReason: 'No release-signing key is configured.', installMethod: 'auto',
  }));
  await expect(page.getByRole('dialog', { name: 'Update available' })).toBeHidden();
  await page.getByRole('button', { name: 'Update now' }).click();
  const popup = page.getByRole('dialog', { name: /Update OmniHilbras/ });
  await expect(popup).toBeVisible();
  await popup.getByRole('button', { name: 'Download' }).click();
  await expect(page.getByRole('dialog', { name: 'Update available' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __omniCalls: unknown[][] }).__omniCalls)).toEqual([]);
});
