/**
 * The batch test echoes back the exact model string it was asked to test —
 * "<providerAlias>/<modelId>". A model id may contain a slash itself
 * ("anthropic/claude-opus-4.7"), so the id is what is left after the known
 * provider prefix, not what follows the last slash.
 */
export { modelIdFromTestModel } from "@/shared/utils/modelIdFromTestModel";
