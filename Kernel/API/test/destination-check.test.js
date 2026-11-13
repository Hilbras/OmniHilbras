import assert from 'node:assert/strict';
import test from 'node:test';
import { createSocket } from 'node:dgram';

/**
 * The public-rescue tests used to reach the real internet: a name the local resolver blackholes,
 * rescued by whatever Google DNS answered that day. Measured on 2026-11-06 that stopped testing the
 * code at all — the network began answering `0.0.0.1` for the domain on *every* resolver, the local
 * one and the public ones alike (direct queries to 8.8.8.8 and 1.1.1.1 included), so no reachable
 * server carried the published answer and the test failed on the environment rather than on a defect.
 *
 * A network that can forge one DNS answer can forge any, so the rescue is now pinned against a stub
 * resolver this file runs itself: deterministic, offline, and honest about the shape — a local
 * private answer, a published public one, and the private judgement over both.
 */
const STUB_ANSWERS = {
  // The address the original incident recorded: the domain's real published answer.
  'www.codebuddy.ai': '43.169.32.91',
  // A name the machine's own resolver has never heard of, for the rescue-on-failure case.
  'nous-rescue.test': '203.0.113.7',
  // A unique name for the cache test: the system resolver cannot answer it, so every check that is
  // not cached reaches this stub, which is what makes the query count meaningful.
  'cache-rescue.test': '203.0.113.9',
  /**
   * `nip.io` is answered by the machine's resolver here — normally in milliseconds, and that is the
   * path this test has always taken. Under load that lookup has been measured stalling past the 2.5s
   * budget, and a stalled lookup is treated as "no local answer", so the rescue was asked instead and
   * the stub did not know the name: the refusal became "did not resolve" rather than "resolves to a
   * private address". Answering it here makes both paths reach the same verdict, so the test measures
   * the judgement rather than the resolver's mood.
   */
  '127.0.0.1.nip.io': '127.0.0.1',
};

const stub = createSocket('udp4');
stub.unref();
/** Every name this stub was asked about, so a test can prove a cached check did not resolve again. */
const stubQueries = [];
stub.on('message', (message, rinfo) => {
  if (message.length < 12 || message.readUInt16BE(4) !== 1) return;
  // Walk the question labels to find the name and where the question ends.
  const labels = [];
  let offset = 12;
  while (offset < message.length && message[offset] !== 0) {
    const length = message[offset];
    labels.push(message.subarray(offset + 1, offset + 1 + length).toString());
    offset += 1 + length;
  }
  stubQueries.push(labels.join('.').toLowerCase());
  const questionEnd = offset + 1 + 4; // the terminating zero, then QTYPE and QCLASS
  const header = Buffer.from(message.subarray(0, 12));
  header.writeUInt16BE(0x8180, 2); // QR=1, RD=1, RA=1 — a normal recursive response
  const answer = STUB_ANSWERS[labels.join('.').toLowerCase()];
  header.writeUInt16BE(answer ? 1 : 0, 6); // ANCOUNT
  const parts = [header, message.subarray(12, questionEnd)];
  if (answer) {
    const record = Buffer.alloc(16);
    record.writeUInt16BE(0xc00c, 0); // the name, by pointer to the question
    record.writeUInt16BE(1, 2); // type A
    record.writeUInt16BE(1, 4); // class IN
    record.writeUInt32BE(0, 6); // TTL
    record.writeUInt16BE(4, 10); // RDLENGTH
    answer.split('.').forEach((octet, index) => record.writeUInt8(Number(octet), 12 + index));
    parts.push(record);
  }
  void stub.send(Buffer.concat(parts), rinfo.port, rinfo.address);
});
await new Promise((resolve, reject) => stub.bind(0, '127.0.0.1', () => resolve()));
// Read once, at module load, by the code under test — so it is set before the first import of it.
process.env.OMNIHILBRAS_PUBLIC_DNS = `127.0.0.1:${stub.address().port}`;
const { assertPublicDestination } = await import('../dist/src/core/destination-check.js');

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
  // Measured: this machine's router answered `www.codebuddy.ai` with `0.0.0.1`, a block, while public
  // resolvers said `43.169.32.91` and the host served normally. Refusing on the local answer alone
  // turned a router rule into "this provider is broken".
  //
  // The rule this pins: the fallback only ever *adds* an answer, and the private judgement runs over
  // both sets — so it can rescue a name and can never unblock a real private destination. Whatever
  // the local resolver answers today (the real address, or a network's block), the stub's published
  // answer reaches the check.
  const { resolveForDestinationCheck } = await import('../dist/src/core/destination-check.js');

  const rescued = await resolveForDestinationCheck('www.codebuddy.ai');
  assert.ok(rescued.length > 0);
  assert.ok(!rescued.some((address) => address.startsWith('0.0.0.')), `a blackhole answer survived: ${rescued.join(', ')}`);
  assert.ok(rescued.includes('43.169.32.91'), 'the published answer is among the set the judgement runs over');

  // And a name that is private everywhere is still refused: the stub publishes nothing for it, so the
  // fallback cannot become a way past the guard.
  await assert.rejects(
    () => assertPublicDestination('localhost'),
    /resolves to a private address/,
    'the public fallback must not become a way past the guard',
  );
});

test('a name the system resolver cannot answer at all is rescued by the public one', async () => {
  // Measured: this network's resolver stalled twenty seconds on names it did not know —
  // `inference-api.nousresearch.com` hung the full getaddrinfo window while public resolvers held the
  // answer in under 50ms — and the rescue used to fire only on a *private* answer, so a failed or
  // stalled lookup threw instead of being rescued. A name that is private everywhere is still
  // refused: the stub publishes nothing for the private probe, exactly as before.
  const { resolveForDestinationCheck } = await import('../dist/src/core/destination-check.js');

  const rescued = await resolveForDestinationCheck('nous-rescue.test');
  assert.deepEqual(rescued, ['203.0.113.7'], 'the published answer survives a system-side failure');

  await assert.rejects(
    () => resolveForDestinationCheck('no-such-host.invalid'),
    undefined,
    'a name the public resolver also lacks still ends as a refusal',
  );
});

test('a repeated check reuses the verdict instead of resolving again', async () => {
  // Every request and every stream runs the destination check before it is sent. Resolving the name
  // each time meant a resolver that stalled for its 2.5 s budget added that wait to a request that
  // was otherwise ready — and a health poll plus the user request right after it paid twice. The
  // verdict is cached, so the second check must not reach the resolver at all.
  const { assertPublicDestination, clearDestinationCache } = await import('../dist/src/core/destination-check.js');
  clearDestinationCache();
  const count = () => stubQueries.filter((name) => name === 'cache-rescue.test').length;

  const before = count();
  await assertPublicDestination('cache-rescue.test');
  await assertPublicDestination('cache-rescue.test');

  assert.equal(count() - before, 1, 'the second check resolved the name again instead of using the cached verdict');
});

test('the cache can be turned off, so a caller that needs a fresh answer gets one', async () => {
  const { assertPublicDestination, clearDestinationCache } = await import('../dist/src/core/destination-check.js');
  const previous = process.env.OMNIHILBRAS_DNS_CACHE_TTL_MS;
  process.env.OMNIHILBRAS_DNS_CACHE_TTL_MS = '0';
  clearDestinationCache();
  const count = () => stubQueries.filter((name) => name === 'cache-rescue.test').length;
  try {
    const before = count();
    await assertPublicDestination('cache-rescue.test');
    await assertPublicDestination('cache-rescue.test');
    assert.equal(count() - before, 2, 'TTL 0 still served a cached verdict');
  } finally {
    if (previous === undefined) delete process.env.OMNIHILBRAS_DNS_CACHE_TTL_MS;
    else process.env.OMNIHILBRAS_DNS_CACHE_TTL_MS = previous;
    clearDestinationCache();
  }
});
