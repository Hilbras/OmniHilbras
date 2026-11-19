import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { renderMenu, statusHeader, selectMenu } from '../cli/lib/menu.mjs';

/**
 * The launcher's arrow-key menu and live header (3.76.0), with no dependencies and no real terminal.
 *
 * `renderMenu`/`statusHeader` are pure, so their output is asserted directly. `selectMenu` is driven with a
 * fake keypress stream: the Promise executor attaches its listeners synchronously, so emitting `keypress`
 * right after the call exercises the same path a real arrow key takes. The non-TTY fallback is driven by
 * writing a numbered answer.
 */

const items = [{ label: 'Open dashboard' }, { label: 'Restart' }, { label: 'Exit' }];

test('renderMenu highlights the selected line and marks the rest', () => {
  const colour = renderMenu({ title: 'T', items, selected: 1, colour: true });
  assert.match(colour, /\x1b\[7m\x1b\[1m ★ Restart /, 'the selected line is reverse-video + bold');
  assert.match(colour, /☆ Open dashboard/, 'the others are not highlighted');
  const plain = renderMenu({ title: 'T', items, selected: 1, colour: false });
  assert.match(plain, /> ★ Restart/, 'without colour the selection is marked with >');
  assert.doesNotMatch(plain, /\x1b\[7m/, 'and carries no reverse-video escape');
});

test('renderMenu includes the header above the title', () => {
  const frame = renderMenu({ title: 'T', items, selected: 0, header: 'STATUS LINE', colour: false });
  assert.ok(frame.indexOf('STATUS LINE') < frame.indexOf('T'), 'header precedes the title');
});

test('statusHeader reports the gateway truthfully, never inventing health', () => {
  const healthy = statusHeader({ dashboardUrl: 'http://localhost:20137/dashboard', gatewayUrl: 'http://127.0.0.1:20138', health: 'healthy', version: '3.76.0' });
  assert.match(healthy, /● healthy · 3\.76\.0/);
  assert.match(healthy, /http:\/\/localhost:20137\/dashboard/);
  const degraded = statusHeader({ dashboardUrl: 'd', gatewayUrl: 'g', health: 'degraded' });
  assert.match(degraded, /◐ degraded/);
  const down = statusHeader({ dashboardUrl: 'd', gatewayUrl: 'g' });
  assert.match(down, /○ unknown/, 'a gateway that did not answer is unknown, not healthy');
});

test('statusHeader puts an available update first, and omits it when up to date', () => {
  const withUpdate = statusHeader({ dashboardUrl: 'd', gatewayUrl: 'g', health: 'healthy', update: { updateAvailable: true, current: '3.78.1', latest: '3.79.0' } });
  const lines = withUpdate.split('\n');
  assert.match(lines[0], /Update\s+3\.78\.1 → 3\.79\.0/, 'the update notice is the first line');
  assert.match(lines[0], /omnihilbras update/, 'and names the opt-in command');
  const noUpdate = statusHeader({ dashboardUrl: 'd', gatewayUrl: 'g', health: 'healthy', update: { updateAvailable: false } });
  assert.doesNotMatch(noUpdate, /Update/, 'no update line when up to date');
  const none = statusHeader({ dashboardUrl: 'd', gatewayUrl: 'g' });
  assert.doesNotMatch(none, /Update/, 'no update line when the check failed open');
});

/** A TTY-like stream pair; selectMenu guards setRawMode, which a PassThrough does not have. */
function tty() {
  const input = new PassThrough();
  input.isTTY = true;
  const output = new PassThrough();
  output.resume();
  return { input, output };
}

test('selectMenu moves with the arrow keys and resolves the highlighted index', async () => {
  const { input, output } = tty();
  const pending = selectMenu({ items, input, output, colour: false });
  input.emit('keypress', '', { name: 'down' });
  input.emit('keypress', '', { name: 'down' });
  input.emit('keypress', '', { name: 'return' });
  assert.equal(await pending, 2);
});

test('selectMenu wraps around the top', async () => {
  const { input, output } = tty();
  const pending = selectMenu({ items, input, output, initial: 0, colour: false });
  input.emit('keypress', '', { name: 'up' });
  input.emit('keypress', '', { name: 'return' });
  assert.equal(await pending, 2, 'up from the first item wraps to the last');
});

test('escape and Ctrl-C resolve -1 (exit), not a choice', async () => {
  for (const key of [{ name: 'escape' }, { name: 'c', ctrl: true }]) {
    const { input, output } = tty();
    const pending = selectMenu({ items, input, output, colour: false });
    input.emit('keypress', '', key);
    assert.equal(await pending, -1);
  }
});

test('an abort signal cancels a pending menu', async () => {
  const { input, output } = tty();
  const controller = new AbortController();
  const pending = selectMenu({ items, input, output, colour: false, signal: controller.signal });
  controller.abort();
  assert.equal(await pending, -1);
});

test('off a TTY it falls back to a numbered prompt', async () => {
  const input = new PassThrough();
  input.isTTY = false;
  const output = new PassThrough();
  output.resume();
  const pending = selectMenu({ items, input, output });
  input.write('2\n');
  assert.equal(await pending, 1);
});
