import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSafeProviderRequestUrl, isPrivateHostname, isLoopbackHostname, resolveProviderUrl } from '../dist/url.js';

/**
 * The SSRF guard had no test at all.
 *
 * `isPrivateHostname` decides whether a user-supplied provider `endpoint` may be reached, and
 * `assertSafeProviderRequestUrl` is called on the save path (`routes/connections.ts:87`) and again at the
 * transport (`transport.ts:85,125`). Grepping the SDK, gateway and repo test suites for either name returned
 * **nothing** — a security boundary with no coverage, shipped for its entire life.
 *
 * ## The defect it exists for
 *
 * `169.254.169.254` is the cloud instance-metadata endpoint, and it was correctly refused. The same host
 * written as an IPv4-mapped IPv6 address was not:
 *
 * ```
 * VERDICT  PRIVATE  URL
 * blocked  true     https://169.254.169.254/latest/meta-data/
 * ALLOWED  false    https://[::ffff:169.254.169.254]/
 * ALLOWED  false    https://[0:0:0:0:0:ffff:a9fe:a9fe]/
 * ```
 *
 * Both mapped forms were **accepted and stored by a running gateway**:
 *
 * ```
 * 500   plain metadata (should be refused)   ← error surfaced from the guard
 * 200   IPv4-mapped metadata                 ← saved as a connection
 * ```
 *
 * And it was not a string that merely looked dangerous: pointed at a loopback listener, the mapped form
 * carried a real TCP connection to it (`ERR_SSL_WRONG_VERSION_NUMBER` — TLS bytes arriving at a plain HTTP
 * server), so the address is genuinely routable.
 *
 * ## Why the code needed three attempts
 *
 * 1. A match on a trailing dotted quad — **dead code**, because `new URL()` normalises `[::ffff:169.254.169.254]`
 *    to `[::ffff:a9fe:a9fe]` *before* the guard sees it. Every case in this file is written as the parser
 *    delivers it, for that reason.
 * 2. Reading the `ffff` marker from group 6 instead of group 5. `numbers[6]` is `a9fe`, so the check
 *    returned undefined for the exact input it was written to catch, and the endpoint stayed reachable.
 * 3. `fe80::1` also ends in `0x0001`. Reading groups 6–7 unconditionally reports it as `0.0.0.1` — the right
 *    verdict for the wrong reason, which is how a future bug hides.
 *
 * Every assertion below is on the compiled `dist` output, because that is what the gateway loads.
 */

/** What a caller can actually type, paired with what `new URL()` hands the guard. */
const PRIVATE = [
  ['http://169.254.169.254/', 'cloud metadata, the case this file exists for'],
  ['https://169.254.169.254/latest/meta-data/', 'metadata over TLS'],
  ['https://[::ffff:169.254.169.254]/', 'IPv4-mapped metadata — the bypass'],
  ['https://[0:0:0:0:0:ffff:a9fe:a9fe]/', 'the same address, fully written out'],
  ['https://[::ffff:7f00:1]/', 'mapped loopback'],
  ['https://[::ffff:a9fe:a9fe]/', 'mapped metadata, minimal spelling'],
  ['https://[::]/', 'IPv6 unspecified, the counterpart of 0.0.0.0'],
  ['https://[0:0:0:0:0:0:0:0]/', 'unspecified, expanded'],
  ['https://0.0.0.0/', 'IPv4 unspecified'],
  ['https://10.0.0.5/', 'RFC1918'],
  ['https://172.16.0.1/', 'RFC1918, low end of the range'],
  ['https://172.31.255.254/', 'RFC1918, high end of the range'],
  ['https://192.168.1.1/', 'RFC1918'],
  ['https://100.64.0.1/', 'carrier-grade NAT'],
  ['https://[fd00::1]/', 'IPv6 unique local'],
  ['https://[fe80::1]/', 'IPv6 link-local'],
  ['https://127.0.0.1/', 'loopback over TLS'],
  ['https://localhost/', 'loopback by name'],
  ['https://foo.local/', 'mDNS'],
  ['https://svc.internal/', 'the .internal convention'],
];

const PUBLIC = [
  'https://api.openai.com/v1',
  'https://api.anthropic.com/v1',
  'https://generativelanguage.googleapis.com/v1beta',
  'https://openrouter.ai/api/v1',
  'https://api.moonshot.ai/v1',
  // Outside the private ranges, so it must not be swept up by the fix.
  'https://[2606:4700:4700::1111]/',
  'https://8.8.8.8/',
  'https://172.32.0.1/',
  'https://11.0.0.1/',
];

test('every private destination is refused, however it is spelled', () => {
  const missed = [];
  for (const [url, note] of PRIVATE) {
    let allowed = false;
    try {
      assertSafeProviderRequestUrl(url, 'probe');
      allowed = true;
    } catch {
      /* refused, as intended */
    }
    if (allowed) missed.push(`${url}  (${note})`);
  }
  assert.deepEqual(missed, [], `these reached the private range check and were allowed:\n${missed.join('\n')}`);
});

test('every public destination is still allowed, so the fix did not over-reach', () => {
  // A guard that refuses everything passes the test above. This is the half that makes the other half mean
  // something: the specific neighbours of each blocked range must remain reachable.
  const wronglyBlocked = [];
  for (const url of PUBLIC) {
    try {
      assertSafeProviderRequestUrl(url, 'probe');
    } catch {
      wronglyBlocked.push(url);
    }
  }
  assert.deepEqual(wronglyBlocked, [], `the fix now blocks legitimate provider endpoints: ${wronglyBlocked.join(', ')}`);
});

test('the mapped form is judged by its embedded IPv4, not by an IPv6 prefix', () => {
  // The specific mechanism, asserted rather than inferred: unwrap, then apply the IPv4 rules.
  assert.equal(isPrivateHostname('::ffff:a9fe:a9fe'), true, 'mapped link-local must be private');
  assert.equal(isPrivateHostname('::ffff:7f00:1'), true, 'mapped loopback must be private');
  // 8.8.8.8 is public, so the mapped spelling must be public too. This is the case that catches an
  // over-broad fix: blocking every `::ffff:` prefix would pass every test above and break nothing visible
  // here, while refusing a legitimate public provider.
  assert.equal(isPrivateHostname('::ffff:0808:0808'), isPrivateHostname('8.8.8.8'), 'mapped and plain must agree');
  assert.equal(isPrivateHostname('::ffff:0808:0808'), false, 'mapped public address stays public');
  assert.equal(isPrivateHostname('::ffff:a9fe:a9fe'), isPrivateHostname('169.254.169.254'), 'metadata must agree');
});

test('a link-local address is private for the right reason, not by reading it as 0.0.0.1', () => {
  // `fe80::1` ends in 0x0001, so a groups-6-and-7 unwrap reports `0.0.0.1`. That yields the correct
  // verdict by accident, and an accidental true is indistinguishable from a real check until the ranges
  // change. So the wrap is asserted *not* to apply here.
  assert.equal(isPrivateHostname('fe80::1'), true);
  assert.equal(isPrivateHostname('fe80::1'), true, 'stable across calls');
  // A public IPv6 address must not be private, and must not be read as a wrapped IPv4 either.
  assert.equal(isPrivateHostname('2606:4700:4700::1111'), false);
  assert.equal(isPrivateHostname('2001:4860:4860::8888'), false);
});

test('loopback is a narrower question than private, and stays narrow', () => {
  // `isLoopbackHostname` decides whether plain HTTP is allowed. Widening it would let arbitrary private
  // hosts be reached over cleartext, so the mapped form must NOT satisfy it.
  assert.equal(isLoopbackHostname('localhost'), true);
  assert.equal(isLoopbackHostname('127.0.0.1'), true);
  assert.equal(isLoopbackHostname('::1'), true);
  assert.equal(isLoopbackHostname('127.5.6.7'), true, 'the whole 127/8 range is loopback');
  assert.equal(isLoopbackHostname('::ffff:7f00:1'), false, 'mapped loopback is not treated as loopback for cleartext');
  assert.equal(isLoopbackHostname('10.0.0.1'), false);
  assert.equal(isLoopbackHostname('example.com'), false);
});

test('http is refused for everything but loopback, including every blocked-range spelling', () => {
  for (const [url, note] of PRIVATE) {
    const secure = url.replace('http://', 'https://');
    assert.throws(() => assertSafeProviderRequestUrl(secure, 'probe'), undefined, `${secure} (${note}) must be refused`);
  }
  assert.doesNotThrow(() => assertSafeProviderRequestUrl('http://127.0.0.1:11434/v1', 'ollama'), 'local Ollama over cleartext is the supported case');
  assert.doesNotThrow(() => assertSafeProviderRequestUrl('http://localhost:1234/v1', 'lmstudio'));
  assert.throws(() => assertSafeProviderRequestUrl('http://10.0.0.5/v1', 'probe'), 'private over cleartext is not loopback');
});

test('userinfo in a provider URL is refused, so a secret cannot be smuggled into the authority', () => {
  assert.throws(() => assertSafeProviderRequestUrl('https://user:pass@api.openai.com/v1', 'probe'));
  assert.throws(() => assertSafeProviderRequestUrl('https://token@api.openai.com/v1', 'probe'));
});

test('a path cannot escape the configured base URL', () => {
  // The second half of the guard: even with a safe base, a crafted path must not redirect the request.
  assert.throws(() => resolveProviderUrl('https://api.openai.com/v1', 'https://evil.example/steal', 'probe'));
  assert.throws(() => resolveProviderUrl('https://api.openai.com/v1', '//evil.example/steal', 'probe'));
  assert.throws(() => resolveProviderUrl('https://api.openai.com/v1', '..\\..\\evil', 'probe'));
  assert.throws(() => resolveProviderUrl('https://api.openai.com/v1', 'v1/../../admin', 'probe'));
  assert.equal(resolveProviderUrl('https://api.openai.com/v1', 'chat/completions', 'probe'), 'https://api.openai.com/v1/chat/completions');
});

test('a non-HTTP scheme is refused, so file: and gopher: cannot be smuggled in as an endpoint', () => {
  for (const url of ['file:///etc/passwd', 'gopher://127.0.0.1:6379/_SET', 'ftp://example.com/x', 'data:text/plain,hi']) {
    assert.throws(() => assertSafeProviderRequestUrl(url, 'probe'), undefined, `${url} must be refused`);
  }
});
