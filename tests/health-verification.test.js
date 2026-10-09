import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mergeGatewayConnections } from '../src/lib/providerCards.ts';

/**
 * A health verdict must say what it established.
 *
 * ## What was wrong, measured
 *
 * Two OpenCode connections both reported `healthy` while **no model on either could serve a single
 * request**:
 *
 * ```
 * opencode (Zen API key, 67 chars)   free  403 FreeTierError: free tier needs the OpenCode client
 *                                    paid  402 Insufficient account funds
 * opencode-console (OAuth, 39 chars) free  403 FreeTierError
 *                                    paid  400 Model is unavailable
 * ```
 *
 * The dashboard rendered that as **"Route health 100%"** on both cards.
 *
 * Neither adapter lied. Each asked the cheap question — is the credential accepted, is the catalog
 * readable — got yes, and returned `healthy`, which reads as *this route can serve traffic*. The
 * health poll runs every 60 seconds on every adapter, so a real completion per poll would be a real
 * bill every minute, and the SDK says so where that was decided:
 *
 * > A signed-in probe would cost a billable request on every health poll, so the credential is checked
 * > for presence and shape only.
 *
 * So the fix is not to make the check expensive. It is to stop the cheap check borrowing the expensive
 * check's word. `ProviderHealth.verified` is required, which is what makes it structural: a new adapter
 * cannot compile without choosing one.
 *
 * ## Why these are the properties
 *
 * The rule is not "these nine adapters are correct". It is **no consumer may present a credential check
 * as evidence about traffic** — checked across the tree and in the rendered label, so the twelfth
 * adapter and the second card both fail the same way the first did.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTERS = join(ROOT, 'packages/omnihilbras-sdk/src/providers');

/** Strips comments, because a doc comment naming `verified` is not a verdict using it. */
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('every adapter that answers a health check declares what it verified', () => {
  const files = readdirSync(ADAPTERS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => `${e.name}/index.ts`);
  const offenders = [];
  for (const file of files) {
    const source = code(readFileSync(join(ADAPTERS, file), 'utf8'));
    const start = source.search(/healthCheck\s*[:=(]/);
    if (start === -1) continue;
    // Only the method body. Counting `verified:` across the whole file passed a real defect: Kiro has
    // two verdicts, and deleting the scope from the first one left the second, so the count stayed at
    // one and the check was satisfied by a verdict belonging to a different branch. Found by planting.
    const body = source.slice(start);
    const verdicts = [...body.matchAll(/verified:\s*'([^']+)'/g)].map((match) => match[1]);
    const returns = [...body.matchAll(/status:\s*'(healthy|degraded|unavailable)'/g)].length;

    // **A health check that declares no scope is the defect, whether or not the counters disagree.**
    //
    // The counting rule alone is satisfied by `0 < 0`. A `healthCheck` whose status comes from a variable
    // — `const st = 'healthy'; return { status: st }` — contributes 0 literals to `returns` and 0 to
    // `verdicts`, so the comparison passed with no scope declared anywhere. Proven by planting exactly
    // that as a second `healthCheck`: `ℹ pass 5  ℹ fail 0`.
    //
    // The narrow slice above fixed the *scope* problem it was written for — a verdict in another branch
    // no longer counts for this one — and left this one, because both halves can be zero at once.
    if (returns > 0 && verdicts.length < returns) {
      offenders.push(`${file}: ${returns} verdict(s) returned, ${verdicts.length} scope(s) declared`);
    }
    // So the floor is stated directly: a check that runs and answers must say what it verified. Counting
    // how many literals a file happens to contain cannot establish that.
    if (verdicts.length === 0) {
      offenders.push(`${file}: a healthCheck declares no \`verified\` scope at all — every health answer must say whether it verified a credential or inference`);
    }
    for (const verdict of verdicts) {
      if (verdict !== 'credential' && verdict !== 'inference') offenders.push(`${file}: unknown scope '${verdict}'`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('no adapter claims it verified inference without completing a request', () => {
  // `inference` is reserved for a check that really sent something and read an answer back. None of
  // these do — they read a catalog or a session — so any that claimed it would be asserting a
  // stronger fact than it measured, which is the same overclaim pointed the other way.
  const files = readdirSync(ADAPTERS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => `${e.name}/index.ts`);
  const overclaiming = files.filter((file) => {
    const source = code(readFileSync(join(ADAPTERS, file), 'utf8'));
    return /healthCheck\s*[:=(]/.test(source) && /verified:\s*'inference'/.test(source);
  });
  assert.deepEqual(overclaiming, [], `${overclaiming.join(', ')} claim inference but send no request`);
});

test('the merge carries the scope, so the card can name what was checked', () => {
  // With no health poll there is nothing to name: the card keeps its catalog placeholders untouched.
  const catalog = [{ id: 'opencode', catalogId: 'opencode', health: 0, status: 'available', modelList: [] }];
  assert.equal(mergeGatewayConnections(catalog, [])[0].healthVerified, undefined, 'no poll, no scope');

  const connected = mergeGatewayConnections(
    catalog,
    [{ id: 'opencode', providerId: 'opencode', hasCredential: true, enabled: true, modelIds: ['m'], modelPolicy: 'all', endpoint: 'https://opencode.ai/zen/v1' }],
    {
      service: 'omnihilbras-gateway',
      status: 'ok',
      checkedAt: new Date().toISOString(),
      providers: [{ providerId: 'opencode', status: 'healthy', verified: 'credential', checkedAt: new Date().toISOString(), latencyMs: 1225 }],
    },
  )[0];
  assert.equal(connected.health, 100, 'the poll did report healthy');
  assert.equal(connected.healthVerified, 'credential', 'and the card is told that is all it established');
});

test('the card does not label a credential check as route health', () => {
  // The user-visible overclaim: "Route health 100%" beside a provider that cannot serve anything is
  // exactly the finding. The label has to follow the scope, so the claim is checked where it is read.
  const card = code(readFileSync(join(ROOT, 'src/components/ProviderCard.tsx'), 'utf8'));
  assert.doesNotMatch(card, />Route health</, 'an unconditional "Route health" label');
  assert.match(card, /healthVerified === 'inference' \? 'Route health' : 'Credential check'/, 'the label follows what was verified');
});

test('the client type requires the scope, so a report cannot omit it', () => {
  const client = readFileSync(join(ROOT, 'src/lib/gatewayClient.ts'), 'utf8');
  assert.match(client, /verified: 'credential' \| 'inference';/, 'GatewayProviderHealth.verified is required');
});