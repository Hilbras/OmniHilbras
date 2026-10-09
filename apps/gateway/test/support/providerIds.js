import { readdirSync } from 'node:fs';

/**
 * The provider ids, read from the SDK's provider folders.
 *
 * Each provider is a folder under `packages/omnihilbras-sdk/src/providers/`. The shared base
 * `openai-compatible` is a folder too, but it is a base that providers extend, not a provider, so it
 * is excluded here. An invariant test that asks "does this shared module name a provider?" uses this
 * list, so the list has to be the providers and nothing else.
 */
const SHARED_BASES = new Set(['openai-compatible']);

export function providerIds() {
  return readdirSync(new URL('../../../../packages/omnihilbras-sdk/src/providers/', import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !SHARED_BASES.has(entry.name))
    .map((entry) => entry.name);
}
