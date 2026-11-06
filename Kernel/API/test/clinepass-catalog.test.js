import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * ClinePass must show **its own tier**, and be reachable at all.
 *
 * Measured failure: signing into Cline exposed 436 Cline models and `/v1/models` carried **zero**
 * `cline-pass/…` ids. The tier shares Cline's connection, so it has no stored record of its own — and
 * the model list was built from stored records alone. The tier was then unreachable by any client
 * even though the adapter could list it.
 */

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

test('the model list reads a shared provider’s catalog from its adapter', () => {
  const catalog = read('../src/core/model-catalog.ts');
  assert.match(
    catalog,
    /sharedCatalogProviders/,
    'listAll must merge the catalogs of providers that share another’s connection, or ClinePass is invisible in /v1/models',
  );
  assert.match(catalog, /sharedCatalogProviders\)/, 'the shared catalogs must actually be iterated');
  assert.match(catalog, /unavailable\.push/, 'a tier that could not be read must be named, not silently empty');
});

test('ClinePass shares Cline’s connection and has a catalog of its own', () => {
  const alias = read('../src/core/provider-alias.ts');
  assert.match(alias, /clinepass:\s*'cline'/, 'ClinePass must read Cline’s credential');
  assert.match(alias, /sharedCatalogProviders[\s\S]*clinepass:\s*'cline'/, 'ClinePass must be listed as having its own catalog');
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

test('a shared provider gets a connection of its own, so it can be routed', () => {
  const service = read('../src/core/service.ts');
  assert.match(service, /ensureSharedCatalogConnections/, 'saving a connection must reconcile shared providers');
  assert.match(
    service,
    /refreshConnectionModels[\s\S]{0,900}ensureSharedCatalogConnections/,
    'a model refresh must reconcile too, or an account signed in earlier never gets its tier',
  );
});

test('the credential lookup follows a shared record', () => {
  const manager = read('../src/core/connection-manager.ts');
  // Measured: routing skipped ClinePass as `no-models` and its page showed Cline's catalog, because the
  // only connection it could see was Cline's and nothing pointed from one to the other.
  assert.match(manager, /connection\.providers\?\.includes\(providerId\)/, 'firstWithCredentialFor must match a shared provider');
});

test('the store round-trips `providers`, or it is dropped on the next load', () => {
  const store = read('../src/core/connections.ts');
  const occurrences = store.match(/providers/g) ?? [];
  assert.ok(occurrences.length >= 4, `providers must be accepted, normalized, built and parsed (saw ${occurrences.length})`);
  assert.match(store, /Array\.isArray\(value\.providers\)/, 'reading a record back must restore `providers`');
});
