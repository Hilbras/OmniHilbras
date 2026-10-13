import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { providerRoute, providerUsageRoute } from '../src/lib/routes.ts';

/**
 * A provider page's own Usage tab.
 *
 * Three things have to be true together, and each is a way this could be wrong on its own: the URL is a real
 * route (so it can be linked to and reloaded), the tab narrows the query to one provider, and the narrowing
 * follows the **connection** rather than the card — because a card that shares another provider's credential
 * records its usage under the owner's id, and would otherwise show an empty tab while its requests sat
 * somewhere else.
 */

const ROOT = new URL('..', import.meta.url);
const read = (file) => readFileSync(new URL(file, ROOT), 'utf8');

test('the usage tab is a sub-route of the provider page, so it can be linked to and reloaded', () => {
  assert.equal(providerRoute('opencode'), '/providers/opencode');
  assert.equal(providerUsageRoute('opencode'), '/providers/opencode/usage');
  // Ids are encoded, so a provider id with a character that means something in a path is one id, not two segments.
  assert.equal(providerUsageRoute('a/b'), '/providers/a%2Fb/usage');
});

test('the router serves both the provider page and its usage tab, from one component', () => {
  const app = read('src/dashboardApp.tsx');
  assert.match(app, /<Route path="\/providers\/:providerId" element=\{<ProviderRoute \/>\} \/>/, 'the provider page route is gone');
  assert.match(app, /<Route path="\/providers\/:providerId\/usage" element=\{<ProviderRoute \/>\} \/>/, 'the usage tab route is not served, so the URL 404s');
  // One component for both paths: the tab is read from the pathname, so the two tabs cannot drift apart.
  assert.match(app, /endsWith\('\/usage'\)/, 'the tab is no longer derived from the path, so a reload loses it');
});

test('the usage tab narrows the query to one provider, and drops the whole-catalog sections', () => {
  const page = read('src/pages/UsagePage.tsx');
  // The filter must be sent, or the tab shows every provider's usage under one provider's heading.
  assert.match(page, /\.\.\.\(providerId \? \{ provider: providerId \} : \{\}\)/, 'the provider is not sent to the gateway, so the tab shows all usage');
  assert.match(page, /providerId\?: string/, 'UsageContent no longer accepts a provider');
  // The by-provider chart is a single bar and the canvas is a whole-catalog diagram; both are wrong on one page.
  assert.match(page, /providerId \? null : \([\s\S]{0,200}?<ProviderBarChart/, 'the by-provider chart is no longer dropped for a single provider');
  assert.match(page, /providerId \? null : \([\s\S]{0,200}?aria-label="Provider connections"/, 'the provider canvas is no longer dropped for a single provider');
});

test('the tab follows the connection owner, so a shared-credential card is not empty', () => {
  const detail = read('src/pages/ProviderDetailPage.tsx');
  // `clinepass` shares Cline's connection, and the gateway records its usage under `cline`. Filtering by the
  // card's own id would show an empty tab while the requests sat under the owner.
  assert.match(
    detail,
    /<UsageContent providerId=\{provider\.connectionProviderId \?\? provider\.id\}/,
    'the usage tab filters by the card id rather than the connection owner, so a shared-credential card shows nothing',
  );
  assert.match(detail, /<UsageContent providerId=/, 'the provider page no longer renders the usage view on its tab');
});

test('both tabs are real links marked for assistive technology', () => {
  const detail = read('src/pages/ProviderDetailPage.tsx');
  assert.match(detail, /role="tablist"/, 'the tab strip lost its tablist role');
  assert.match(detail, /to=\{providerRoute\(provider\.id\)\}/, 'the Overview tab is not a real link');
  assert.match(detail, /to=\{providerUsageRoute\(provider\.id\)\}/, 'the Usage tab is not a real link');
  assert.match(detail, /aria-current=\{tab === 'usage' \? 'page' : undefined\}/, 'the active tab is not marked for assistive technology');
});