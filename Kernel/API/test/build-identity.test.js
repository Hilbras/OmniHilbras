import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { GatewayService, createGatewayServer } from '../dist/src/index.js';
import { InMemorySecretStore, ProviderRegistry } from '../dist/src/core/index.js';

/**
 * Which build is answering.
 *
 * Twice during the Codex work a change was reported as live while the gateway was still serving the
 * previous build, and nothing on screen could tell: `/health` answered with a service name and a
 * status and no version at all. Both discoveries cost a full diagnosis cycle and neither was visible
 * to the operator, only to the person who eventually noticed a behaviour that had not changed.
 *
 * A build identity is the smallest thing that makes that state visible, and it only helps if it is
 * on the calls people actually make — which is why it rides on `/health` and not only on the
 * admin-gated settings route.
 */

async function startServer(t) {
  const service = new GatewayService(new ProviderRegistry(), new InMemorySecretStore({}), undefined, undefined, {});
  service.setHealthInterval(0);
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('/health states which build is answering', async (t) => {
  const base = await startServer(t);
  const body = await (await fetch(`${base}/health`)).json();
  assert.ok(body.build, 'the health payload carries no build identity');
  assert.equal(typeof body.build.version, 'string', 'the build names no version');
  assert.ok(body.build.version.length > 0, 'the version is empty');
});

test('the build identity is the gateway package version, not a guess', async (t) => {
  const base = await startServer(t);
  const body = await (await fetch(`${base}/health`)).json();
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(body.build.version, manifest.version, 'the reported version is not the one in package.json');
});

test('a supplied commit is carried, and its absence is not invented', async (t) => {
  const base = await startServer(t);
  const body = await (await fetch(`${base}/health`)).json();
  // The default case: nothing was supplied, so nothing is claimed. An invented commit would be worse
  // than none, because it would look like provenance.
  assert.equal(body.build.commit, undefined, 'a commit was reported although none was supplied');
  assert.ok(body.build.startedAt, 'the build states no time the process started');
});

test('the connection list carries the build too, because that is the call the dashboard makes', async (t) => {
  // The sidebar already polls `/v1/connections` for reachability. Reading the build off that probe
  // is what makes the drift check free; a second call would have been a second thing to keep working.
  const base = await startServer(t);
  const response = await fetch(`${base}/v1/connections`);
  const body = await response.json();
  assert.ok(response.ok, 'the connection list did not answer, so nothing could be read from it');
  assert.ok(body.build?.version, 'the connection list carries no build, so the probe learns nothing');
});

test('the dashboard compares the two, and only claims a mismatch when it can see both', () => {
  const shell = readFileSync(new URL('../../../src/components/DashboardShell.tsx', import.meta.url), 'utf8');
  const status = readFileSync(new URL('../../../src/lib/useGatewayStatus.ts', import.meta.url), 'utf8');
  assert.match(shell, /staleBuild/, 'the sidebar never decides whether the build is stale');
  assert.match(shell, /PAGE_VERSION/, 'the sidebar never states which build the page is');
  assert.match(shell, /restart the gateway/, 'a stale build gives no instruction, so the reader does not know what to do');
  // `unknown` on either side is silence, not agreement. Treating silence as a match is the same
  // mistake as reporting no version at all.
  assert.match(shell, /buildVersion !== 'unknown'/, 'an unknown gateway version is treated as matching');
  assert.match(status, /build\?: \{ version\?: unknown \}/, 'the probe never reads a version off the response it already fetches');
});

test('the page version cannot take the dashboard down when it is unavailable', () => {
  // Found by breaking it: the first attempt read a build-time `define` global directly, and a dev
  // server started before the define existed left the identifier undefined — the sidebar threw, and
  // the dashboard was a blank page over a value used only for a comparison.
  const shell = readFileSync(new URL('../../../src/components/DashboardShell.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(shell, /__OMNIHILBRAS_VERSION__/, 'a component reads a raw injected global instead of the guarded module');
  // The version arrives from a virtual module rather than a define, because a define is not
  // substituted into a dev-served source module — which is precisely where a stale gateway is most
  // likely, so a check that only worked in a production build would check the wrong case.
  const pageVersion = readFileSync(new URL('../../../src/lib/pageVersion.ts', import.meta.url), 'utf8');
  assert.match(pageVersion, /virtual:omnihilbras-version/, 'the page version does not come from the resolved module');
  assert.match(pageVersion, /'unknown'/, 'there is no fallback when the version is unavailable');
  const vite = readFileSync(new URL('../../../vite.config.ts', import.meta.url), 'utf8');
  assert.match(vite, /function repoVersion\(\): Plugin/, 'the virtual module plugin is gone');
});

test('the version is served from a resolved module rather than read out of package.json', () => {
  const vite = readFileSync(new URL('../../../vite.config.ts', import.meta.url), 'utf8');
  // `package.json` is not in the browser module graph, so an import would fail the build rather than
  // merely being untidy. Resolving it as a virtual module is what makes it available at all.
  assert.match(vite, /JSON\.stringify\(readRepoVersion\(\)\)/, 'the served version is not a string literal');
});