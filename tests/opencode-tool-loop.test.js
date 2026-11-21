import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { gatewayToolNameMap, guardToolStream, validateToolCalls, withGatewayTools } from '../Kernel/Tools/dist/index.js';
import { toolCaps } from '../Kernel/Tools/dist/index.js';

/**
 * The silent mid-task halt was a tool loop broken in four places. These tests pin the first three:
 * folded names still map back to what the caller declared, gated history keeps assistant calls, and
 * OpenCode's capability rows no longer promise a forced choice its free tier refuses.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = (path) => readFileSync(join(root, path), 'utf8');

test('a folded tool name is accepted and restored to the caller\'s spelling', async () => {
  const tools = [
    { name: 'Read', parameters: { type: 'object', properties: {} } },
    { name: 'Glob', parameters: { type: 'object', properties: {} } },
  ];
  const wire = withGatewayTools(tools);
  const renames = gatewayToolNameMap(tools);
  assert.deepEqual(wire.map((tool) => tool.name), ['read', 'glob', 'grep']);
  assert.deepEqual([...renames], [['read', 'Read'], ['glob', 'Glob']]);
  const declared = [...tools.map((tool) => tool.name), ...renames.keys()];
  const { calls, issues } = validateToolCalls(
    [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }], declared,
  );
  assert.equal(issues.length, 0, 'the call is not dropped as undeclared');
  assert.equal(calls.length, 1);

  async function* chunks() {
    yield { delta: { toolCalls: [{ index: 0, function: { name: 'read', arguments: '{}' } }] } };
  }
  const output = [];
  for await (const chunk of guardToolStream(chunks(), declared, { allowed: [], blocked: [] }, renames)) output.push(chunk);
  assert.equal(output[0].delta.toolCalls[0].function.name, 'Read', 'the agent sees its own tool name');
});

test('a non-OpenCode tool folded to lowercase by a provider is still restored', async () => {
  // The rename map must not be limited to the three gateway-injected names: any provider may lowercase a tool name.
  const tools = [
    { name: 'Bash', parameters: { type: 'object', properties: {} } },
    { name: 'WebSearch', parameters: { type: 'object', properties: {} } },
  ];
  const renames = gatewayToolNameMap(tools);
  assert.deepEqual([...renames], [['bash', 'Bash'], ['websearch', 'WebSearch']]);
  const declared = [...tools.map((tool) => tool.name), ...renames.keys()];
  const { calls, issues } = validateToolCalls(
    [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }], declared,
  );
  assert.equal(issues.length, 0, 'the lowercase call is not dropped as undeclared');
  assert.equal(calls.length, 1);

  async function* chunks() {
    yield { delta: { toolCalls: [{ index: 0, function: { name: 'bash', arguments: '{}' } }] } };
  }
  const output = [];
  for await (const chunk of guardToolStream(chunks(), declared, { allowed: [], blocked: [] }, renames)) output.push(chunk);
  assert.equal(output[0].delta.toolCalls[0].function.name, 'Bash', 'the agent sees its own tool name');
});

test('a casing collision between two declared tools is left alone', () => {
  const renames = gatewayToolNameMap([
    { name: 'Read' }, { name: 'read' },
  ]);
  assert.equal(renames.size, 0, 'the gateway cannot guess which tool a folded call meant');
});

test('OpenCode free-tier lanes no longer promise forced tool calls', () => {
  for (const id of ['opencode', 'opencode-go', 'opencode-console']) {
    assert.deepEqual(toolCaps(id).toolChoice, ['auto', 'none'], `${id} must not claim forcing`);
  }
});

test('gated history replays assistant tool calls in Zen, Go and the Console free lane', () => {
  for (const file of [
    'Kernel/SDK/opencode-zen/adapter/index.ts',
    'Kernel/SDK/opencode-go/adapter/index.ts',
    'Kernel/SDK/opencode-console/adapter/index.ts',
  ]) {
    const text = source(file);
    assert.match(text, /tool_calls: message\.toolCalls\.map|tool_calls: message\.toolCalls\?\.map|\.\.\.\(message\.toolCalls\?\.length \? \{ tool_calls:/,
      `${file} still drops assistant tool calls from replayed history`);
  }
});

test('an agent tool turn uses the native free lane, not the flattened local bridge', () => {
  const consoleAdapter = source('Kernel/SDK/opencode-console/adapter/index.ts');
  assert.match(consoleAdapter, /if \(request\.tools\?\.length\) return undefined/, 'chat does not flatten a tool turn');
  assert.match(consoleAdapter, /const service = request\.tools\?\.length \? undefined : this\.localService/, 'stream does not flatten a tool turn');
});
