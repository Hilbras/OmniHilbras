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
