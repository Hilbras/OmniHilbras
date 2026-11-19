import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * ClinePass must show **its own tier**, on **its own connection**.
 *
 * The measured failure this file started from: signing into Cline exposed 436 Cline models and
 * `/v1/models` carried zero `cline-pass/…` ids. The tier shared Cline's connection, so it had no
 * stored record of its own, and the model list was built from stored records alone — the tier was
 * unreachable by any client even though the adapter could list it. The fix then was a live read of
 * the tier through Cline's credential. The user rejected the sharing itself: two providers with
 * different models must not be one card reading another's account. So the tier now has its own
 * connection, its own grant and its own imported catalog, and no cross-provider read exists.
 */

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

test('the model list reads each provider’s own stored catalog', () => {
  const catalog = read('../src/core/model-catalog.ts');
  assert.match(catalog, /connection\.modelIds\.map/, 'stored catalogs are what /v1/models serves');
  assert.doesNotMatch(
    catalog,
    /sharedCatalogProviders/,
    'a shared-provider live read would let one card serve another provider’s models again',
  );
});

test('ClinePass is not an alias of Cline', () => {
  const alias = read('../src/core/provider-alias.ts');
  assert.doesNotMatch(alias, /clinepass:\s*'cline'/, 'ClinePass must not read Cline’s credential');
  assert.doesNotMatch(alias, /sharedCatalogProviders/, 'there is no shared catalog to reconcile');
});

test('the ClinePass adapter filters the tier rather than returning Cline’s catalog', () => {
  const adapter = read('../../SDK/clinepass/adapter/index.ts');
  assert.match(adapter, /CLINE_PASS_MODEL_PREFIX/, 'the tier prefix must exist');
  assert.match(adapter, /startsWith\(CLINE_PASS_MODEL_PREFIX\)/, 'only tier ids may be returned');
});

test('the callback page tells the tab that opened it', () => {
  const routes = read('../src/routes/oauth.ts');
  // A redirect flow finishes on the callback page, so the dashboard tab is never told unless the page
  // messages it — which is why only the polled flows (Kiro) used to raise a notification.
  assert.match(routes, /omnihilbras:sign-in/, 'the callback page must post the sign-in outcome');
  assert.match(routes, /BroadcastChannel/, 'noopener pop-ups have no `window.opener`, so a channel is also needed');
  assert.match(routes, /clineCallbackPage\(outcome\.ok, outcome\.message, nonce, sessionId\)/, 'the session id must reach the page, beside the nonce the CSP names');
});

test('a ClinePass sign-in starts, polls and saves under its own provider id', () => {
  const routes = read('../src/routes/oauth.ts');
  assert.match(routes, /url\.pathname === '\/v1\/oauth\/clinepass\/start'/, 'no start route for the card');
  assert.match(routes, /startsWith\('\/v1\/oauth\/clinepass\/session\/'\)/, 'no session route for the card');
  assert.match(
    routes,
    /clinepass\/exchange[\s\S]{0,900}providerId: 'clinepass'/,
    'the exchange route must save the connection under clinepass, not cline',
  );
  const service = read('../src/core/service.ts');
  assert.match(service, /startClineSignIn\(providerId: 'cline' \| 'clinepass'/, 'the session must record its provider');
  assert.match(service, /providerId: session\.providerId \?\? 'cline'/, 'the callback must use the provider the session recorded');
});

test('saving a connection does not reconcile another provider’s catalog', () => {
  const service = read('../src/core/service.ts');
  assert.doesNotMatch(service, /ensureSharedCatalogConnections/, 'the shared-record migration must be gone');
  assert.match(
    service,
    /saveConnectionDetailed[\s\S]{0,1600}this\.connections\.save\(input, credential, signal, options\)/,
    'a save belongs to exactly one provider and its own record',
  );
});

test('the store round-trips `providers`, or it is dropped on the next load', () => {
  const store = read('../src/core/connections.ts');
  const occurrences = store.match(/providers/g) ?? [];
  assert.ok(occurrences.length >= 4, `providers must be accepted, normalized, built and parsed (saw ${occurrences.length})`);
  assert.match(store, /Array\.isArray\(value\.providers\)/, 'reading a record back must restore `providers`');
});
