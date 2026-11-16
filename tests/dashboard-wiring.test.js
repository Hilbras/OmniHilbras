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

test('Reconnect repairs the row it was clicked on instead of adding a second account', () => {
  // Reported from the field: "when I click on the account reconnect and log in with the same email it adds a
  // new one". The row's Reconnect called `openAddConnection` — the Add path, which sets `addAccount` whenever
  // the provider already holds an account — and an OAuth row renders no Edit button, so Reconnect was the only
  // repair path a signed-in account had and it was wired to the one action that duplicates it.
  const page = read('src/pages/ProviderDetailPage.tsx');
  assert.match(page, /onReconnect=\{[^\n]*reconnectAccount\(item\)/, 'the row does not reconnect its own account');
  const start = page.indexOf('function reconnectAccount(');
  assert.notEqual(start, -1, 'reconnectAccount is gone');
  const handler = page.slice(start, page.indexOf('function openEditConnection(', start));
  assert.match(handler, /openEditConnection\(row\)/, 'reconnecting does not target the row it was clicked on');
  assert.doesNotMatch(handler, /beginOauthConnection\(/, 'reconnecting still starts the add-account flow');
});

test('a sign-in start names the row it repairs, for every flow the dialog offers', () => {
  // The same duplicate, one layer down: a start request that drops the target lets the gateway mint a fresh id
  // beside the account the row shows. ZCode and Kiro were the two the dialog never told.
  const dialog = read('src/components/OauthConnectDialog.tsx');
  for (const call of ['startClaudeCodeSignIn', 'startCodexSignIn']) {
    assert.match(dialog, new RegExp(`${call}\\(addAccount, undefined, targetConnectionId\\)`), `${call} does not name the row`);
  }
  assert.match(dialog, /startGatewayDeviceSignIn\(providerId, addAccount, undefined, targetConnectionId\)/, 'the device-flow start does not name the row');
  assert.match(dialog, /startKiroSignIn\(addAccount, undefined, targetConnectionId\)/, 'the Kiro start does not name the row');
  assert.match(dialog, /startZcodeSignIn\('zai', undefined, addAccount, targetConnectionId\)/, 'the ZCode start does not name the row');
  const client = read('src/lib/gatewayClient.ts');
  assert.match(client, /startZcodeSignIn\(provider: 'zai' \| 'bigmodel' = 'zai', signal\?: AbortSignal, addAccount = false, connectionId\?: string\)/, 'the ZCode client cannot send a target');
  assert.match(client, /startKiroSignIn\(addAccount\?: boolean, signal\?: AbortSignal, connectionId\?: string\)/, 'the Kiro client cannot send a target');
});

test('Update models re-reads the list the page renders, not only the account it refreshed', () => {
  // Measured in a browser before this guard existed: with the store one model ahead of the open page, the
  // click toasted "Updated Coarena models — 20 available." while the Models stat stayed at 19. The page
  // renders the union over every account of the provider (`importedModels`), and the click was setting only
  // the singular `connection`, so the request succeeded, the store changed, and the screen did not — which is
  // a button a user correctly calls broken. `addModel` in the same file already re-reads the list after its
  // write; this asserts the refresh does too.
  const page = read('src/pages/ProviderDetailPage.tsx');
  const start = page.indexOf('async function refreshModels()');
  assert.notEqual(start, -1, 'refreshModels is gone');
  const body = page.slice(start, page.indexOf('async function toggleConnectionEnabled', start));
  assert.match(body, /refreshGatewayConnectionModels\(connection\.id\)/, 'the button does not ask the provider');
  assert.match(body, /await loadConnection\(\)/, 'the refresh does not re-read the list the page renders');
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
  // The wording changed in 3.58.0: the payload now carries every store, not only the connections, and the
  // guard is written against what the page must *say* — that the import replaces what the file carries and
  // cannot be undone — rather than against one sentence that a rewrite of that sentence would break.
  assert.match(about, /Import replaces every store the file carries/, 'import does not warn that it replaces data');
  assert.match(about, /no merge and no undo/, 'import does not say the replacement cannot be undone');
  assert.match(about, /bridge\.diagnostics\.export/, 'the desktop diagnostics action is missing');
});

test('page changes replay the entrance without remounting the page', () => {
  const app = read('src/dashboardApp.tsx');
  assert.match(app, /function PageTransition/, 'the route wrapper does not animate');
  assert.match(app, /node\.classList\.remove\('page-enter'\)/, 'the animation is not restarted on navigation');
  assert.match(app, /\[location\.pathname\]/, 'the animation does not depend on the path');
  assert.doesNotMatch(app, /key=\{location\.pathname\}/, 'the remount key is back');
});

test('every write announces JSON, which the gateway requires before any route', () => {
  /**
   * Measured against the running gateway, because this was a real 415 rather than a theory:
   *
   *     POST /v1/runtime/opencode/start                      -> 415 UNSUPPORTED_MEDIA_TYPE
   *     POST /v1/runtime/opencode/start + JSON + body '{}'   -> 200
   *
   * The browser's Start and Install buttons on a provider page were sending no content-type, and the desktop
   * bridge had the same gap; one caller had already worked around it by hand. The rule lives in one place per
   * surface now, so a body-less write added later cannot rediscover it.
   */
  const client = read('src/lib/gatewayClient.ts');
  const bridge = read('desktop/gateway-ipc.mjs');
  assert.match(client, /const write = method === 'POST' \|\| method === 'PUT' \|\| method === 'PATCH'/, 'the client knows which methods are writes');
  assert.match(client, /init\.body \?\? '\{\}'/, "and gives a write a JSON body even when it has nothing to send");
  assert.match(client, /content-type': 'application\/json'/, 'and the header, in the fetch path');
  assert.match(bridge, /const write = upper === 'POST' \|\| upper === 'PUT' \|\| upper === 'PATCH'/, 'the bridge applies the same rule');
});

test('updates can be downloaded and installed from the UI', () => {
  const main = read('desktop/main.mjs');
  const preload = read('desktop/preload.cjs');
  const banner = read('src/components/UpdateIndicator.tsx');
  const settings = read('src/pages/SettingsPage.tsx');
  assert.match(main, /downloadUpdate/, 'main has no download action');
  assert.match(main, /quitAndInstall/, 'main has no install action');
  assert.match(main, /update:state/, 'update progress is not streamed');
  assert.match(preload, /updates:/, 'the bridge exposes no update API');
  assert.match(banner, /Install and restart/, 'the banner cannot install');
  assert.match(settings, /updateAction\('download'\)|updates\.download/, 'Settings cannot download');
});

test('the stale-build hint names the side that is actually behind', () => {
  const shell = read('src/components/DashboardShell.tsx');
  /**
   * The hint said "restart the gateway" for every version mismatch, and the common mismatch in development is
   * the other way round: `pnpm dev` reads `package.json` once at startup, so after a bump the page reports the
   * old version while the gateway is current. Measured today — gateway 3.56.0, page 3.54.0, gateway already
   * right — and following the old advice restarted the correct process and changed nothing.
   */
  assert.match(shell, /const pageBehind = staleBuild && compareVersions\(PAGE_VERSION, buildVersion as string\) < 0/, 'the page compares its own version against the gateway\'s');
  assert.match(shell, /restart \\`pnpm dev\\`/, 'a page that is behind says to restart the dev server');
  assert.match(shell, /this page is \$\{PAGE_VERSION\}, the gateway is \$\{buildVersion\}/, 'and says which is which, with numbers');
  assert.match(shell, /the gateway is \$\{buildVersion\}, this page is \$\{PAGE_VERSION\} · restart the gateway/, 'a gateway that is behind still says to restart the gateway');
});

test('a start that lands nothing is reported, not swallowed', () => {
  const page = read('src/pages/ProviderDetailPage.tsx');
  // The call returns the current status, so an unsuccessful start used to set exactly the state the badge was
  // already showing — "installed, not running" before the click and after it, with no error. Measured on a
  // machine whose port was held: HTTP 200, `serviceRunning: false`, nothing on screen.
  assert.match(page, /if \(action === 'start' && next\.serviceRunning !== true\)/, 'an unsuccessful start is detected');
  assert.match(page, /next\.message \?\? 'The gateway did not report a running service/, "and says the gateway's reason, or that there is none");
  assert.match(page, /\{status\?\.message && !error &&/, 'the conflict the gateway reports is shown in the panel');
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

test('the Token Saver page is wired to the stats route', () => {
  const app = read('src/dashboardApp.tsx');
  const shell = read('src/components/DashboardShell.tsx');
  const page = read('src/pages/TokenSaverPage.tsx');
  assert.match(app, /path="\/token-saver"/, 'no Token Saver route');
  assert.match(shell, /to: '\/token-saver'/, 'no Token Saver nav entry');
  assert.match(page, /getGatewayTokenSaverStats/, 'the page does not read the stats route');
  assert.match(page, /requestsWithSavings/, 'the page does not distinguish savings from telemetry');
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
