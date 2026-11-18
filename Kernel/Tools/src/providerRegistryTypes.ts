/** A provider id's own configuration. One row per catalog card. */
export type ProviderRegistryRow = {
  id: string;
  name: string;
  baseUrl: string;
  /** The model catalog for this provider. Absent for browser-driven sessions with no API. */
  modelsUrl?: string;
  auth: 'api-key' | 'oauth' | 'none' | 'web';
  /** Wires this provider speaks. A list because some families serve several lanes. */
  formats: readonly ('openai' | 'claude' | 'gemini' | 'responses' | 'web')[];
  /** The account's own usage report, when the provider publishes one. */
  usageUrl?: string;
};
