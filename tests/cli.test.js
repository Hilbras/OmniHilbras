import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * The CLI, driven the way a person drives it: as a child process with a real gateway on the other end.
 *
 * A fake gateway rather than the running one, because these assert the *contract* — which header is
 * sent, which exit code comes back, whether anything happened at all — and a real gateway's answers
 * change with what is connected. Two of these pin bugs found while writing the verbs: `omnihilbras test`
 * asked the gateway a question it refused to parse because the request did not declare JSON, and
 * `--help` used to be parsed after the launcher's setup work.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'omnihilbras.js');

/** A gateway that answers what a test tells it to, and records everything it was asked. */
async function fakeGateway(handler) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const record = { method: request.method, url: request.url, headers: request.headers, body };
      requests.push(record);
      const answer = handler(record);
      response.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer.body ?? {}));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function runCli(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: root,
      env: { ...process.env, NO_COLOR: '1', ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('help lists the verbs and makes no request at all', async () => {
  const gateway = await fakeGateway(() => ({ body: {} }));
  try {
    const { code, stdout } = await runCli(['help', '--gateway', gateway.url]);
    assert.equal(code, 0);
    for (const verb of ['setup', 'doctor', 'status', 'providers', 'models', 'test', 'keys', 'routing', 'logs']) {
      assert.match(stdout, new RegExp(`\\b${verb}\\b`), `${verb} is offered`);
    }
    // The rule the reference implementation broke by running its setup before parsing arguments: asking
    // what a command does must not do anything.
    assert.deepEqual(gateway.requests, [], 'help touches nothing');
  } finally {
    await gateway.close();
  }
});

test('an unknown verb is refused with the way out, and exit code 2', async () => {
  const { code, stderr } = await runCli(['proivders']);
  assert.equal(code, 2);
  assert.match(stderr, /not a verb/);
  assert.match(stderr, /omnihilbras help/);
});

test('an unknown flag on a known verb is refused rather than ignored', async () => {
  const { code, stderr } = await runCli(['status', '--strcit']);
  assert.equal(code, 2);
  assert.match(stderr, /does not take `--strcit`/);
});

test('status --json is the whole answer and nothing else', async () => {
  const gateway = await fakeGateway((request) => {
    assert.equal(request.url, '/health');
    return { body: { service: 'omnihilbras-gateway', build: { version: '9.9.9', startedAt: 'now' }, status: 'healthy', providers: [] } };
  });
  try {
    const { code, stdout } = await runCli(['status', '--json', '--api-key', 'test-key', '--gateway', gateway.url]);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.version, '9.9.9');
    assert.equal(parsed.auth, 'api-key');
    assert.equal(stdout.trim().startsWith('{'), true, 'no banner before the JSON');
    assert.equal(gateway.requests[0].headers.authorization, 'Bearer test-key');
  } finally {
    await gateway.close();
  }
});

test('a write declares JSON, which is what the gateway requires', async () => {
  // Found by running the CLI against the real gateway: `test` sent a POST with no body and no
  // content-type, and the gateway answered 415 UNSUPPORTED_MEDIA_TYPE.
  const gateway = await fakeGateway((request) => {
    if (request.url?.endsWith('/probe')) return { body: { providerId: 'zcode', valid: true, latencyMs: 12, checkedAt: 'now' } };
    if (request.url === '/v1/connections') return { body: { object: 'list', data: [{ id: 'zcode', providerId: 'zcode', name: 'z', enabled: true, priority: 1, hasCredential: true, credentialType: 'api-key', modelIds: ['m'] }] } };
    return { body: {} };
  });
  try {
    const { code } = await runCli(['test', 'zcode', '--api-key', 'k', '--gateway', gateway.url]);
    assert.equal(code, 0);
    const probe = gateway.requests.find((request) => request.method === 'POST');
    assert.ok(probe, 'the probe was sent');
    assert.equal(probe.headers['content-type'], 'application/json', 'and it declared JSON');
  } finally {
    await gateway.close();
  }
});

test('a refused management call explains which credential is missing', async () => {
  const gateway = await fakeGateway(() => ({ status: 401, body: { error: { code: 'AUTHENTICATION_FAILED', message: 'This gateway requires an API key.' } } }));
  try {
    const { code, stderr } = await runCli(['providers', '--gateway', gateway.url]);
    assert.equal(code, 1);
    assert.match(stderr, /requires an API key/);
    assert.match(stderr, /OMNIHILBRAS_API_KEY/, 'and says how to supply one');
  } finally {
    await gateway.close();
  }
});

test('a gateway that is not running is reported as that, not as a parse failure', async () => {
  // Port 1 is reserved and nothing listens there, so this is a refused connection rather than a slow one.
  const { code, stderr } = await runCli(['status', '--api-key', 'k', '--gateway', 'http://127.0.0.1:1']);
  assert.equal(code, 1);
  assert.match(stderr, /Cannot reach the gateway/);
  assert.match(stderr, /omnihilbras`/, 'and suggests starting one');
});

test('listing keys never prints a secret', async () => {
  const gateway = await fakeGateway(() => ({
    body: {
      object: 'list',
      requireApiKey: false,
      keys: [{ id: 'key_1', name: 'mine', prefix: 'ohk_abcdefgh', enabled: true, createdAt: '2026-01-01T00:00:00.000Z' }],
    },
  }));
  try {
    for (const args of [['keys'], ['keys', '--json']]) {
      const { stdout } = await runCli([...args, '--api-key', 'k', '--gateway', gateway.url]);
      assert.equal(/secret/i.test(stdout), false, `${args.join(' ')}: no secret field`);
      // The gateway returns only a prefix; anything longer than it would be a key that leaked.
      assert.equal(/ohk_[A-Za-z0-9_-]{12,}/.test(stdout), false, `${args.join(' ')}: no key material`);
    }
  } finally {
    await gateway.close();
  }
});

test('a failing account is reported without hiding the one that works', async () => {
  const gateway = await fakeGateway((request) => {
    if (request.url === '/v1/connections') {
      return { body: { object: 'list', data: [
        { id: 'p', providerId: 'p', name: 'p', enabled: true, priority: 1, hasCredential: true, modelIds: ['m'] },
        { id: 'p-second', providerId: 'p', name: 'p-second', enabled: true, priority: 2, hasCredential: true, modelIds: ['m'] },
      ] } };
    }
    if (request.url?.endsWith('/probe')) {
      return request.url.includes('p-second')
        ? { body: { providerId: 'p', valid: true, latencyMs: 20, checkedAt: 'now' } }
        : { status: 502, body: { error: { code: 'PROVIDER_REQUEST_FAILED', message: 'no quota left' } } };
    }
    return { body: {} };
  });
  try {
    const { code, stdout } = await runCli(['test', 'p', '--json', '--api-key', 'k', '--gateway', gateway.url]);
    const results = JSON.parse(stdout);
    assert.equal(results.length, 2, 'every account was tested');
    assert.equal(code, 0, 'and one of them working is a success');
    assert.equal(results.find((entry) => entry.connectionId === 'p').valid, false);
    assert.equal(results.find((entry) => entry.connectionId === 'p-second').valid, true);
  } finally {
    await gateway.close();
  }
});
