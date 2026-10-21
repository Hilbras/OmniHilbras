import { AI_PROVIDERS } from "@/shared/constants/providers";

export function usesAwsCredentialForm(provider) {
  return AI_PROVIDERS[provider]?.credentialForm === "aws";
}

/**
 * The `providerSpecificData` fields a dashboard client may see.
 *
 * This is an **allow-list**, not a deny-list, because the object holds
 * credentials: GitHub's `copilotToken`, Kiro's IDC `clientSecret`, Xiaomi's
 * `mimoPassToken` and the AWS `sessionToken` all live there. A deny-list only
 * protects against the secrets somebody remembered to name — the next provider
 * that stores a credential in here would leak by default.
 *
 * Adding a field to this set is a deliberate act: check first that the value
 * is not a secret. Everything in here is an id, an endpoint, a flag, a region
 * or a timestamp — never a token, a secret, a cookie or a password.
 */
const SAFE_PROVIDER_SPECIFIC_FIELDS = new Set([
  // Connection shape
  "baseUrl",
  "base",
  "azureEndpoint",
  "apiVersion",
  "apiType",
  "deployment",
  "organization",
  "accountId",
  "region",
  "aiRegion",
  "userRegion",
  "projectId",
  "profileArn",
  "nodeName",
  "prefix",
  "uid",
  "username",
  "authMethod",
  "authKind",
  "resolvedAuthMethod",
  "scope",
  "scopes",
  "client_id",
  "clientId",
  "jwtExp",
  // Endpoints used by the provider-specific executors
  "inferenceBaseUrl",
  "effectiveBaseUrl",
  "apiServerUrl",
  "authBaseUrl",
  "startUrl",
  "tokenEndpoint",
  "kimchiEndpoint",
  "vercelRelayUrl",
  "thAuthBaseUrl",
  // Account / tenant identity
  "orgId",
  "organizationId",
  "workspaceId",
  "principalId",
  "userId",
  "userIdentity",
  "userUniqueId",
  "webId",
  "bizUserId",
  "tenant",
  "systemId",
  "deviceId",
  "machineId",
  "thUserId",
  "agentId",
  "agentKeyId",
  "location",
  // Display identity (never a credential)
  "email",
  "thEmail",
  "firstName",
  "lastName",
  "login",
  "name",
  "provider",
  "providerLabel",
  "modelCount",
  // GitHub Copilot
  "githubLogin",
  "githubName",
  "githubEmail",
  "githubUserId",
  "chatgptAccountId",
  "chatgptPlanType",
  "copilotTokenExpiresAt",
  // Xiaomi
  "mimoUserId",
  "mimoCUserId",
  // AWS (the secret itself is never included)
  "accessKeyId",
  "profile",
  // Local routing
  "enabledModels",
  "customModels",
  "proxyPoolId",
  "connectionProxyEnabled",
  "connectionProxyUrl",
  "connectionNoProxy",
  "connectionProxyPoolId",
  "strictProxy",
  // Feature flags and provider quirks
  "ghostMode",
  "kiroToolCallRepair",
  "hasGrokCodeAccess",
  "subscriptionTier",
  "appLanguage",
  "appVersion",
  "defaultAppVersion",
  // Timestamps
  "expiresAt",
  "expireTime",
  "lastRefreshAt",
]);

/**
 * Strip the credentials from a provider connection before it is sent to a
 * client.
 *
 * The top-level credential fields go, and `providerSpecificData` is reduced to
 * the allow-list above. The merge convention on update is preserved by the
 * caller: the update route spreads the *stored* object under the incoming one,
 * so a field that is absent from the response stays untouched on disk
 * ("empty means keep, null means delete").
 */
export function toProviderConnectionResponse(connection) {
  const { apiKey, accessToken, refreshToken, idToken, ...safe } = connection;

  if (!connection.providerSpecificData) return safe;

  const providerSpecificData = {};
  for (const [key, value] of Object.entries(connection.providerSpecificData)) {
    if (!SAFE_PROVIDER_SPECIFIC_FIELDS.has(key)) continue;
    providerSpecificData[key] = value;
  }

  return { ...safe, providerSpecificData };
}
