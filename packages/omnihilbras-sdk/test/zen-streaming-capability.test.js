import assert from 'node:assert/strict';
import test from 'node:test';
import { ZenAdapter } from '../dist/index.js';

/**
 * Zen declared `streaming: false` while its adapter streams the chat lane and the free tier. The gateway reads
 * that flag before calling the adapter, so every streamed request was refused with NOT_SUPPORTED, even though
 * the adapter could answer it. The flag must describe what the adapter does.
 */
test('the Zen adapter declares streaming, because it streams the chat lane and the free tier', () => {
  assert.equal(new ZenAdapter({}).capabilities.streaming, true);
});
