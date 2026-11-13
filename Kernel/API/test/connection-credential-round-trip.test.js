import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemorySecretStore, ProviderRegistry } from '../dist/src/core/index.js';
import {
  GatewayService,
  InMemoryApiKeyStore,
  LocalConnectionStore,
} from '../dist/src/index.js';

/**
 * Whatever the vault writes, the vault must be able to read — and a credential-free connection must
 * still be a connection after a restart.
 *
 * ## What this exists for
 *
 * `LocalConnectionStore.save` validated nothing and stored whatever it was handed; `parseCredentials`
 * required a non-empty string `value` *before* it looked at `type`, so `{ type: 'none' }` — a member of
 * `ProviderCredential` since the beginning, and what `CredentialManager` substitutes for a connection
 * with no secret — was written happily and then refused on the way back in.
 *
 * Two things made that worse than an ordinary mismatch:
 *
 * - **It was not contained.** `parseCredentials` is the loader and `list()` calls `ensureLoaded()`, so a
 *   single unreadable credential made *every* connection in the vault unreadable. The gateway did not
 *   lose one provider, it lost its connection list.
 * - **It was one-way.** Nothing could repair it from the outside: the file is encrypted under a key
 *   derived from the master key, so an operator could not edit the offending entry out.
 *
 * The property is stated over the variants rather than over the one that broke, so a fourth credential
 * type is covered the day it is added rather than the day it fails.
 */

const input = {
  id: 'keyless',
  providerId: 'keyless',
  name: 'Keyless provider',
  endpoint: 'https://duck.ai',
  priority: 1,
  proxyPool: 'none',
  modelIds: ['probe-model'],
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The field list is read from the declaration, not hand-written. A hand-written fixture only proves
 * the fields somebody remembered: `region` and `kiroAuthMethod` were added to the Kiro type and dropped
 * by the vault for releases while this test stayed green. Deriving the names means a newly declared
 * field automatically joins the fixture and fails the round trip until the writer learns about it.
 */
const OAUTH_SOURCE = readFileSync(join(ROOT, 'Kernel/API/src/core/types.ts'), 'utf8');
const oauthLine = OAUTH_SOURCE.split('\n').find((line) => line.includes("| { type: 'oauth'"));
assert.ok(oauthLine, 'the oauth variant of ProviderCredential could not be found to derive its fields');
const oauthFields = [...oauthLine.matchAll(/(\w+)\?:\s/g)]
  .map((match) => match[1])
  .filter((field) => field !== 'type' && field !== 'value');
assert.ok(oauthFields.length >= 10, `only ${oauthFields.length} oauth fields were derived; the parser is broken`);

const SPECIAL_OAUTH_VALUES = {
  expiresAt: '2030-01-01T00:00:00.000Z',
  email: 'someone@example.com',
  kiroLogin: 'social',
  kiroAuthMethod: 'idc',
  region: 'us-east-1',
};
const OAUTH_CREDENTIAL = { type: 'oauth', value: 'grant-value', refreshToken: 'refresh-value' };
for (const field of oauthFields) {
  if (field in OAUTH_CREDENTIAL) continue;
  OAUTH_CREDENTIAL[field] = SPECIAL_OAUTH_VALUES[field] ?? `${field}-value`;
}

const CREDENTIALS = [
  ['an API key', { type: 'api-key', value: 'sk-test-value' }],
  /**
   * The web client's own fingerprints, captured at sign-in. They are what a request carries to look
   * like the app's rather than a script's, so losing them silently would be the same defect class as
   * the OAuth fields that were dropped at save time: the vault writes them, so the vault must read
   * them back.
   */
  ['an API key with device fingerprints', {
    type: 'api-key',
    value: 'sk-test-value',
    deviceId: 'ef44ea36-8668-411b-b8d5-00b9258da899',
    shumeiDeviceId: 'Bd1YTsVuRejiwd4jEkzMCOasfEjPTv/nXJg2WK',
    did: 'fe0c7f8b-3269-482c-90d1-61396acd0576',
  }],
  ['an OAuth grant', OAUTH_CREDENTIAL],
  ['no credential at all', { type: 'none' }],
];

async function withStore(run) {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-credentials-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

for (const [label, credential] of CREDENTIALS) {
  test(`the vault reads back ${label}, after a restart`, async () => {
    await withStore(async (directory) => {
      const first = new LocalConnectionStore({ directory });
      await first.save(input, credential);

      // A new object, so nothing is served from the first store's memory: only what reached disk counts.
      const reopened = new LocalConnectionStore({ directory });
      const connection = (await reopened.list())[0];

      assert.equal(connection?.id, 'keyless', 'the connection survived the restart');
      assert.equal(connection?.hasCredential, true, 'a stored credential is a stored credential, whatever its type');
      assert.deepEqual(await reopened.get('keyless'), credential, 'the credential came back unchanged');
    });
  });
}

test('a keyless connection still serves a request after the gateway restarts', async () => {
  // The end of the story the mismatch caused: a connection that routed, then silently stopped, because
  // the loader had pruned its credential as an orphan on the way up.
  const registry = new ProviderRegistry();
  registry.register({
    id: 'keyless',
    name: 'Keyless provider',
    capabilities: { chat: true, streaming: false, models: true },
    async listModels() {
      return [{ id: 'probe-model', providerId: 'keyless' }];
    },
    async healthCheck() {
      return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 5, verified: 'credential' };
    },
    async validateCredential() {
      return {};
    },
    async chat(request) {
      return {
        id: 'resp-keyless',
        providerId: 'keyless',
        model: request.model,
        createdAt: new Date().toISOString(),
        message: { role: 'assistant', content: 'answered without a credential' },
        finishReason: 'stop',
      };
    },
    async *streamChat(request) {
      yield { id: 'chunk-keyless', providerId: 'keyless', model: request.model, delta: { content: 'answered without a credential' }, finishReason: 'stop' };
    },
  });

  const service = (store) => new GatewayService(registry, new InMemorySecretStore({}), store, new InMemoryApiKeyStore(), {});
  const ask = async (instance) => {
    try {
      const response = await instance.chat('keyless', { model: 'probe-model', messages: [{ role: 'user', content: 'hi' }] });
      return response?.message?.content;
    } catch (error) {
      return `refused: ${error?.message}`;
    }
  };

  await withStore(async (directory) => {
    const first = new LocalConnectionStore({ directory });
    await first.save(input, { type: 'none' });
    assert.equal(await ask(service(first)), 'answered without a credential', 'it routes before the restart');

    const reopened = new LocalConnectionStore({ directory });
    assert.equal(await ask(service(reopened)), 'answered without a credential', 'and it still routes after one');
  });
});

test('the writer refuses a credential the reader would refuse', async () => {
  // The other half of the same defect, and the half that made it reach disk. `save` validated nothing, so
  // it wrote a `{ type: 'none' }` this file's reader could not parse — and a `none` credential carrying a
  // secret is the one shape that must never be tolerated, because it makes "no credential" a label that
  // can hide one. Both are now refused at the point of writing rather than at the point of loading, where
  // the failure took the whole vault down with it.
  await withStore(async (directory) => {
    const store = new LocalConnectionStore({ directory });

    // `save` is async, so a refusal arrives as a rejected promise rather than a throw — which is how the
    // first version of this test passed while proving nothing.
    await assert.rejects(
      () => store.save(input, { type: 'none', value: 'smuggled' }),
      /none credential cannot carry a value/,
      'a none credential with a secret must not reach the vault',
    );
    await assert.rejects(
      () => store.save(input, { type: 'api-key', value: '' }),
      /needs a non-empty value/,
      'an empty API key must not reach the vault either',
    );
    await assert.rejects(
      () => store.save(input, { type: 'oauth', value: 'grant', oauthClientId: '' }),
      /oauthClientId must be a non-empty string/,
      'a declared field present but empty is a mistake, not an omission',
    );

    // Nothing was written, so the store is still empty and still readable.
    assert.deepEqual(await store.list(), []);
  });
});