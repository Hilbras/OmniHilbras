import assert from 'node:assert/strict';
import test from 'node:test';
import { narrowedToolCaps } from '../dist/src/core/modelCapabilities.js';
import { modelMetaFor } from '../dist/src/core/connection-manager.js';

/**
 * A provider can serve tools while one of its models cannot. The catalog already stores that fact as
 * `modelMeta.cp.tools`; this is the lookup that consults it without inventing a second capability
 * table or letting a catalog claim widen a provider that has no function-calling surface.
 */

const row = { tools: true, toolChoice: ['auto', 'none', 'required'], web: false };
const connection = (meta, providerId = 'p') => ({ providerId, modelMeta: meta });

test('a full namespaced id is consulted before the stripped one', () => {
  const caps = narrowedToolCaps('ns/model', connection({ 'ns/model': { cp: { tools: false } } }), row);
  assert.equal(caps?.tools, false);
  assert.deepEqual(caps?.toolChoice, []);
});

test('a namespaced id falls back to the bare id of its own provider', () => {
  const caps = narrowedToolCaps('ns/model', connection({ model: { cp: { tools: false } } }, 'ns'), row);
  assert.equal(caps?.tools, false);
});

test('a catalog that claims tools cannot widen the provider row', () => {
  assert.equal(narrowedToolCaps('model', connection({ model: { cp: { tools: true } } }), row), undefined);
});

test('a provider without tools stays without tools whatever the catalog says', () => {
  assert.equal(narrowedToolCaps('model', connection({ model: { cp: { tools: true } } }), { ...row, tools: false }), undefined);
});

test('no metadata is the ordinary case and costs one lookup', () => {
  assert.equal(narrowedToolCaps('model', undefined, row), undefined);
  assert.equal(narrowedToolCaps('model', { providerId: 'p' }, row), undefined);
});


test('a catalog entry stating supports_tools:false reaches modelMeta and narrows the provider', () => {
  const models = [{
    id: 'vendor/no-tools', providerId: 'p', capabilities: { tools: false }, source: 'provider',
  }];
  const meta = modelMetaFor(models);
  assert.deepEqual(meta['vendor/no-tools'].cp, { tools: false });
  const caps = narrowedToolCaps('vendor/no-tools', connection(meta, 'p'), row);
  assert.equal(caps?.tools, false);
  assert.deepEqual(caps?.toolChoice, []);
});
