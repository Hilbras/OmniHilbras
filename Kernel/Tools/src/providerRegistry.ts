import { PROVIDER_MANIFESTS } from '@omnihilbras/sdk-shared/provider-manifests';
import type { ProviderRegistryRow } from './providerRegistryTypes.js';

/**
 * One registry row per catalog provider id, projected from the same manifest the card and capability
 * row read.
 *
 * This used to be a hand-maintained table generated from `src/data/providers.ts`, with a guard for a
 * card without a row and a row without a card. V4 moved the row's fields — base URL, model URL, auth
 * mode, wire formats, usage URL — into the manifest. A provider now has one description; this file is
 * the gateway's view of it, not a second place to edit.
 */
export const PROVIDER_REGISTRY: Readonly<Record<string, ProviderRegistryRow>> = Object.freeze(
  Object.fromEntries(
    PROVIDER_MANIFESTS
      .filter((manifest) => manifest.catalog && manifest.baseUrl !== undefined && manifest.registryAuth !== undefined)
      .map((manifest) => [manifest.id, {
        id: manifest.id,
        name: manifest.name,
        baseUrl: manifest.baseUrl as string,
        ...(manifest.modelsUrl === undefined ? {} : { modelsUrl: manifest.modelsUrl }),
        auth: manifest.registryAuth as ProviderRegistryRow['auth'],
        formats: (manifest.formats ?? []) as ProviderRegistryRow['formats'],
        ...(manifest.usageUrl === undefined ? {} : { usageUrl: manifest.usageUrl }),
      } satisfies ProviderRegistryRow]),
  ),
);

export function providerRegistryRow(id: string): ProviderRegistryRow | undefined {
  return PROVIDER_REGISTRY[id];
}

export function providerRegistryIds(): readonly string[] {
  return Object.keys(PROVIDER_REGISTRY);
}
