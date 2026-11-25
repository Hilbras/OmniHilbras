import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLAUDE_DECOY_TOOL_NAMES, CLAUDE_TOOL_SUFFIX, DECOY_CALL_NAME,
  cloakClaudeTools, restoreClaudeToolName, shouldCloakTools,
} from '../dist/index.js';

/**
 * The Claude tool cloak, on its own.
 *
 * The decision this package owns is the rename/restore pair: client names on the wire are never the names the
 * client declared, and nothing that comes back is allowed to bypass the gateway's declared-tool allow list.
 * A decoy is a declaration only — no shell and no write tool is part of this surface.
 */

const tool = (name) => ({ name, description: `${name} tool`, parameters: { type: 'object', properties: {} } });
const requestFor = () => ({
  model: 'm',
  tools: [tool('lookup'), tool('search')],
  messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
  ],
});

test('the cloak is deterministic and renames only client tools', () => {
  const first = cloakClaudeTools(requestFor());
  const second = cloakClaudeTools(requestFor());
  assert.deepEqual(first.request, second.request, 'the same declarations must produce the same wire names');
  assert.deepEqual([...first.renames], [...second.renames], 'the restore map must be stable too');

  const names = first.request.tools.map((entry) => entry.name);
  assert.deepEqual(names.slice(0, 2), [`lookup${CLAUDE_TOOL_SUFFIX}`, `search${CLAUDE_TOOL_SUFFIX}`]);
  assert.equal(names.includes('lookup'), false, 'an unsuffixed client name reached the provider');
  for (const name of CLAUDE_DECOY_TOOL_NAMES) {
    assert.equal(names.includes(name), true, `the ${name} decoy is missing`);
  }
  // No shell and no write tool, even as an unavailable decoy.
  for (const forbidden of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'bash', 'shell']) {
    assert.equal(names.some((name) => name.toLowerCase() === forbidden.toLowerCase()), false, `${forbidden} is a tool on the wire`);
  }
  for (const decoy of first.request.tools.slice(2)) {
    assert.match(decoy.description, /unavailable/);
    assert.deepEqual(decoy.parameters, { type: 'object', properties: {}, additionalProperties: false });
  }
});

test('the restore map names exactly the client tools, and blocks decoys', () => {
  const { renames } = cloakClaudeTools(requestFor());
  const declared = new Set(['lookup', 'search']);
  assert.equal(renames.get(`lookup${CLAUDE_TOOL_SUFFIX}`), 'lookup');
  assert.equal(renames.get(`search${CLAUDE_TOOL_SUFFIX}`), 'search');
  assert.equal(renames.get('Task'), DECOY_CALL_NAME, 'a decoy call must not restore to a declared name');
  assert.equal(restoreClaudeToolName('Task', renames, declared), DECOY_CALL_NAME);
  assert.equal(restoreClaudeToolName('lookup_ide_lost_map', renames, declared), 'lookup_ide_lost_map');

  // A decoy whose name the client itself declared is skipped, so a call to it cannot be confused with
  // the client's own tool of the same name.
  const overlapping = cloakClaudeTools({ tools: [tool('Task')] });
  const overlappingNames = overlapping.request.tools.map((entry) => entry.name);
  assert.equal(overlappingNames[0], `Task${CLAUDE_TOOL_SUFFIX}`, 'the client tool is still cloaked');
  assert.equal(overlappingNames.includes('Task'), false, 'the colliding decoy was not skipped');
  assert.equal(overlappingNames.includes('Glob'), true, 'unrelated decoys remain');
  assert.equal(overlapping.renames.has('Task'), false, 'no decoy sentinel was added for the colliding name');
});

test('the suffix-stripping fallback only restores names the client declared', () => {
  const declared = new Set(['lookup']);
  const renames = new Map();
  assert.equal(restoreClaudeToolName('lookup_ide', renames, declared), 'lookup');
  assert.equal(restoreClaudeToolName('other_ide', renames, declared), 'other_ide');
  assert.equal(restoreClaudeToolName('lookup_ide', renames, new Set(['lookup_ide'])), 'lookup_ide', 'a real client name ending in the suffix is not rewritten');
});

test('message history and a named forced choice follow the rename', () => {
  const { request } = cloakClaudeTools({
    tools: [tool('lookup')],
    messages: [{ role: 'assistant', content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }],
    toolChoice: { type: 'tool', name: 'lookup' },
  });
  assert.equal(request.messages[0].toolCalls[0].function.name, `lookup${CLAUDE_TOOL_SUFFIX}`);
  assert.equal(request.toolChoice.name, `lookup${CLAUDE_TOOL_SUFFIX}`);

  const decoyChoice = cloakClaudeTools({ tools: [tool('lookup')], toolChoice: { type: 'tool', name: 'Task' } });
  assert.equal(decoyChoice.request.toolChoice.name, 'Task', 'a decoy is never the subject of a forced call');
});

test('a request without tools is returned untouched', () => {
  const request = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
  const result = cloakClaudeTools(request);
  assert.deepEqual(result.request, request);
  assert.equal(result.renames.size, 0);
});

test('a client declaring foo and foo_ide gets two distinct wire names', () => {
  const result = cloakClaudeTools({ tools: [tool('foo'), tool('foo_ide')] });
  const names = result.request.tools.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length, 'two client tools were sent under one wire name');
  for (const name of ['foo', 'foo_ide']) {
    const wire = result.request.tools.find((entry) => result.renames.get(entry.name) === name)?.name;
    assert.ok(wire, `${name} has no restore mapping`);
    assert.equal(restoreClaudeToolName(wire, result.renames, new Set(['foo', 'foo_ide'])), name);
  }
});

test('only Claude connections get the cloak', () => {
  assert.equal(shouldCloakTools('anthropic'), true);
  assert.equal(shouldCloakTools('claude-code'), true);
  assert.equal(shouldCloakTools('claude'), true);
  assert.equal(shouldCloakTools('openai'), false);
  assert.equal(shouldCloakTools('openai', { providerId: 'anthropic' }), true);
  assert.equal(shouldCloakTools('openai', { providers: ['claude-code'] }), true);
  assert.equal(shouldCloakTools('openai', { providerId: 'openai', providers: ['openai'] }), false);
});
