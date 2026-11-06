import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * A Cline sign-in must survive a catalog it could not read.
 *
 * Measured failure: a user signed in, Cline approved, and the callback reported
 * "The local connection could not be saved." / "The gateway encountered an unexpected error." The
 * credential was fine — discovery of the model catalog failed, and `connectCline` was the only
 * sign-in path that did not pass `tolerateDiscoveryFailure`. Every other provider's sign-in does.
 *
 * The cost was not a wrong message: a good session was thrown away and the user was told to sign in
 * again, repeatedly.
 */
test('the Cline sign-in tolerates a discovery failure, like every other sign-in', () => {
  const source = readFileSync(new URL('../src/core/service.ts', import.meta.url), 'utf8');
  const start = source.indexOf('async connectCline(');
  assert.ok(start > 0, 'connectCline must still exist');
  const body = source.slice(start, source.indexOf('\n  }', start));

  assert.match(
    body,
    /tolerateDiscoveryFailure: true/,
    'connectCline must pass `tolerateDiscoveryFailure: true`, or a provider-side catalog failure is reported as a storage failure and the session is lost',
  );
});
