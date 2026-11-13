import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The runtime card must report the gateway, not the button it just pressed.
 *
 * `opencode-console`'s free models are served only through OpenCode's own server, so a device that has
 * never seen OpenCode has a real, invisible reason for a free model refusing. The fix is a card that
 * installs it — and the failure mode of such a card is a UI that says "installed" because a click
 * happened. These assertions are about that difference: the page reads the gateway's answer before and
 * after, and a failure shows the gateway's words.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const client = readFileSync(join(root, 'src', 'lib', 'gatewayClient.ts'), 'utf8');
const page = readFileSync(join(root, 'src', 'pages', 'ProviderDetailPage.tsx'), 'utf8');

/** Just the card: from its declaration to the next top-level function, so a neighbour cannot answer for it. */
const cardStart = page.indexOf('function OpencodeRuntimeCard');
const cardEnd = page.indexOf('\nfunction ', cardStart + 10);
const card = page.slice(cardStart, cardEnd === -1 ? undefined : cardEnd);

test('the three runtime calls exist and point at the routes the gateway serves', () => {
  assert.match(client, /requestJson<GatewayOpencodeRuntime>\('\/v1\/runtime\/opencode'/, 'status is read from the gateway');
  assert.match(client, /requestJson<GatewayOpencodeRuntime>\('\/v1\/runtime\/opencode\/install', \{ method: 'POST'/, 'install is a POST');
  assert.match(client, /requestJson<GatewayOpencodeRuntime>\('\/v1\/runtime\/opencode\/start', \{ method: 'POST'/, 'start is a POST');
});

test('the card is shown for the provider that needs it, and shows what the gateway said', () => {
  assert.match(page, /provider\.id === 'opencode-console' && <OpencodeRuntimeCard \/>/, 'the card belongs to the provider whose free tier needs the runtime');

  // Status is read on mount and re-read after an action, so the card cannot report a state nothing
  // observed. Removing either call leaves the UI asserting its own optimism.
  assert.match(card, /await getOpencodeRuntime\(\)/, 'the card reads the real status');
  assert.match(card, /setStatus\(action === 'install' \? await installOpencodeRuntime\(\) : await startOpencodeRuntime\(\)\)/, 'the card shows the gateway\'s answer to the action, not a guess');
  assert.match(card, /await load\(\)/, 'a failed action re-reads the status instead of leaving a stale one');
  assert.match(card, /setError\(problem instanceof Error \? problem\.message/, 'the gateway\'s message is what the operator reads');

  // A success state set inside a timer is the project's named lie; `dashboard-truthfulness` bans it
  // everywhere, and this repeats it for the one card most tempted to fake progress.
  assert.doesNotMatch(card, /setTimeout/, 'no timer may stand in for a real result');
});

test('the card does not promise more than the gateway does', () => {
  // The honest limits: the download is the official release, the hash is recorded rather than verified
  // against upstream, and nothing starts automatically unless the operator said so.
  assert.match(card, /official release for this platform/);
  assert.match(card, /records the artifact&rsquo;s SHA-256|records the artifact's SHA-256/);
  assert.match(card, /OMNIHILBRAS_OPENCODE_SERVICE/);
});
