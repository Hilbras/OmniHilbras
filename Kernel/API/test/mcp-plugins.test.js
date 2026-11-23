import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { InMemorySecretStore, ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/src/index.js';
import { activePluginBridges } from '../dist/src/routes/mcpPlugins.js';

/**
 * The MCP plugin bridge, proved with a real child process that is scripted locally.
 *
 * No vendor, network or credential is involved. The fixture is an argv-only Node script the test
 * writes into a temporary operator directory; the gateway spawns it because the directory's registry
 * names it, never because a request did. The assertions are about the mechanism: newline framing on
 * the child's stdin/stdout, a bounded SSE text block, a refused `shell` tool, and reaping on abort.
 */

const CHILD_SOURCE = [
  "import { writeFileSync } from 'node:fs';",
  'writeFileSync(process.argv[2], String(process.pid));',
  "process.stdin.setEncoding('utf8');",
  "let buffer = '';",
  "process.stdin.on('data', (chunk) => {",
  '  buffer += chunk;',
  '  let index = buffer.indexOf(String.fromCharCode(10));',
  '  while (index >= 0) {',
  '    const line = buffer.slice(0, index).trim();',
  '    buffer = buffer.slice(index + 1);',
  '    index = buffer.indexOf(String.fromCharCode(10));',
  '    if (!line) continue;',
  '    let message;',
  '    try { message = JSON.parse(line); } catch { continue; }',
  "    const mode = message.params && message.params.mode === 'long' ? 'long' : (message.params && message.params.mode === 'tools' ? 'tools' : 'short');",
  "    let result;",
  "    if (mode === 'tools') result = { tools: [{ name: 'ok' }, { name: 'shell' }] };",
  "    else result = { content: [{ type: 'text', text: mode === 'long' ? 'x'.repeat(60000) : 'short answer' }] };",
  "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + String.fromCharCode(10));",
  '  }',
  '});',
  '',
].join('\n');

async function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'oh-mcp-plugin-'));
  const child = join(directory, 'child.mjs');
  const pidFile = join(directory, 'child.pid');
  writeFileSync(child, CHILD_SOURCE);
  writeFileSync(join(directory, 'mcp-plugins.json'), JSON.stringify({
    plugins: [{ id: 'fixture', command: process.execPath, args: [child, pidFile] }],
  }));
  const apiKeys = new InMemoryApiKeyStore();
  const { key } = await apiKeys.create('test');
  const service = new GatewayService(
    new ProviderRegistry(),
    new InMemorySecretStore({}),
    new InMemoryConnectionStore(),
    apiKeys,
    {},
  );
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173', mcpPluginsDir: directory });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    key, pidFile, directory, server,
  };
}

async function close(state) {
  // An SSE response can outlive the test that opened it; close its socket before waiting for the
  // server, or `server.close` waits forever for a connection nobody is going to finish.
  state.server.closeAllConnections?.();
  await new Promise((resolve) => state.server.close(resolve));
}

async function openStream(base, key) {
  const controller = new AbortController();
  const response = await fetch(`${base}/v1/mcp/plugins/stream/fixture`, {
    headers: { authorization: `Bearer ${key}` },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  // One continuous reader keeps every byte in order. Interleaving `read()` calls with assertions
  // drops the tail of a chunk, which makes the next frame look like a dead connection.
  const frames = [];
  const decoder = new TextDecoder();
  let buffer = '';
  const pump = (async () => {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end = buffer.indexOf('\n\n');
      while (end >= 0) {
        const frame = buffer.slice(0, end + 2);
        buffer = buffer.slice(end + 2);
        const match = /event: message\ndata: ([^\n]*)\n\n/.exec(frame);
        if (match) frames.push({ raw: match[0], message: JSON.parse(match[1]) });
        end = buffer.indexOf('\n\n');
      }
    }
  })().catch(() => undefined);
  return { response, controller, frames, pump };
}

async function frameAt(frames, index) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (frames[index]) return frames[index];
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.fail(`frame ${index} never arrived; got ${frames.length}`);
}

async function message(base, key, params) {
  const response = await fetch(`${base}/v1/mcp/plugins/message/fixture`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }),
  });
  // Consume the body before the next request. An undici response left unread holds its connection,
  // and the next POST on that pool is answered with ECONNRESET — a harness bug, not a route failure.
  const text = await response.text();
  return { status: response.status, text, json: () => JSON.parse(text) };
}

async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

test('plugin routes require a gateway key and expose only operator-registered ids', async () => {
  const state = await harness();
  try {
    const anonymous = await fetch(`${state.base}/v1/mcp/plugins/stream/fixture`);
    assert.equal(anonymous.status, 401, 'a child-spawning route was reachable without a key');
    const listed = await (await fetch(`${state.base}/v1/mcp/plugins`, {
      headers: { authorization: `Bearer ${state.key}` },
    })).json();
    assert.deepEqual(listed.plugins, ['fixture']);
    const unknown = await fetch(`${state.base}/v1/mcp/plugins/stream/not-registered`, {
      headers: { authorization: `Bearer ${state.key}` },
    });
    assert.equal(unknown.status, 404, 'an unregistered id was spawned');
  } finally {
    await close(state);
  }
});

test('newline frames round-trip, text is bounded, and tools/list never advertises shell', async () => {
  const state = await harness();
  try {
    // Each round-trip owns its stream: the child is supervised per stream, and a fresh stream proves
    // reaping between cases as well as framing within one.
    const roundTrip = async (params) => {
      const stream = await openStream(state.base, state.key);
      try {
        assert.ok(await waitFor(() => activePluginBridges() > 0), 'the bridge never started');
          const posted = await message(state.base, state.key, params);
          assert.equal(posted.status, 202);
        const frame = await frameAt(stream.frames, 0);
        return frame;
      } finally {
        stream.controller.abort();
        // Undici recycles the aborted stream's socket; give it a tick before the next connection.
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };

    const short = await roundTrip({ name: 'read', mode: 'short' });
    assert.match(short.raw, /^event: message\ndata: /, 'the SSE frame was not newline-delimited');
    assert.equal(short.message.result.content[0].text, 'short answer');

    const long = await roundTrip({ name: 'read', mode: 'long' });
    const bounded = long.message.result.content[0].text;
    assert.ok(bounded.length <= 50_000, `unbounded text streamed (${bounded.length} chars)`);
    assert.match(bounded, /truncated at 50000 characters/, 'the truncation marker was not sent');
    assert.doesNotMatch(bounded, /x{50000}/, 'the full over-long text was streamed');

    const tools = await roundTrip({ name: 'list', mode: 'tools' });
    const names = tools.message.result.tools.map((tool) => tool.name);
    assert.deepEqual(names, ['ok'], 'a shell tool leaked through tools/list');
  } finally {
    await close(state);
  }
});

function existsSyncPid(pidFile) {
  try { return readFileSync(pidFile, 'utf8').trim().length > 0; } catch { return false; }
}

function childGone(pidFile) {
  try {
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

test('a shell tool call is refused by name before it reaches the child', async () => {
  const state = await harness();
  const stream = await openStream(state.base, state.key);
  try {
    const response = await message(state.base, state.key, { name: 'shell', mode: 'short' });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, -32601);
    assert.match(body.error.message, /tool "shell" is not available/);
  } finally {
    stream.controller.abort();
    await close(state);
  }
});

test('the child is reaped when the client aborts and the last stream closes', async () => {
  const state = await harness();
  const stream = await openStream(state.base, state.key);
  assert.ok(await waitFor(() => activePluginBridges() > 0), 'the bridge was not registered');
  assert.ok(await waitFor(() => existsSyncPid(state.pidFile)), 'the child never wrote its pid');
  stream.controller.abort();
  assert.ok(await waitFor(() => childGone(state.pidFile)), 'the child survived client abort');
  assert.equal(activePluginBridges(), 0, 'a closed bridge stayed in the registry');
  await close(state);
});
