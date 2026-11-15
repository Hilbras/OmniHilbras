import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The dev server's gateway proxy must not die with the gateway.
 *
 * `configureServer` forwards `/v1/*` and `/health` to the gateway, and it piped the upstream body straight
 * into the response with no `error` listener. A piped stream that errors has no handler, so it is an
 * **unhandled error event**, and Node exits — the dashboard's dev server gone because the gateway was
 * restarted while the page was open. Measured three times in one session, each time described the same way:
 *
 *     TypeError: terminated
 *       [cause]: SocketError: other side closed
 *     [ELIFECYCLE] Command failed with exit code 1
 *
 * Restarting the gateway is one of the most common things done to this project, so the failure was frequent
 * and its cause was never the dashboard's own code.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = fs.readFileSync(path.join(root, 'vite.config.ts'), 'utf8');

test('an upstream that dies mid-response ends that one response', () => {
  assert.match(
    config,
    /source\.on\('error', \(\) => \{ if \(!response\.writableEnded\) response\.end\(\); \}\)/,
    'the source error is handled rather than left unhandled',
  );
  // `Response for a request that was already half-answered` cannot be un-sent; ending it is the honest
  // outcome, and the next request is served normally.
  assert.match(config, /source\.pipe\(response\)/, 'the body is still streamed, not buffered');
});

test('a client that leaves does not keep the upstream open', () => {
  assert.match(config, /response\.on\('close', \(\) => source\.destroy\(\)\)/, 'the upstream is torn down with the response');
});
