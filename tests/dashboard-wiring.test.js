import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Dashboard wiring that has no browser harness: each assertion is a property the fixed code must keep.
 *
 * These are source-level because the alternative is a live browser per claim. Every one of them was a
 * real defect found by tracing the rendered path to the gateway — a switch that wrote local state, a
 * save that spliced a duplicate card, a filter that relabelled every card above it.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

test('the provider switch writes enabled state through the gateway', () => {
  const page = read('src/pages/ProvidersPage.tsx');
  assert.match(page, /setGatewayConnectionEnabled\(connection\.id, enabled\)/, 'the switch still only changes local state');
  assert.doesNotMatch(page, /disabledProviderIds/, 'the old local-only disabled set is back');
});

test('bulk add mints a connection id per entry', () => {
  const page = read('src/pages/ProvidersPage.tsx');
  assert.match(page, /provider\.connectionId \?\? `\$\{provider\.providerId\.slice\(0, 40\)\}-\$\{crypto\.randomUUID/, 'bulk entries still overwrite one row');
  assert.match(page, /await load\(\)/, 'a save does not reload the gateway state');
});

test('OAuth-only cards do not open the API-key dialog', () => {
  const page = read('src/pages/ProvidersPage.tsx');
  assert.match(page, /card\?\.auth === 'OAuth'/, 'an OAuth card can still be sent to the key dialog');
});

test('editing a row follows the credential it actually holds', () => {
  const page = read('src/pages/ProviderDetailPage.tsx');
  assert.match(page, /const rowIsOauth = row\.credentialType === 'oauth'/, 'edit still branches on the card instead of the row');
  assert.match(page, /setApiKeyMode\(!rowIsOauth\)/);
});

test('the usage table filter cannot rewrite the cards above it', () => {
  const page = read('src/pages/UsagePage.tsx');
  assert.match(page, /const summaryRequest = getGatewayUsage/, 'there is no unfiltered summary request');
  assert.match(page, /const rowsRequest = getGatewayUsage/, 'there is no filtered rows request');
  assert.match(page, /const totals = summary\?\.totals/, 'totals still come from the filtered response');
});

test('the log stream uses the gateway URL outside development', () => {
  const client = read('src/lib/gatewayClient.ts');
  assert.match(client, /import\.meta\.env\.DEV \? '\/v1\/logs\/stream'/, 'the dev proxy path was lost');
  assert.match(client, /`\$\{gatewayBaseUrl\}\/v1\/logs\/stream`/, 'a build still asks the static host for a gateway stream');
});

test('the Servers route does not nest a second dashboard shell', () => {
  const app = read('src/dashboardApp.tsx');
  const home = read('src/pages/AppHomePage.tsx');
  assert.match(app, /<Route path="\/" element=\{<AppHomeContent \/>\}/, 'the root route still mounts a full page inside the shell');
  const content = home.slice(home.indexOf('export function AppHomeContent'), home.indexOf('export function AppHomePage'));
  assert.doesNotMatch(content, /DashboardShell/, 'AppHomeContent wraps its own DashboardShell');
});

test('the desktop window carries the brand icon', () => {
  const main = read('desktop/main.mjs');
  assert.match(main, /icon: join\(projectRoot, 'brand\/logo-512\.png'\)/, 'the window has no icon');
});

test('the Servers page offers first run, diagnostics, and a filtered feed', () => {
  const page = read('src/pages/AppHomePage.tsx');
  assert.match(page, /No provider connections yet/, 'an empty vault has no first-run guidance');
  assert.match(page, /diagnostics\.export/, 'there is no diagnostics export');
  assert.match(page, /feedFilter/, 'the request feed has no filter');
  assert.match(page, /feedPaused/, 'the request feed cannot be paused');
});

test('About exists in the web and desktop app, with encrypted backup actions', () => {
  const app = read('src/dashboardApp.tsx');
  const shell = read('src/components/DashboardShell.tsx');
  const about = read('src/pages/AboutPage.tsx');
  assert.match(app, /path="\/about"/, 'no About route');
  assert.match(shell, /to: '\/about'/, 'no About nav entry');
  assert.match(about, /exportGatewayBackup/, 'no backup export');
  assert.match(about, /importGatewayBackup/, 'no backup import');
  assert.match(about, /confirmReplace|replaces every connection/, 'import does not warn that it replaces data');
  assert.match(about, /bridge\.diagnostics\.export/, 'the desktop diagnostics action is missing');
});

test('page changes replay the entrance without remounting the page', () => {
  const app = read('src/dashboardApp.tsx');
  assert.match(app, /function PageTransition/, 'the route wrapper does not animate');
  assert.match(app, /node\.classList\.remove\('page-enter'\)/, 'the animation is not restarted on navigation');
  assert.match(app, /\[location\.pathname\]/, 'the animation does not depend on the path');
  assert.doesNotMatch(app, /key=\{location\.pathname\}/, 'the remount key is back');
});

test('updates can be downloaded and installed from the UI', () => {
  const main = read('desktop/main.mjs');
  const preload = read('desktop/preload.cjs');
  const banner = read('src/components/UpdateBanner.tsx');
  const settings = read('src/pages/SettingsPage.tsx');
  assert.match(main, /downloadUpdate/, 'main has no download action');
  assert.match(main, /quitAndInstall/, 'main has no install action');
  assert.match(main, /update:state/, 'update progress is not streamed');
  assert.match(preload, /updates:/, 'the bridge exposes no update API');
  assert.match(banner, /Install and restart/, 'the banner cannot install');
  assert.match(settings, /updateAction\('download'\)|updates\.download/, 'Settings cannot download');
});

test('Settings persists real desktop and gateway choices', () => {
  const page = read('src/pages/SettingsPage.tsx');
  assert.match(page, /bridge\.settings\.set/, 'desktop settings are not persisted');
  assert.match(page, /gatewayPort/, 'the gateway port is not editable');
  assert.match(page, /closeToTray/, 'close-to-tray is not configurable');
  assert.match(page, /autoStartGateway/, 'start-on-launch is not configurable');
  assert.match(page, /setGatewayRequireApiKey/, 'the API-key gate is not editable');
  assert.match(page, /reduce-motion/, 'reduced motion is not persisted');
});

test('backup export/import survives a real file and a wrapped envelope', () => {
  const about = read('src/pages/AboutPage.tsx');
  assert.match(about, /bridge\.backup\.save/, 'the desktop export does not use a save dialog');
  assert.match(about, /setTimeout\(\(\) => URL\.revokeObjectURL/, 'the browser download revokes its blob immediately');
  assert.match(about, /parsed\.backup \?\? parsed/, 'a wrapped export response is rejected');
  assert.match(about, /format !== 'omnihilbras-backup'/, 'the file is not checked before it is sent');
});

test('the logs route is highlighted and titled', () => {
  const app = read('src/dashboardApp.tsx');
  assert.match(app, /startsWith\('\/logs'\)/, 'the Logs route still falls through to Overview');
  assert.match(app, /logs: 'Request log'/);
});

test('a stopped playground turn is not replayed to the model', () => {
  const playground = read('src/components/ProviderPlayground.tsx');
  assert.match(playground, /!turn\.failed && !turn\.stopped/, 'a stopped turn is still in the next request history');
  assert.match(playground, /stopped: true/, 'stopping still overwrites the partial answer');
});
