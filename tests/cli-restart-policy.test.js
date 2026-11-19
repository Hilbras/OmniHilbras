import assert from 'node:assert/strict';
import test from 'node:test';

import { restartDecision, MAX_RESTARTS, RESTART_RESET_MS } from '../cli/lib/restart-policy.mjs';

/**
 * The bounded crash-restart decision (3.77.0). Pure, so the loop-vs-recover behaviour is asserted without
 * crashing a real server: a one-off crash is recovered, a process that stayed up earns a fresh budget, and a
 * crash loop is stopped rather than spun forever.
 */

test('a first crash is restarted', () => {
  assert.deepEqual(restartDecision({ restarts: 0, uptimeMs: 1000 }), { action: 'restart', restarts: 1 });
});

test('restarts are bounded at MAX_RESTARTS', () => {
  assert.deepEqual(restartDecision({ restarts: MAX_RESTARTS - 1, uptimeMs: 1000 }), { action: 'restart', restarts: MAX_RESTARTS });
  assert.deepEqual(restartDecision({ restarts: MAX_RESTARTS, uptimeMs: 1000 }), { action: 'stop', restarts: MAX_RESTARTS });
  assert.deepEqual(restartDecision({ restarts: MAX_RESTARTS + 5, uptimeMs: 1000 }), { action: 'stop', restarts: MAX_RESTARTS + 5 });
});

test('a process that stayed up past the reset window earns a fresh budget', () => {
  // Even after spending the whole budget, a long uptime resets it: this crash is treated as a new one.
  assert.deepEqual(restartDecision({ restarts: MAX_RESTARTS, uptimeMs: RESTART_RESET_MS }), { action: 'restart', restarts: 1 });
  assert.deepEqual(restartDecision({ restarts: MAX_RESTARTS, uptimeMs: RESTART_RESET_MS + 1 }), { action: 'restart', restarts: 1 });
});

test('just under the reset window does not reset the budget', () => {
  assert.deepEqual(restartDecision({ restarts: MAX_RESTARTS, uptimeMs: RESTART_RESET_MS - 1 }), { action: 'stop', restarts: MAX_RESTARTS });
});

test('the caps are overridable for a caller that wants a different policy', () => {
  assert.deepEqual(restartDecision({ restarts: 0, uptimeMs: 0, maxRestarts: 1 }), { action: 'restart', restarts: 1 });
  assert.deepEqual(restartDecision({ restarts: 1, uptimeMs: 0, maxRestarts: 1 }), { action: 'stop', restarts: 1 });
  assert.deepEqual(restartDecision({ restarts: 1, uptimeMs: 5000, maxRestarts: 1, resetMs: 5000 }), { action: 'restart', restarts: 1 });
});
