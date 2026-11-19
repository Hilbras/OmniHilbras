import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PROVIDER_REGISTRY } from '../Kernel/Tools/dist/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(ROOT, 'Kernel/API/src/routes/oauth.ts'), 'utf8');

/**
 * No provider is an alias of another today. Cline and ClinePass were, and are separate accounts now,
 * so each must serve its own start and session routes. A future shared card would be named here, which
 * is why this stays a map rather than being deleted.
 */
const SHARED_CONNECTION = {};

test('every provider whose own config says OAuth has its own sign-in route, or names the owner it shares', () => {
  const oauthIds = Object.entries(PROVIDER_REGISTRY).filter(([, row]) => row.auth === 'oauth').map(([id]) => id);
  assert.ok(oauthIds.length > 8, `only ${oauthIds.length} OAuth rows parsed; the guard would pass vacuously`);

  const missing = [];
  for (const id of oauthIds) {
    const owner = SHARED_CONNECTION[id];
    const routeId = owner ?? id;
    if (!source.includes(`/v1/oauth/${routeId}/start`)) missing.push(`${id} (expected /v1/oauth/${routeId}/start)`);
    if (!source.includes(`/v1/oauth/${routeId}/session/`)) missing.push(`${id} (expected /v1/oauth/${routeId}/session/)`);
  }
  assert.deepEqual(missing, [], `OAuth providers with no route surface: ${missing.join(', ')}`);
});

test('ClinePass has its own start, session and exchange routes rather than borrowing Cline’s', () => {
  for (const route of [
    "/v1/oauth/clinepass/start",
    "/v1/oauth/clinepass/session/",
    "/v1/oauth/clinepass/exchange",
  ]) {
    assert.ok(source.includes(route), `ClinePass is a separate provider but the gateway has no ${route}`);
  }
});

test('every OAuth route names a provider that owns a registry row', () => {
  const routes = [...source.matchAll(/\/v1\/oauth\/([a-z0-9-]+)\/start/g)].map((match) => match[1]);
  assert.ok(routes.length > 8, `only ${routes.length} OAuth start routes parsed; the guard would pass vacuously`);
  const ghosts = [...new Set(routes)].filter((id) => !PROVIDER_REGISTRY[id]);
  assert.deepEqual(ghosts, [], `OAuth routes for ids with no registry row: ${ghosts.join(', ')}`);
});
