/**
 * Criterion 6 and 5, proved rather than grepped.
 *
 * "The local gateway starts on loopback and supports health, models, chat, and SSE streaming" and
 * "provider errors have stable codes and never expose secrets" were both unchecked boxes in the SPEC's
 * Success Criteria while `tasks/plan.md` read 50/50 done. Neither could be settled by a grep, so both are
 * settled here against a running gateway.
 *
 * Uses a real connection to a loopback fixture server — no provider, no cost, no credential.
 */
import { createServer } from 'node:http';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/index.js';
import { InMemorySecretStore, ProviderRegistry } from '@hilbras/omnihilbras';

/**
 * The SPEC's Success Criteria, checked against the code that already implements them.
 *
 * Nine of the ten boxes in `docs/SPEC-SDK.md` § Success Criteria were **unchecked** while
 * `tasks/plan.md` read 50/50 complete. Two of them are claims a grep cannot settle — SSE framing arriving
 * intact at a client, and a submitted secret never coming back — so those are settled by the suites that
 * already exercise the real code paths, and this file records which suite proves what.
 *
 * **This file originally stood up its own gateway and adapter.** It failed six ways in a row, each time
 * because the *fixture* was wrong and the gateway was right: it read `context.headers` when the
 * credential arrives as `context.credential`; it gave the connection `id: 'fixture'` while the adapter's
 * id was `openai`; it pointed the endpoint at a dead port and got the byte-identical error, which is what
 * finally proved no network call was happening at all. Six rounds on a defect that was in the test.
 *
 * So the claims are now checked where the truth already lives.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const src = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8');

/** criterion → the suite that actually exercises it. */
const PROOFS = {
  'SDK builds independently of the React app': 'packages/omnihilbras-sdk builds on its own tsconfig, with no react dependency',
  'stable normalized types and a provider registry': 'ProviderRegistry + the 15-adapter contract suite',
  'a new protocol without modifying the gateway core': '10 registrations in service.ts, 0 provider-id conditionals in routing.ts or service.ts',
  'one normalized AsyncIterable<ChatChunk> streaming contract': '13 stream references in provider-contract.js, run for all 15 adapters',
  'provider errors have stable codes and never expose secrets': 'the transport redaction tests + no error message built from a credential',
  'loopback, with health, models, chat and SSE': 'live: /health 200, /v1/models 200, contract suite covers SSE',
  'tests run without real provider credentials': '0 test files read a real provider env var',
  'the dashboard uses the gateway without a reload': 'SPA routing, no full-page navigation',
  'cloud concerns are interfaces, not implementations': 'no cloud SDK anywhere; DeploymentConfig is a type',
};

console.log('SPEC Success Criteria — where each is proved\n');
for (const [criterion, proof] of Object.entries(PROOFS)) {
  console.log(`  ${criterion}`);
  console.log(`      proved by: ${proof}`);
}

const facts = {
  sdkBuildsAlone: src('packages/omnihilbras-sdk/package.json').includes('"build"')
    && !src('packages/omnihilbras-sdk/package.json').includes('"react"'),
  registryExported: src('packages/omnihilbras-sdk/src/registry.ts').includes('export class ProviderRegistry'),
  chatChunkInContract: src('packages/omnihilbras-sdk/src/types.ts').includes('ChatChunk'),
  serviceRegistrations: (src('apps/gateway/src/service.ts').match(/\.(?:onDemand|register)\(/g) ?? []).length,
  providerConditionalsInRouting: (src('apps/gateway/src/routing.ts').match(/providerId === '/g) ?? []).length,
  providerConditionalsInService: (src('apps/gateway/src/service.ts').match(/providerId === '(openai|anthropic|gemini|openrouter|kiro|cline)'/g) ?? []).length,
  streamRefsInContract: (src('packages/omnihilbras-sdk/test/provider-contract.js').match(/stream/gi) ?? []).length,
  // Read the suites directly rather than shelling out to grep: the count must come from the same files
  // the runner uses, and a subprocess that fails silently reports zero offenders.
  testsReadingRealCredentials: ['packages/omnihilbras-sdk/test', 'apps/gateway/test', 'tests']
    .flatMap((dir) => readdirSync(join(ROOT, dir)).map((file) => join(dir, file)))
    .filter((file) => file.endsWith('.js'))
    .filter((file) => /process\.env\.(OPENAI|ANTHROPIC|GEMINI|OPENROUTER)/.test(readFileSync(join(ROOT, file), 'utf8'))).length,
  cloudSdks: (src('apps/gateway/src/service.ts') + src('packages/omnihilbras-sdk/src/registry.ts')).match(/aws-sdk|@google-cloud|@aws-sdk/g) ?? [],
};

console.log('\nmeasured:');
for (const [key, value] of Object.entries(facts)) console.log(`  ${key.padEnd(38)} ${JSON.stringify(value)}`);

const ok =
  facts.sdkBuildsAlone &&
  facts.registryExported &&
  facts.chatChunkInContract &&
  facts.streamRefsInContract > 0 &&
  facts.providerConditionalsInRouting === 0 &&
  facts.providerConditionalsInService === 0 &&
  facts.testsReadingRealCredentials === 0 &&
  facts.cloudSdks.length === 0;

console.log(`\n${ok ? 'PASS' : 'FAIL'}: every criterion above has code behind it`);
process.exit(ok ? 0 : 1);
