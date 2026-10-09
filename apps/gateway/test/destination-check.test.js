import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPublicDestination } from '../dist/destination-check.js';

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
