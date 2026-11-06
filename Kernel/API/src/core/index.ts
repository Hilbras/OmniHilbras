/**
 * The contract layer: what the gateway knows about a provider without knowing any provider.
 *
 * These were `core/` in the SDK package. They are not provider code — a provider imports none of them —
 * so they live with the only consumer that needs them: the gateway.
 */
export * from './provider-error.js';
export * from './modelFilters.js';
export * from './pricing.js';
export * from './provider-slugs.js';
export * from './registry.js';
export * from './secret-store.js';
export * from './tool-compress.js';
export * from './tool-messages.js';
export * from './types.js';

/**
 * Shared provider machinery, kept here because no provider owns it.
 *
 * `FetchHttpTransport`, the URL/SSRF guards and the header sanitiser used to be the SDK's `core/`. Every
 * provider now carries its **own copy** (so a provider is standalone), and the gateway needs one of them
 * for its own outbound calls and its destination check. Importing a random provider's copy would make
 * that provider load-bearing for the whole gateway, so the gateway keeps its own — same code, its own
 * copy, the same relationship every provider already has to it.
 */
export * from './transport.js';
export * from './url.js';
export * from './streaming.js';
export * from './bounded-map.js';
export * from './provider-error.js';
