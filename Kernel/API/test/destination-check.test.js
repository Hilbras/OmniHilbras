import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPublicDestination } from '../dist/src/core/destination-check.js';

test('a name that resolves to loopback is refused, even though its text looks public', async () => {
  await assert.rejects(
    () => assertPublicDestination('127.0.0.1.nip.io'),
    /resolves to a private address/,
    'the string check cannot see this; the resolution must',
  );
});

test('a name that resolves only to a public address is allowed', async () => {
  await assertPublicDestination('example.com');
});

test('a name that does not resolve is refused, not allowed through', async () => {
  await assert.rejects(() => assertPublicDestination('no-such-host.invalid'));
});

test('the refusal a user sees names the cause, instead of "not configured correctly"', async () => {
  // Measured on a machine whose resolver answered `www.codebuddy.ai` with `0.0.0.1` (a hosts-file
  // block). The dashboard showed "The provider is not configured correctly", which is true of nothing
  // here: the provider was fine, the code was fine, and the one fact that solved it — a private
  // address — was only in the log. A refusal that a user can read has to carry its own reason.
  const { FetchHttpTransport } = await import('../dist/src/core/index.js');
  const transport = new FetchHttpTransport({ checkDestination: async () => {
    throw new Error('resolves to a private address');
  } });
  await assert.rejects(
    () => transport.request({ method: 'GET', url: 'https://www.codebuddy.ai/v2/plugin/auth/state', providerId: 'codebuddy-intl' }),
    (error) => {
      assert.equal(error.code, 'CONFIGURATION_ERROR');
      const shown = error.toJSON().message;
      assert.match(shown, /private address/, `the message a user sees must name the cause, not: ${shown}`);
      assert.match(shown, /www\.codebuddy\.ai/, 'and must name the host, so it can be looked up');
      return true;
    },
  );
});

test('a name the local resolver blackholes is rescued by a public one, and a private name still is not', async () => {
  // Measured: this machine's router answered `www.codebuddy.ai` with `0.0.0.0.1`, a block, while Google
  // DNS and Cloudflare both said `43.169.32.91` and the host served normally. Refusing on the local
  // answer alone turned a router rule into "this provider is broken".
  //
  // The rule this pins: the fallback only ever *adds* an answer, and the private judgement runs over
  // both sets — so it can rescue a name and can never unblock a real private destination.
  const { resolveForDestinationCheck } = await import('../dist/src/core/destination-check.js');

  // A blackholed public name is rescued to its published address.
  const rescued = await resolveForDestinationCheck('www.codebuddy.ai');
  assert.ok(rescued.length > 0);
  assert.ok(!rescued.some((address) => address.startsWith('0.0.0.')), `a blackhole answer survived: ${rescued.join(', ')}`);

  // And a genuinely private name is still refused, which is the half that matters.
  const { assertPublicDestination } = await import('../dist/src/core/destination-check.js');
  await assert.rejects(
    () => assertPublicDestination('127.0.0.1.nip.io'),
    /resolves to a private address/,
    'the public fallback must not become a way past the guard',
  );
});
