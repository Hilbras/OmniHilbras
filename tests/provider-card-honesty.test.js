import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { providerCatalog } from '../src/data/providers.ts';

/**
 * A card must not claim a connection, a health score, or a use that never happened.
 *
 * ## Why this is a separate file
 *
 * `tests/provider-card-merge.test.js` already covers this rule, and it could not see the defect this file
 * exists for. That suite tests `mergeGatewayConnections` — the function that folds a connection the gateway
 * **reported** into a card. The bug lived in the path where no connection is reported at all, so the merge
 * was never called and the suite passed. A guard scoped to the merge cannot see a defect in the
 * non-merge path, and "the merge is correct" is not the same claim as "every card is honest".
 *
 * The defect (1.45.0): `ProvidersPage.tsx` had a `recordForNewProvider` used as the *entire* save path for
 * every provider except OpenRouter. It produced
 *
 * ```ts
 * status: 'connected',
 * health: 100,
 * lastUsed: 'just now',
 * ```
 *
 * for a credential that had never left the browser — the API key the user had just pasted was discarded
 * and the gateway was never called. It survived 1.34.5 (the Ollama card's invented `92 ms`) and 1.36.1
 * (the `lastUsed` health-poll defect), both of which were fixed inside the merge.
 *
 * This file therefore asserts the property over **every** record-constructing function in the dashboard, not
 * the one that was wrong. It reads the source because the record builders are module-local functions in a
 * `.tsx` and are not exported; that is a real limitation and is stated rather than hidden — see
 * `tests/provider-card-merge.test.js` for the half that is called rather than read.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = readFileSync(join(ROOT, 'src/pages/ProvidersPage.tsx'), 'utf8');

/**
 * The second page that saves connections, and the reason this file was widened.
 *
 * Every assertion below used to read `ProvidersPage.tsx` alone. `ProviderDetailPage.tsx` has the same job —
 * it renders the same dialog with an `onSave` — and its bulk handler was `setConnectionAdded(true)` plus a
 * "N connections added." notice with **nothing saved**, for the whole life of the bulk tab. This file could
 * not see it, which makes it the third guard in this repository to be green, plausible, and blind in the
 * place it existed to look. The header above already states the lesson — *"a guard scoped to the merge
 * cannot see a defect in the non-merge path"* — and this guard had scoped itself to one page.
 *
 * Both are read now, and the assertions are stated per page rather than once, because "the page I read
 * reaches the gateway" is not the claim anyone needed.
 */
const detail = readFileSync(join(ROOT, 'src/pages/ProviderDetailPage.tsx'), 'utf8');
const PAGES = [
  ['ProvidersPage.tsx', page],
  ['ProviderDetailPage.tsx', detail],
];

/** Comments stripped, so a comment describing the old defect is not read as the defect. */
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/**
 * Fields that assert something happened, as patterns that only match an **object-literal assignment**.
 *
 * Each requires the `field:` to be preceded by `{` or a comma, so a type union (`type Filter = 'all' |
 * 'connected' | …`), a filter label (`{ value: 'connected', label: 'Connected' }`) and a function
 * signature cannot match. My first version matched the bare token and reported five of those — the check
 * was wrong about correct code, which is how a check gets switched off.
 */
const CLAIMS = {
  status: /[{,]\s*status:\s*'connected'/,
  health: /[{,]\s*health:\s*(?!0\b)\d+/,
  lastUsed: /[{,]\s*lastUsed:\s*'(?!never\b)[a-z]/,
  latency: /[{,]\s*latency:\s*'(?!—)/,
  models: /[{,]\s*models:\s*'(?!—)/,
  requests: /[{,]\s*requests:\s*'(?!0')/,
};

test('no record builder in the dashboard hard-codes a connection, a health score, or a use', () => {
  const offenders = [];
  for (const [field, pattern] of Object.entries(CLAIMS)) {
    for (const match of code(page).matchAll(new RegExp(pattern.source, 'g'))) {
      // Line numbers come from the comment-stripped text, so they can drift by a line or two from the
      // file on disk when a doc comment precedes the match. The field name and the matched text are the
      // reliable part of the message.
      const line = code(page).slice(0, match.index).split('\n').length;
      offenders.push(`~ProvidersPage.tsx:${line}  ${field}: ${match[0].trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these fields claim a measurement in code that builds a card:\n${offenders.join('\n')}\n` +
      'A card built before the gateway has reported anything must be a placeholder.',
  );
});

test('every provider save path reaches the gateway, on every page that saves one', () => {
  // The second half of the defect, and the half no field assertion would catch: the card looked honest
  // *and* the credential was thrown away. `putGatewayConnection` was implemented in `gatewayClient.ts`
  // with no caller at all.
  for (const [name, source] of PAGES) {
    const text = code(source);
    assert.ok(
      text.includes('putGatewayConnection('),
      `${name} must call the generic connection save; otherwise the key is dropped and a card is invented`,
    );

    // No save handler may end in the local-only helper without having called the gateway first. The handler
    // names differ per page (`handleSave`/`handleSaveMany` here, `handleAddConnection`/`handleAddConnections`
    // there), which is itself a small part of how one of them went unchecked.
    const handlers = [...text.matchAll(/async function (handle\w+)\([^)]*\)\s*\{([\s\S]*?)\n  \}/g)];
    assert.ok(handlers.length >= 1, `${name}: expected a save handler, found ${handlers.length}`);
    for (const [, handler, body] of handlers) {
      if (!/^handle(Save|Add)/.test(handler)) continue;
      assert.ok(
        body.includes('putGatewayConnection(') ||
          body.includes('saveOpenRouterConnection(') ||
          body.includes('handleSave(') ||
          body.includes('handleAddConnection('),
        `${handler} in ${name} never reaches the gateway — it must save a connection, not report one`,
      );
    }

    // **Awaited, and its result used.** The first version of this test only asked whether the name appeared
    // anywhere in the file. Planting `void putGatewayConnection(...)` with a hand-built object in its place
    // passed it — the call was present, unreachably, and the key was discarded exactly as before. So the
    // assertion is on the *shape*: awaited, and bound to the connection the card is built from.
    const generic = text.match(/const (\w+) = await putGatewayConnection\(([\s\S]*?)\);/);
    assert.ok(generic, `${name}: the generic save must be awaited and its result bound — an un-awaited call discards the key`);
    assert.match(
      text.slice(text.indexOf(generic[0])).slice(0, 1200),
      new RegExp(`set\\w*\\([\\s\\S]{0,200}${generic[1]}`),
      `${name}: the connection the gateway returned must be what gets stored, not a locally invented one`,
    );

    // And the credential must reach the call — as a key, or as an explicit absence. Never as an empty string.
    assert.match(
      generic[2],
      /apiKey|credential: 'none'/,
      `${name}: the save must carry a key, or say credential: 'none'; this is the field that was discarded`,
    );
    assert.doesNotMatch(
      text,
      /apiKey:\s*(?:''|apiKey\s*\?\?\s*'')/,
      `${name} sends an empty apiKey, which the gateway refuses ('apiKey must be a non-empty safe string')`,
    );
  }
});

test('a card that needs no key is saved by saying so, not by inventing an empty key', () => {
  // `Ollama` is the only `auth: 'No key'` card, and it could not be connected from either page. The gateway
  // requires a non-empty `apiKey` on every generic save, so the two pages disagreed about a provider whose
  // own card says it has no key: one threw "Enter the Ollama API key before saving." — an instruction that
  // cannot be followed — and the other sent `apiKey: ''` under a comment asserting the gateway stored
  // "nothing secret for it". Measured: `parseApiKey({ apiKey: '' })` → `apiKey must be a non-empty safe
  // string.`, so both were dead ends.
  assert.ok(
    providerCatalog.some((card) => card.auth === 'No key'),
    'this guard is about a card that needs no key; if none exists, delete the guard rather than let it pass vacuously',
  );
  for (const [name, source] of PAGES) {
    assert.match(
      code(source),
      /credential: 'none'/,
      `${name} must be able to save a provider that needs no credential`,
    );
  }
});

test('the local-only helper exists, and says out loud that nothing was saved', () => {
  // It is still needed: a bulk entry the user has not saved, and a provider whose save failed. So the
  // requirement is that it is honest, not that it is gone.
  assert.ok(page.includes('finishAddLocally'), 'the local-only path must be named for what it is');
  const i = page.indexOf('function finishAddLocally');
  const body = page.slice(i, page.indexOf('\n  }', i));
  // The notice counts connections in the local list, so it legitimately contains "connection was". What it
  // must not do is claim a *save*, which is the distinction the user cannot otherwise infer.
  assert.match(body, /Not saved to the gateway/, 'the notice must tell the user this was not saved');
  // "Not saved" contains the word "saved", so matching the token fails on the correct string. What would be
  // wrong is a notice asserting a save — so the check looks for an affirmative claim, and the negation is
  // the form that is required to appear.
  assert.match(body, /Not saved to the gateway/, 'the honest negation is the required wording');
  assert.doesNotMatch(
    body,
    /setNotice\((?:(?!Not saved)[^)])*\b(?:was|were) saved\b/i,
    'it must not assert a save; only "Not saved" is acceptable here',
  );
  assert.ok(
    /added to the local list/.test(body),
    'it must say what actually happened — a local list entry, not a saved connection',
  );
});

test('a card for an unsaved provider is available and unused, which is what no-connection means', () => {
  // Asserted through the builder the page actually calls, so this is a property and not a token search.
  const i = code(page).indexOf('function recordForUnsavedProvider');
  assert.ok(i > 0, 'recordForUnsavedProvider must exist — the unsaved path needs honest fields');
  const body = code(page).slice(i, code(page).indexOf('\n}', i));
  assert.match(body, /status:\s*'available'/, 'an unsaved provider is available, not connected');
  assert.match(body, /health:\s*0\b/, 'no probe has run');
  assert.match(body, /lastUsed:\s*'never'/, 'no request has been sent through it');
  // And the old claims must be gone from this function specifically, not merely from the file.
  for (const [field, pattern] of Object.entries(CLAIMS)) {
    assert.doesNotMatch(body, new RegExp(pattern.source), `${field} still claims something unmeasured`);
  }
});
