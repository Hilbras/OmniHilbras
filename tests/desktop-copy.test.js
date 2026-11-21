import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The desktop shell is the only surface where "copy" silently did nothing: an `app://` page cannot rely on
 * navigator.clipboard, and the same page printed the development gateway port because nothing set the
 * production global. Both facts now come from the main process before the dashboard evaluates.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'desktop/main.mjs'), 'utf8');
const preload = readFileSync(join(root, 'desktop/preload.cjs'), 'utf8');
const bridge = readFileSync(join(root, 'src/lib/electronBridge.ts'), 'utf8');

test('the preload publishes the real gateway URL before page scripts run', () => {
  assert.match(preload, /ipcRenderer\.sendSync\('gateway:port'\)/, 'the port is read synchronously, before modules evaluate');
  assert.match(preload, /exposeInMainWorld\('__OMNIHILBRAS_GATEWAY_URL__', `http:\/\/127\.0\.0\.1:\$\{gatewayPort\}`/, 'the URL is the one this app owns');
  assert.match(main, /ipcMain\.on\('gateway:port', \(event\) => \{ event\.returnValue = gateway\.port; \}\)/, 'main answers with the resolved port');
});

test('the clipboard is owned by the main process, with a bounded input', () => {
  assert.match(main, /clipboard\.writeText\(text\)/, 'the OS clipboard is written in main');
  assert.match(main, /if \(typeof text !== 'string' \|\| text\.length > 1_000_000\)/, 'a renderer cannot send arbitrary data to it');
  assert.match(preload, /writeText: \(text\) => ipcRenderer\.invoke\('clipboard:write', text\)/, 'the preload forwards only the text');
  assert.match(bridge, /clipboard: \{ writeText: \(text: string\) => Promise<boolean> \}/, 'the renderer types know the operation exists');
});

test('every copy surface uses the shared helper', () => {
  const files = [
    'src/App.tsx', 'src/pages/ApiKeysPage.tsx', 'src/pages/AppHomePage.tsx',
    'src/pages/SettingsPage.tsx', 'src/pages/ProviderDetailPage.tsx',
    'src/components/UpdateIndicator.tsx', 'src/components/WebCookieConnectDialog.tsx',
  ];
  for (const file of files) {
    const source = readFileSync(join(root, file), 'utf8');
    assert.match(source, /copyText\(/, `${file} still reaches for the clipboard directly`);
    // Comments quote the old code to explain why it was wrong; only executable lines matter here.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
    assert.doesNotMatch(code, /navigator\.clipboard/, `${file} still uses the browser-only clipboard`);
  }
});
