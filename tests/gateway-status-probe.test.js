import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The dashboard's gateway probe must not call an authentication failure a refusal of the origin.
 *
 * A 403 means the gateway declined this page's origin. A 401 means the gateway is up and did not accept
 * this page's credentials (the dashboard token, or a missing sign-in). Both were labelled "Gateway refused
 * this page", so a stale dashboard token read as an origin problem and sent the user to the wrong fix.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const probe = readFileSync(join(ROOT, 'src/lib/useGatewayStatus.ts'), 'utf8');
const shell = readFileSync(join(ROOT, 'src/components/DashboardShell.tsx'), 'utf8');

test('the probe classifies a status through one function, not an inline check that mixes 401 with 403', () => {
  assert.match(probe, /export function problemForStatus\(status: number\): GatewayProblem/);
  assert.match(probe, /setProblem\(problemForStatus\(response\.status\)\)/);
  assert.doesNotMatch(probe, /status === 403 \|\| response\.status === 401/, 'a 401 must not be folded into refused');
});

test('403 is refused and 401 is unauthorized, and neither is the other', () => {
  const body = probe.slice(probe.indexOf('export function problemForStatus'));
  const fn = body.slice(0, body.indexOf('\n}') + 2);
  assert.match(fn, /status === 403\) return 'refused'/);
  assert.match(fn, /status === 401\) return 'unauthorized'/);
  assert.doesNotMatch(fn, /401\) return 'refused'/);
});

test('the sidebar says sign-in for an unauthorized gateway, not that the origin is refused', () => {
  assert.match(shell, /problem === 'unauthorized'\s*\?\s*'Gateway needs sign-in'/);
  assert.match(shell, /problem === 'refused'\s*\?\s*'Gateway refused this page'/);
});
