// How a model of the Basic Chat page is addressed to the gateway.
//
// The gateway routes on "<prefix>/<model>". A compatible provider is reached
// through the prefix of its node, every other provider through its id, and a
// catalogue that already carries its provider ("nous/stepfun/…") must not be
// prefixed twice.
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";

export function getModelPrefix(connection) {
  const provider = connection?.provider || "";
  const isCompatible = isOpenAICompatibleProvider(provider) || isAnthropicCompatibleProvider(provider);
  if (isCompatible) return connection?.providerSpecificData?.prefix || provider;
  return provider;
}

export function toRequestModel(prefix, modelId) {
  const id = (modelId || "").trim();
  if (!id) return "";
  return id.startsWith(`${prefix}/`) ? id : `${prefix}/${id}`;
}
