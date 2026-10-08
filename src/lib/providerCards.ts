/**
 * Folding live gateway state into the catalog cards.
 *
 * ## Why this is a module and not part of the page
 *
 * It was in `ProvidersPage.tsx`, for the same reason `providerOptions` was in `AddProviderModal.tsx`:
 * the logic was in a `.tsx`, so the only way to check it was to read its text. It is pure — records in,
 * records out, no DOM — so it lives here and `tests/provider-card-merge.test.js` **calls** it.
 *
 * ## What it must never do
 *
 * The catalog is what a card shows when the gateway has no connection for that provider, so every value
 * in it is a placeholder. This function overlays the values that *are* measured — a connection's
 * endpoint and imported models, a health poll's latency and status — and it must not invent anything
 * else. Two fields did, and both looked like telemetry:
 *
 * ```ts
 * lastUsed: liveHealthy ? 'just now' : 'saved locally',   // ← health, not usage
 * // `requests` was never set at all, so a connected card showed a permanent `0`
 * ```
 *
 * **`'just now'` claims a user did something.** `liveHealthy` is a health poll: a provider nobody has
 * ever sent a request to, which answers a model listing, reports itself healthy and therefore displayed
 * **"just now"** under a heading about last use.
 *
 * **A permanent `0` is not a measurement either.** The gateway keeps no request counter at all — the
 * only `count()` in it belongs to browser locators — so there is no number to show and none to zero.
 *
 * Both now stay exactly what the catalog said: a placeholder. The fields that *are* measured are
 * untouched, and `tests/provider-card-merge.test.js` asserts the general property rather than a list of
 * today's fields: **with no connection and no health, the output equals the input**, and with a
 * connection, every field that changes must be traceable to something in the input.
 */

import type { ProviderRecord } from '../components/ProviderCard';
import type { GatewayConnection, GatewayHealth } from './gatewayClient';

export function mergeGatewayConnections(providers: ProviderRecord[], connections: GatewayConnection[], health?: GatewayHealth): ProviderRecord[] {
  const connectionByProvider = new Map(connections.map((connection) => [connection.providerId, connection]));
  const healthByProvider = new Map(health?.providers.map((provider) => [provider.providerId, provider]));
  return providers.map((provider) => {
    // `connectionProviderId` first: a card that shares another card's account (`clinepass` reads
    // `cline`'s one connection) names its owner there. Otherwise a card's own id, or the catalog id it
    // was written under. Getting this wrong is silent — the card simply keeps its placeholders and reads
    // as unconnected — so the field is what makes sharing a deliberate statement rather than a guess.
    const connection = connectionByProvider.get(provider.connectionProviderId ?? provider.catalogId ?? provider.id);
    // No connection: the card keeps the catalog's placeholders, untouched. Not "reset to defaults" —
    // untouched, so there is no path by which a value from a previous merge survives a disconnect.
    if (!connection) return provider;
    const providerHealth = healthByProvider.get(connection.providerId);
    const liveHealthy = providerHealth?.status === 'healthy';
    const modelIds = connection.modelIds ?? [];
    return {
      ...provider,
      status: connection.hasCredential && connection.enabled && providerHealth?.status !== 'unavailable' && providerHealth?.status !== 'degraded' ? 'connected' : 'attention',
      endpoint: connection.endpoint,
      // Measured: the health poll's own reading, when there is one.
      latency: providerHealth?.latencyMs === undefined ? '—' : `${providerHealth.latencyMs} ms`,
      // Measured: the health poll's own verdict. Not a percentage of anything.
      health: liveHealthy ? 100 : 0,
      // What that verdict established, carried so the card can name it rather than imply it.
      // Every adapter checks its credential or its catalog, never a completed request — so this is
      // `credential`, and the card must not read as "this route can serve traffic".
      ...(providerHealth ? { healthVerified: providerHealth.verified } : {}),
      // Measured: the models the connection actually imported.
      models: modelIds.length > 0 ? `${modelIds.length} models · ${connection.modelPolicy === 'free' ? 'free import' : 'all import'}` : connection.hasCredential ? 'No imported models' : '—',
      modelList: modelIds,
      // `lastUsed` and `requests` are deliberately **not** set. Nothing in this gateway measures either
      // one, so the catalog's placeholders are the honest value. They used to be:
      //   lastUsed: liveHealthy ? 'just now' : 'saved locally'
      // which reported a health poll as if it were usage, and left `requests` a permanent `0` for a
      // counter that does not exist. If you add real usage tracking, set them here — and set them from
      // the tracking, not from health.
    } satisfies ProviderRecord;
  });
}
