import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { usage } from '../cli/index.mjs';
import { findLauncher, readRegisteredLauncher, registerLauncher } from '../cli/lib/launcher.mjs';

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

function runBin(binPath, args, extraEnv = {}, cwd = root) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1', ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function runCli(args, extraEnv = {}) {
  return runBin(bin, args, extraEnv);
}

test('help lists the verbs and makes no request at all', async () => {
  const gateway = await fakeGateway(() => ({ body: {} }));
  try {
    const { code, stdout } = await runCli(['help', '--gateway', gateway.url]);
    assert.equal(code, 0);
    for (const verb of ['setup', 'doctor', 'status', 'ps', 'open', 'stop', 'restart', 'providers', 'models', 'test', 'keys', 'routing', 'logs']) {
      assert.match(stdout, new RegExp(`\\b${verb}\\b`), `${verb} is offered`);
    }
    // The rule the reference implementation broke by running its setup before parsing arguments: asking
    // what a command does must not do anything.
    assert.deepEqual(gateway.requests, [], 'help touches nothing');
  } finally {
    await gateway.close();
  }
});

test('the installed client says what it cannot do, and the launcher help still says what it can', async () => {
  // Reported from a real install: `npm i -g @hilbras/omnihilbras`, then `omnihilbras` printed the verb
  // list and the launcher's footer — "run with no verb to start the gateway and the dashboard" — which
  // the published package cannot do. The person read that as "the command is broken".
  //
  // Run outside the checkout with an empty config so no launcher is discoverable: inside this repo the
  // client would correctly delegate to the checkout launcher, which is a different assertion.
  const client = path.join(root, 'cli', 'bin', 'omnihilbras.js');
  const isolated = mkdtempSync(path.join(os.tmpdir(), 'omnihilbras-client-'));
  // Point past both launchers: a built checkout has `cli/server/main.mjs` staged, and this test is
  // about the words an install with no server at all prints.
  const env = {
    XDG_CONFIG_HOME: path.join(isolated, 'config'),
    OMNIHILBRAS_BUNDLED_SERVER: path.join(isolated, 'no-server.mjs'),
  };
  const bare = await runBin(client, [], env, isolated);
  assert.equal(bare.code, 2);
  assert.match(bare.stdout, /This is the gateway client\. It cannot start a gateway or the dashboard\./);
  assert.match(bare.stdout, /desktop app/);
  assert.doesNotMatch(bare.stdout, /with no verb to start/, 'the client must not repeat the launcher’s promise');

  const help = await runBin(client, ['help'], env, isolated);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /This installed command is the gateway client/);
  assert.doesNotMatch(help.stdout, /with no verb to start/);

  // The checkout's launcher is the one entry point for which the promise is true.
  assert.match(usage({ launcher: true }), /with no verb to start/);
  assert.doesNotMatch(usage(), /with no verb to start/);
});

test('bare invocation delegates to a registered launcher, and start strips its own word', async () => {
  // The published client and the checkout launcher are separate files. `setup` records the launcher;
  // this asserts the client actually hands over, because a record nobody reads is the same defect as
  // the help text promising a start that never happens.
  const directory = mkdtempSync(path.join(os.tmpdir(), 'omnihilbras-delegate-'));
  const fake = path.join(directory, 'fake-launcher.js');
  writeFileSync(fake, "console.log(`FAKE ${JSON.stringify(process.argv.slice(2))}`);\n");
  const client = path.join(root, 'cli', 'bin', 'omnihilbras.js');
  const env = {
    XDG_CONFIG_HOME: path.join(directory, 'config'),
    OMNIHILBRAS_LAUNCHER: fake,
    OMNIHILBRAS_BUNDLED_SERVER: path.join(directory, 'no-server.mjs'),
  };

  const bare = await runBin(client, [], env, directory);
  assert.equal(bare.code, 0);
  assert.match(bare.stdout, /FAKE \[\]/, 'a bare invocation did not reach the launcher');

  const start = await runBin(client, ['start', '--no-browser'], env, directory);
  assert.match(start.stdout, /FAKE \["--no-browser"\]/, 'start must not pass its own word through');

  const help = await runBin(client, ['help'], env, directory);
  assert.doesNotMatch(help.stdout, /FAKE/, 'a verb must stay in the client');
});

test('a published install prefers its bundled server over any checkout', async () => {
  // The whole point of staging the server inside the package: a person who only did `npm i -g` gets a
  // command that starts both halves, with no checkout and no PATH negotiation.
  const directory = mkdtempSync(path.join(os.tmpdir(), 'omnihilbras-bundled-'));
  const fake = path.join(directory, 'bundled.mjs');
  writeFileSync(fake, "console.log(`BUNDLED ${JSON.stringify(process.argv.slice(2))}`);\n");
  const client = path.join(root, 'cli', 'bin', 'omnihilbras.js');
  const env = {
    XDG_CONFIG_HOME: path.join(directory, 'config'),
    OMNIHILBRAS_BUNDLED_SERVER: fake,
    OMNIHILBRAS_LAUNCHER: path.join(directory, 'not-a-launcher.js'),
  };

  const bare = await runBin(client, [], env, directory);
  assert.equal(bare.code, 0);
  assert.match(bare.stdout, /BUNDLED \[\]/, 'a bare invocation did not reach the bundled server');

  const start = await runBin(client, ['start', '--no-browser'], env, directory);
  assert.match(start.stdout, /BUNDLED \["--no-browser"\]/, 'start must pass its flags, not its own word');

  const help = await runBin(client, ['help'], env, directory);
  assert.doesNotMatch(help.stdout, /BUNDLED/, 'verbs still belong to the client');
});

test('setup records the launcher so a reinstalled client still starts the servers', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'omnihilbras-record-'));
  const launcher = path.join(directory, 'bin', 'omnihilbras.js');
  mkdirSync(path.dirname(launcher), { recursive: true });
  writeFileSync(launcher, '');
  const env = { XDG_CONFIG_HOME: path.join(directory, 'config') };

  assert.equal(readRegisteredLauncher(env), undefined, 'a fresh config has no record');
  assert.equal(registerLauncher(launcher, env), launcher);
  assert.equal(readRegisteredLauncher(env), launcher);
  assert.equal(findLauncher({ env, cwd: directory })?.path, launcher);

  const setup = readFileSync(path.join(root, 'cli', 'commands', 'setup.mjs'), 'utf8');
  assert.match(setup, /registerLauncher\(startTarget\.path\)/, 'setup does not record the launcher it found');
});

test('setup only offers a start target it can actually run', () => {
  // In the published layout `../../bin/omnihilbras.js` resolved to `node_modules/bin/omnihilbras.js`,
  // which is not in the tarball. `shortcutTarget()` already knows the difference between a checkout
  // launcher and the client, so setup asks it instead of assuming the checkout's layout.
  const setup = readFileSync(path.join(root, 'cli', 'commands', 'setup.mjs'), 'utf8');
  assert.match(setup, /shortcutTarget\(\)/, 'setup must ask which entry point it has');
  assert.match(setup, /startTarget\?\.kind === 'launcher'/, 'only the launcher may be offered as a start');
  assert.doesNotMatch(setup, /new URL\('\.\.\/\.\.\/bin\/omnihilbras\.js'/, 'the checkout-relative start path is back');
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
