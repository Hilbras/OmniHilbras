import assert from 'node:assert/strict';
import test from 'node:test';
import { isBillableRoute } from '../dist/src/core/route-policy.js';

test('every paid or outbound POST is billable', () => {
  for (const path of [
    '/v1/chat/completions', '/v1/responses', '/v1/messages', '/v1/embeddings',
    '/v1/images/generations', '/v1/audio/speech', '/v1/audio/transcriptions',
    '/v1/systemone', '/v1/fetch', '/v1/search',
    '/v1/videos/generations', '/v1/videos/edits', '/v1/videos/extensions',
  ]) {
    assert.equal(isBillableRoute('POST', path), true, `${path} escaped the billable ceiling`);
  }
});

test('discovery, estimates and video polls are not billed as requests', () => {
  assert.equal(isBillableRoute('GET', '/v1/models'), false);
  assert.equal(isBillableRoute('POST', '/v1/messages/count_tokens'), false);
  assert.equal(isBillableRoute('GET', '/v1/videos/job-1'), false);
  assert.equal(isBillableRoute('POST', '/v1/connections'), false);
});