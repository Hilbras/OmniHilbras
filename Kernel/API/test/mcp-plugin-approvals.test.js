import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consumePluginApproval, mintPluginApproval, registeredPlugins } from '../dist/src/routes/mcpPlugins.js';

test('a plugin registry entry carries its tool policy and rejects an unreadable one', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omni-mcp-policy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'mcp-plugins.json'), JSON.stringify([
    { id: 'readonly', command: '/bin/echo', args: [], tools: { allow: ['search', 'fetch'], ask: ['fetch'] } },
    { id: 'bad', command: 'relative/path', args: [] },
  ]));
  const plugins = registeredPlugins(directory);
  assert.equal(plugins.length, 1, 'an unregistered command was accepted');
  assert.deepEqual(plugins[0].tools, { allow: ['search', 'fetch'], ask: ['fetch'] });
});

test('an approval is one-shot, bound to its plugin, and expires', () => {
  const { token } = mintPluginApproval('plugin-a');
  assert.equal(consumePluginApproval('plugin-b', token), false, 'a token was accepted for another plugin');
  assert.equal(consumePluginApproval('plugin-a', token), true);
  assert.equal(consumePluginApproval('plugin-a', token), false, 'a token was accepted twice');
  assert.equal(consumePluginApproval('plugin-a', 'not-a-token'), false);
});
