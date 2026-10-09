import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { localDeployment, isTrustedDashboard } from '../dist/runtime.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer, loadGatewayConfig, deploymentFrom } from '../dist/index.js';
import { LocalConnectionStore, InMemoryConnectionStore as MemoryStore } from '../dist/connections.js';
import { ProviderRegistry, InMemorySecretStore } from '@hilbras/omnihilbras';
import { providerIds } from './support/providerIds.js';

/**
 * The outer runtime — the last item in `tasks/plan.md`.
 *
 * These are not tests of behaviour that exists; they are tests that the boundary is **real**. An
 * interface nothing depends on is a comment with a semicolon, and the plan's own risk table carries
 * "local/cloud behavior diverges" as unmitigated precisely because there was nothing to check.
 */

// ── the four things the plan names ─────────────────────────────────────────

test('a local deployment is a named deployment, not a set of assumptions', () => {
  const deployment = localDeployment();
  assert.match(deployment.publicBaseUrl, /^https?:\/\//, 'a URL an OAuth callback can be built from');
  assert.ok(deployment.dataDir.length > 0, 'and somewhere for state to live');
  assert.ok(deployment.corsOrigins.length > 0);
  assert.equal(deployment.tenant.id, 'local', 'one explicit tenant rather than none');
  // Named, not a number nobody can read: a deployment that serves many tenants says so in a log
  // line without anyone having to look it up.
  assert.match(deployment.tenant.id, /^[a-z0-9-]+$/, 'and a tenant id that is safe to log');
});

test('a deployment is frozen, so a caller cannot change what the gateway believes about itself', () => {
  // `readonly` is a type and nothing at runtime — third time this project has been caught by that,
  // after a `ReadonlyMap` that was a real `Map` and a `readonly` scope that was a mutable object.
  const deployment = localDeployment();
  assert.throws(() => { 'use strict'; deployment.tenant.id = 'someone-elses'; }, 'a tenant that changes after construction would scope storage to the wrong owner');
  assert.throws(() => { 'use strict'; deployment.publicBaseUrl = 'https://elsewhere.invalid'; });
});

test('a deployment derived from a config says the same thing the config says', () => {
  // Two sources of truth about where state lives and who may reach the gateway would be exactly the
  // divergence the plan's risk table names, and it would be silent.
  const config = loadGatewayConfig({ OMNIHILBRAS_PORT: '9123', OMNIHILBRAS_HOST: '127.0.0.1' });
  const deployment = deploymentFrom(config);
  assert.equal(deployment.dataDir, config.dataDir, 'the same data directory');
  assert.deepEqual([...deployment.corsOrigins], config.corsOrigins, 'and the same allowed origins');
  assert.match(deployment.publicBaseUrl, new RegExp(`:${config.port}$`), 'with the port the config actually chose');
});

test('auth context says who is asking, and the gate asks it', () => {
  // This used to be a `trusted: boolean` threaded from the server to the route. A real and correct
  // decision, expressed as a value with no owner and no name — so nothing could ask *who*, and a
  // hosted gateway could not answer "may this reach the LLM surface without a key" differently.
  const tenant = { id: 'local' };
  assert.equal(isTrustedDashboard({ kind: 'dashboard', tenant }), true, 'a browser on this machine');
  assert.equal(isTrustedDashboard({ kind: 'api-key', tenant }), false, 'a key-carrying client is never exempt');
  assert.equal(isTrustedDashboard({ kind: 'system', tenant }), false, 'and the gateway is not exempt from its own gate');
});

// ── the boundary is used, not declared ─────────────────────────────────────

test('the gateway reports the deployment it was built with', () => {
  // If nothing read this, the interface would be a comment with a semicolon.
  const service = new GatewayService(new ProviderRegistry(), new InMemorySecretStore({}), new InMemoryConnectionStore(), new InMemoryApiKeyStore());
  assert.equal(service.deployment().tenant.id, 'local', 'and a gateway built with nothing says so');
});

test('a gateway built with no deployment still works, because the boundary is optional', () => {
  // The tax argument. A hosted boundary that every embedded caller had to satisfy would not be
  // optional, and would not be optional in practice either.
  const service = new GatewayService(new ProviderRegistry(), new InMemorySecretStore({}), new InMemoryConnectionStore(), new InMemoryApiKeyStore());
  assert.ok(service.deployment().publicBaseUrl, 'a usable default, not a null');
});

test('a supplied deployment is the one the gateway reports', () => {
  const supplied = localDeployment({ publicBaseUrl: 'https://gw.example.invalid', dataDir: '/tmp/state', tenant: { id: 'acme', label: 'Acme' } });
  const service = new GatewayService(new ProviderRegistry(), new InMemorySecretStore({}), new InMemoryConnectionStore(), new InMemoryApiKeyStore(), {}, supplied);
  assert.equal(service.deployment().tenant.id, 'acme', 'a caller can say who it is, and it is not guessed');
  assert.equal(service.deployment().publicBaseUrl, 'https://gw.example.invalid');
});

test('the two credential stores are named for what they key on, and are not confused', () => {
  // The finding: the SDK already exported a `SecretStore` keyed by *provider* and read-only, and the
  // gateway's is keyed by *connection* and writable. Two exported types, one name, different
  // arguments — so reading `SecretStore` in either package meant opening the other one to find out
  // which you had.
  const runtime = readFileSync(new URL('../src/runtime.ts', import.meta.url), 'utf8');
  assert.match(runtime, /export type ConnectionSecretStore/, 'the connection-keyed one is named for its key');
  assert.doesNotMatch(runtime.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''), /export type SecretStore/, 'and it does not take the colliding name');

  const connections = readFileSync(new URL('../src/connections.ts', import.meta.url), 'utf8');
  // The provider-keyed fallback is imported under a name that says which is which.
  assert.match(connections, /SecretStore as ProviderSecretStore/, 'the SDK one is aliased at its use site');
  // And the dead third shape is deprecated rather than left as a trap.
  assert.match(connections, /@deprecated Declared and never used/, 'the unused WritableSecretStore points elsewhere');
});

test('every local credential store satisfies the named interface', () => {
  // The check that makes the interface more than a declaration: a local store that stopped matching
  // would fail here rather than at some call site in a provider's refresh callback.
  for (const Store of [LocalConnectionStore, MemoryStore]) {
    const store = new Store({ directory: '/tmp/does-not-matter' });
    for (const method of ['get', 'set', 'delete']) {
      assert.equal(typeof store[method], 'function', `${Store.name} must implement ${method}`);
    }
  }
});

// ── the invariants ─────────────────────────────────────────────────────────

test('THE INVARIANT: the runtime names no provider', () => {
  const adapters = providerIds();
  const source = readFileSync(new URL('../src/runtime.ts', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const found = adapters.filter((id) => new RegExp("['\"`]" + id + "['\"`]").test(code));
  assert.deepEqual(found, [], `the runtime must name no provider, found: ${found.join(', ')}`);
});

test('THE BOUNDARY: no cloud infrastructure was written', () => {
  // The task said "represented by interfaces **without implementing cloud infrastructure**", and the
  // tempting way to fail that is to add a `RemoteSecretStore` that nobody uses. So this asserts the
  // absence, which is the part that is easy to do by accident and hard to notice afterwards.
  // Comments are stripped first, and that is the whole correction. My first version flagged three
  // files — every one of them because its *prose* said "remote" while explaining that no remote
  // implementation exists. A guard that cannot tell a comment from code will be turned off rather
  // than fixed, and then it guards nothing.
  const files = readdirSync(new URL('../src/', import.meta.url)).filter((file) => file.endsWith('.ts'));
  const offenders = files.filter((file) => {
    const code = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    return /\b(remote|tenantStore|CloudConfig)\b/i.test(code);
  });
  assert.deepEqual(offenders, [], `a cloud implementation crept in: ${offenders.join(', ')}`);
});

test('THE BOUNDARY: every type declared here is read by something', () => {
  // This file declared five exported types and the tests below exercised four of them by *behaviour*.
  // The fifth, `GatewayRuntime`, was asserted by nothing at all — it was a bundle of `deployment`,
  // `auth` and `secrets`, which are supplied to `GatewayService` as three separate arguments, so there
  // was no constructor that took it and no caller that passed it. It survived for two releases.
  //
  // The property worth keeping is not "this particular name is gone" — it is that an exported type in
  // the boundary file must be named by another *source* file. A name that appears only in its own
  // declaration, or only in prose about it, is a comment with a semicolon, and that is the exact
  // failure Task 10 exists to rule out.
  //
  // Tests are excluded deliberately: a test that imported an unused type would satisfy a weaker version
  // of this check and make the guard pass on a dead export.
  //
  // Scoped to `runtime.ts` on purpose, and that scope is a correction. My first version scanned every
  // source file in `src/` and failed on twelve types — `LocalApiKeyStoreOptions`, `FirstPartyContract`,
  // `CredentialLifecycleDeps` and so on — each of which is used inside its own file and none of which is
  // exported from the package barrel. A constructor-options type that appears in one constructor is
  // *working*, not dead; flagging it meant the guard would be disabled on its first honest run rather
  // than ever catching the thing it was written for.
  //
  // The distinction that survives: this checks the file that *defines the boundary*, where a type is a
  // claim about how a cloud deployment would be assembled, and a claim nothing reads is a promise to
  // nobody. `GatewayRuntime` was exactly that — a whole assembly described in one place and assemblable
  // in none.
  //
  // A type may also be read as *data* rather than by name, and `TenantContext` is. `server.ts` does not
  // say `TenantContext`; it writes `tenant: service.deployment().tenant` while building an
  // `AuthContext`, so the tenant reaches a real request path while the type's name appears in no other
  // file. Demanding a by-name reference would have flagged a working boundary as dead, so a type counts
  // as used when another source file either names it or carries its value. Both are checked below, and
  // `TenantContext` is named in the allowed list precisely so that this exemption stays deliberate
  // rather than becoming a loophole for the next type.
  const srcDir = new URL('../src/', import.meta.url);
  const boundaryFile = 'runtime.ts';
  const sources = readdirSync(srcDir).filter((f) => f.endsWith('.ts') && f !== boundaryFile);
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const boundaryCode = strip(readFileSync(new URL(boundaryFile, srcDir), 'utf8'));
  const declared = [...boundaryCode.matchAll(/export (?:type|interface) (\w+)/g)].map((m) => m[1]);

  // Read by value rather than by name, with the reading path spelled out so the exemption is auditable.
  const readByValue = {
    // `server.ts` assigns `deployment().tenant` into the AuthContext it hands to each request.
    TenantContext: 'server.ts',
  };

  const unreferenced = declared.filter((name) => !(name in readByValue) && !sources.some((other) => {
    const code = strip(readFileSync(new URL(other, srcDir), 'utf8'));
    return new RegExp(`\\b${name}\\b`).test(code);
  }));
  assert.deepEqual(unreferenced, [], `a declared-and-unused type came back: ${unreferenced.join(', ')}`);

  // And the general fact, asserted once so the scope above cannot quietly become "no scope at all".
  assert.ok(declared.includes('DeploymentConfig') && declared.includes('AuthContext') && declared.includes('ConnectionSecretStore'),
    'the three boundary types Task 10 asks for are still declared here');

  // The exemption is not a loophole: every entry must still be reachable, and each one names its reader.
  for (const [name, reader] of Object.entries(readByValue)) {
    assert.ok(declared.includes(name), `${name} is exempted but is no longer declared here`);
    assert.ok(sources.includes(reader), `${name} is exempted and names a file that no longer exists: ${reader}`);
    assert.ok(
      new RegExp(`\\b${name}\\b|\\.tenant\\b`).test(strip(readFileSync(new URL(reader, srcDir), 'utf8'))),
      `${name} is exempted but ${reader} no longer reads it`,
    );
  }
});
