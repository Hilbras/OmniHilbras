import type { ProviderRecord } from '../components/ProviderCard';

/**
 * The card a provider route shows when the id in the path is one no catalog entry matches.
 *
 * It lives here, away from `pages/ProviderDetailPage`, because the router needs it **before** the page can be
 * loaded: an `import { fallbackProvider } from './pages/ProviderDetailPage'` in `dashboardApp.tsx` pulls the whole
 * page module — and everything that page imports — into the initial dashboard chunk, which is exactly the weight
 * route-level lazy loading exists to remove. A four-line record is not worth 30 KB of first paint.
 *
 * Every field is a placeholder on purpose: this card describes a connection the operator has not made yet, so
 * it claims no measurement. `tests/provider-cards.test.js` holds the catalog to that rule; this is the same rule
 * one file over.
 */
export const fallbackProvider: ProviderRecord = {
  id: 'custom',
  name: 'Custom provider',
  description: 'An OpenAI-compatible provider connected to the local gateway.',
  category: 'Custom endpoint',
  group: 'custom',
  status: 'available',
  auth: 'API key',
  models: '—',
  latency: '—',
  requests: '0',
  lastUsed: 'never',
  health: 0,
  color: '#9c9584',
  initial: 'C',
  endpoint: 'http://localhost:8000/v1',
  modelList: [],
};
