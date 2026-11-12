import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySkillStore, ProviderRegistry } from '../dist/src/core/index.js';
import { InMemoryApiKeyStore, InMemoryConnectionStore, GatewayService, createGatewayServer } from '../dist/src/index.js';

async function gateway() {
  const store = new InMemoryConnectionStore();
  const keys = new InMemoryApiKeyStore();
  const key = (await keys.create('skills')).key;
  const skills = new InMemorySkillStore();
  const registry = new ProviderRegistry();
  const service = new GatewayService(registry, store, store, keys, { skills });
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, key, skills,
    close: () => new Promise((resolve) => server.close(resolve)),
    call: (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...(init.headers ?? {}) } }),
  };
}

test('skills CRUD round-trips', async (t) => {
  const gw = await gateway();
  t.after(gw.close);
  const created = await gw.call('/v1/skills', { method: 'POST', body: JSON.stringify({ id: 'greet', name: 'Greet', content: 'say hi' }) });
  assert.equal(created.status, 201);
  const list = await gw.call('/v1/skills');
  assert.equal(list.status, 200);
  const body = await list.json();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].id, 'greet');
  const got = await gw.call('/v1/skills/greet');
  assert.equal(got.status, 200);
  const del = await gw.call('/v1/skills/greet', { method: 'DELETE' });
  assert.equal(del.status, 200);
  const missing = await gw.call('/v1/skills/greet');
  assert.equal(missing.status, 404);
});

test('skills route requires auth', async (t) => {
  const gw = await gateway();
  t.after(gw.close);
  const res = await fetch(`${gw.base}/v1/skills`);
  assert.equal(res.status, 401);
});
