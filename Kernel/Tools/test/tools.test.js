import assert from 'node:assert/strict';
import test from 'node:test';
import { GATEWAY_TOOL_NAMES, GATEWAY_TOOL_PROVIDERS, LOCAL_TOOL_PROMPT, MAX_SCHEMA_BYTES, PROVIDER_TOOLS, WEB_PROVIDERS, dedupeToolDefinitions, gatewayToolDefinitions, guardToolStream, localToolDefinitions, normalizeToolsRequest, parseNativeToolCall, parsePromptToolCall, repairArguments, toolCaps, validateToolCalls, withGatewayTools } from '../dist/index.js';

/**
 * The tool contract, on its own.
 *
 * These are the decisions the gateway delegates: which providers serve tools, what a forced call means where forcing
 * does not exist, which definitions are safe to forward, and which returned calls a client may run.
 */

const tool = (name, extra = {}) => ({ name, description: `${name} tool`, parameters: { type: 'object', properties: {} }, ...extra });

test('a web provider is a web provider, and serves no tools', () => {
  for (const id of WEB_PROVIDERS) {
    const caps = toolCaps(id);
    assert.equal(caps.web, true, `${id} is not marked as a web session`);
    assert.equal(caps.tools, false, `${id} claims to serve tools`);
    assert.deepEqual(caps.toolChoice, [], `${id} claims a tool_choice it cannot honour`);
  }
});

test('codex serves tools but cannot force them, so the table says so', () => {
  // The adapter carries flat Responses function definitions and replays tool rounds as function_call /
  // function_call_output items. Forced choice is the one shape it refuses by name before a request.
  assert.equal(toolCaps('codex').tools, true);
  assert.deepEqual(toolCaps('codex').toolChoice, ['auto', 'none']);
});

test('an unlisted provider is conservative and says it was a guess', () => {
  const caps = toolCaps('a-provider-that-does-not-exist');
  assert.equal(caps.assumed, true);
  assert.equal(caps.tools, true);
  assert.deepEqual(caps.toolChoice, ['auto', 'none'], 'an unknown provider must not be assumed to force a call');
});

test('a request with no tools is returned untouched', () => {
  const request = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
  const { request: out, notes } = normalizeToolsRequest(request, 'openai');
  assert.equal(out, request, 'the request was rebuilt when there was nothing to do');
  assert.equal(notes.stripped, false);
});

test('tool_choice: none removes the definitions, whatever the adapter would do', () => {
  const { request, notes } = normalizeToolsRequest({ tools: [tool('read')], toolChoice: 'none' }, 'openai');
  assert.equal(request.tools, undefined);
  assert.equal(request.toolChoice, 'none');
  assert.equal(notes.enforcedNone, true);
});

test('tools for a web provider are stripped and reported', () => {
  const { request, notes } = normalizeToolsRequest({ tools: [tool('bash')] }, 'qwen-web');
  assert.equal(request.tools, undefined, 'a web provider must not receive a schema it will ignore');
  assert.equal(notes.stripped, true, 'the removal was not reported, which is the silent drop this replaces');
});

test('a forced call is refused by name where it cannot be honoured', () => {
  // `kiro` serves tools and has no way to force one. Anthropic used to be the example here until the behavioural guard
  // showed it had been mapping `required` to `{type:"any"}` all along.
  assert.throws(
    () => normalizeToolsRequest({ tools: [tool('read')], toolChoice: 'required' }, 'kiro'),
    (error) => {
      assert.equal(error.code, 'TOOL_CHOICE_UNSUPPORTED');
      assert.equal(error.providerId, 'kiro');
      assert.match(error.publicMessage, /cannot be told to force a tool call/);
      assert.match(error.publicMessage, /auto, none/, 'the message does not say what is supported');
      return true;
    },
  );
});

test('a forced call passes through where the adapter maps it', () => {
  const { request } = normalizeToolsRequest({ tools: [tool('read')], toolChoice: 'required' }, 'openai');
  assert.equal(request.toolChoice, 'required');
  assert.equal(request.tools.length, 1);
});

test('a forced choice with nothing to force is refused by name', () => {
  // Sending `tool_choice: required` with no definitions either makes the provider refuse the whole body or asks for a
  // call that cannot name a tool. Both read as a gateway bug; the client asked for something impossible.
  for (const request of [
    { model: 'm', messages: [], toolChoice: 'required' },
    { model: 'm', messages: [], tools: [tool('bad name')], toolChoice: 'required' },
  ]) {
    assert.throws(
      () => normalizeToolsRequest(request, 'openai'),
      (error) => error.name === 'ToolContractError' && /at least one valid tool definition/.test(error.publicMessage),
    );
  }
  // `none` with no definitions is still a harmless no-op.
  assert.doesNotThrow(() => normalizeToolsRequest({ model: 'm', messages: [], toolChoice: 'none' }, 'openai'));
});

test('a definition that would break the provider is dropped, and the drop is named', () => {
  const { request, notes } = normalizeToolsRequest(
    { tools: [tool('ok'), tool('bad name'), tool('ok'), { name: 'x', parameters: [] }] },
    'openai',
  );
  assert.deepEqual(request.tools.map((entry) => entry.name), ['ok']);
  const reasons = notes.dropped.map((entry) => entry.name);
  assert.deepEqual(reasons, ['bad name', 'ok', 'x'], `unexpected drops: ${JSON.stringify(notes.dropped)}`);
});

test('a schema larger than the cap is refused rather than paid for on every turn', () => {
  // The description is truncated to 2 KB, so size has to come from the parameters — which is the realistic case anyway:
  // a tool whose schema enumerates a thousand values.
  const huge = tool('huge', { parameters: { type: 'object', properties: { values: { enum: Array.from({ length: 4000 }, (_, i) => `value-${i}`) } } } });
  const { request, notes } = normalizeToolsRequest({ tools: [huge] }, 'openai');
  assert.equal(request.tools.length, 0);
  assert.match(notes.dropped[0].reason, /exceed/);
});

test('arguments that are already JSON are not rewritten', () => {
  const repair = repairArguments('{"path":"a.ts"}');
  assert.equal(repair.ok, true);
  assert.deepEqual(repair.result.repairs, []);
  assert.equal(repair.result.text, '{"path":"a.ts"}');
});

test('the bounded repairs fix what they claim and nothing else', () => {
  const cases = [
    ['{"path":"a.ts",}', 'trailing comma'],
    [`{"path": 'a.ts'}`, 'single quotes'],
    ['{path: "a.ts"}', 'bare key'],
    ['```json\n{"path":"a.ts"}\n```', 'markdown fence'],
  ];
  for (const [input, label] of cases) {
    const repair = repairArguments(input);
    assert.equal(repair.ok, true, `${label} was not repaired`);
    assert.deepEqual(repair.result.value, { path: 'a.ts' }, `${label} produced ${JSON.stringify(repair.result.value)}`);
    assert.ok(repair.result.repairs.length > 0, `${label} was repaired without saying so`);
  }
});

test('prose and malformed arguments are refused, not guessed', () => {
  assert.equal(repairArguments('run the tests first').ok, false);
  assert.equal(repairArguments('{"path": }').ok, false);
  assert.equal(repairArguments('{"__proto__": {"x": 1}}').ok, false, 'a prototype key was accepted');
});

test('empty arguments become an empty object, which is what a no-argument tool takes', () => {
  const repair = repairArguments('   ');
  assert.equal(repair.ok, true);
  assert.deepEqual(repair.result.value, {});
});

test('a call naming a tool the client never declared is not forwarded', () => {
  const { calls, issues } = validateToolCalls(
    [{ id: 'c1', type: 'function', function: { name: 'rm_rf', arguments: '{"path":"/"}' } }],
    ['read'],
  );
  assert.deepEqual(calls, [], 'an undeclared tool reached the client');
  assert.equal(issues[0].name, 'rm_rf');
  assert.match(issues[0].reason, /did not declare/);
});

test('a call with unparseable arguments is an issue, and a repairable one is repaired', () => {
  const result = validateToolCalls(
    [
      { id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts",}' } },
      { id: 'c2', type: 'function', function: { name: 'read', arguments: 'the file is big' } },
    ],
    ['read'],
  );
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].function.arguments, '{"path":"a.ts"}');
  assert.equal(result.repaired.length, 1);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].index, 1);
});

async function collect(chunks, declared, report) {
  const seen = [];
  for await (const chunk of guardToolStream((async function* () { yield* chunks; })(), declared, report)) seen.push(chunk);
  return seen;
}

test('the stream guard passes non-object and empty deltas through untouched', async () => {
  const stringChunk = { delta: 'twelve chars' };
  const emptyChunk = { delta: {} };
  const report = { allowed: [], blocked: [] };
  const seen = await collect([stringChunk, emptyChunk], ['read'], report);
  assert.equal(seen[0], stringChunk, 'a string delta was rewritten');
  assert.equal(seen[1], emptyChunk, 'a chunk with no tool calls was rewritten');
  assert.deepEqual(report, { allowed: [], blocked: [] });
});

test('the stream guard resolves a call name from an earlier chunk', async () => {
  const report = { allowed: [], blocked: [] };
  const seen = await collect([
    { delta: { toolCalls: [{ index: 0, function: { name: 'read' } }] } },
    { delta: { toolCalls: [{ index: 0, function: { arguments: '{"path":"a.ts"}' } }] }, finishReason: 'tool_calls' },
  ], ['read'], report);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].delta.toolCalls.length, 1, 'the second half of the call was dropped');
  assert.deepEqual(report.allowed, ['read']);
  assert.equal(seen[1].finishReason, 'tool_calls');
});

test('an allowed call emitted earlier survives a later blocked chunk ending as a tool call', async () => {
  const report = { allowed: [], blocked: [] };
  const seen = await collect([
    { delta: { toolCalls: [
      { index: 0, function: { name: 'read', arguments: '{}' } },
      { index: 1, function: { name: 'rm_rf', arguments: '{}' } },
    ] } },
    { delta: { toolCalls: [{ index: 1, function: { arguments: '{"path":"/"}' } }] }, finishReason: 'tool_calls' },
  ], ['read'], report);
  assert.deepEqual(report.blocked, [{ index: 1, name: 'rm_rf' }]);
  assert.deepEqual(report.allowed, ['read']);
  assert.equal(seen[0].delta.toolCalls.length, 1, 'the undeclared call was forwarded');
  assert.equal(seen[1].finishReason, 'tool_calls', 'a turn that did include a call was reported as plain stop');
});

test('the gateway tool catalog has no shell tool and is declared unavailable', () => {
  assert.deepEqual([...GATEWAY_TOOL_NAMES], ['glob', 'grep', 'read']);
  assert.equal(GATEWAY_TOOL_NAMES.includes('bash'), false, 'a shell tool is back in the catalog');
  for (const tool of gatewayToolDefinitions()) {
    assert.match(tool.description, /unavailable and must not be used/, `${tool.name} claims to work`);
  }
  assert.deepEqual([...GATEWAY_TOOL_PROVIDERS].sort(), ['opencode', 'opencode-console', 'opencode-go']);
});

test('gateway tools are appended without replacing the caller’s definitions', () => {
  const merged = withGatewayTools([
    { name: 'Read', parameters: { type: 'object' } },
    { name: 'write', parameters: { type: 'object' } },
  ]);
  assert.deepEqual(merged.map((tool) => tool.name), ['read', 'write', 'glob', 'grep']);
  assert.equal(merged[0].name, 'read', 'a casing variant was not folded onto the canonical name');
  assert.equal(merged.filter((tool) => tool.name === 'read').length, 1, 'the caller’s tool was duplicated');

  const forced = withGatewayTools([{ name: 'write', parameters: {} }], 'required');
  assert.deepEqual(forced.map((tool) => tool.name), ['write'], 'a generated tool could win a forced call');
});

test('a Claude client with MCP web tools does not also declare built-in web tools', () => {
  const tools = [
    { name: 'WebSearch', parameters: { type: 'object' } },
    { name: 'mcp__exa__search', parameters: { type: 'object' } },
    { name: 'read', parameters: { type: 'object' } },
  ];
  const claude = dedupeToolDefinitions(tools, 'anthropic');
  assert.deepEqual(claude.tools.map((tool) => tool.name), ['mcp__exa__search', 'read']);
  assert.match(claude.dropped[0].reason, /MCP web tool/);
  const openai = dedupeToolDefinitions(tools, 'openai');
  assert.deepEqual(openai.tools.map((tool) => tool.name), ['WebSearch', 'mcp__exa__search', 'read'], 'a non-Claude provider lost a definition');
});

test('the local tool catalog is read-only and has no shell', () => {
  const names = localToolDefinitions().map((tool) => tool.name);
  assert.deepEqual(names, ['local_read', 'local_glob', 'local_grep']);
  assert.equal(names.some((name) => /bash|shell|exec|write/i.test(name)), false, 'a command or write tool is in the catalog');
  assert.match(LOCAL_TOOL_PROMPT, /No shell, write or network tool exists/);
});

test('a prompt tool call is parsed only from the fenced shape', () => {
  assert.deepEqual(
    parsePromptToolCall('thinking\n```local-tool\n{"name":"local_read","arguments":{"path":"a.txt"}}\n```\n'),
    { name: 'local_read', path: 'a.txt' },
  );
  assert.equal(parsePromptToolCall('just prose'), undefined);
  assert.equal(parsePromptToolCall('```local-tool\n{"name":"bash","arguments":{}}\n```'), undefined, 'a shell call was accepted');
  assert.equal(parsePromptToolCall('```local-tool\nnot json\n```'), undefined);
  assert.deepEqual(parseNativeToolCall('local_grep', '{"path":"src","pattern":"TODO","limit":5}'), { name: 'local_grep', path: 'src', pattern: 'TODO', limit: 5 });
  assert.equal(parseNativeToolCall('bash', '{"command":"ls"}'), undefined);
});

test('every row in the table is internally consistent', () => {
  for (const [id, caps] of Object.entries(PROVIDER_TOOLS)) {
    if (!caps.tools) assert.deepEqual(caps.toolChoice, [], `${id} serves no tools but lists a choice`);
    if (caps.toolChoice.length > 0) assert.equal(caps.tools, true, `${id} lists a choice but serves no tools`);
    if (caps.web) assert.equal(caps.tools, false, `${id} is a web session with tools`);
  }
});
