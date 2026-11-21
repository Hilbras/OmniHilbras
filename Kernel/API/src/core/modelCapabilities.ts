import type { ToolCaps } from '@omnihilbras/tools';
import type { ConnectionRecord } from './connections.js';
import { bareModelFor, lookupModelId } from './routing.js';

/**
 * A per-model narrowing of the provider-level tool contract, when the catalog stated one.
 *
 * The provider row in `Kernel/Tools/src/caps.ts` stays authoritative: a model can refuse a capability
 * the provider offers, but a catalog that says `tools: true` cannot make a web session or a provider
 * with no function-calling wire serve tools. So only an explicit `false` narrows anything, and an
 * absent field is exactly the same as no opinion.
 *
 * The lookup tries the requested id first, then the bare id, then spelling-normalized forms of both.
 * That is the 9router full-id-then-stripped pattern, applied to the metadata the gateway already
 * stores — no new catalog schema, and no provider id in the algorithm.
 */
export function narrowedToolCaps(
  modelId: string,
  connection: Pick<ConnectionRecord, 'providerId' | 'modelMeta'> | undefined,
  providerCaps: ToolCaps,
): ToolCaps | undefined {
  const meta = connection?.modelMeta;
  if (!meta || !providerCaps.tools) return undefined;
  const bare = bareModelFor(modelId, connection!.providerId);
  const keys = [modelId, bare, lookupModelId(modelId), lookupModelId(bare)];
  for (const key of keys) {
    if (meta[key]?.cp?.tools === false) return { ...providerCaps, tools: false, toolChoice: [] };
  }
  return undefined;
}
