// The auth-method registry (AUTH_METHODS) carries ids only — the registry
// lives in shared constants and has no room for UI strings, so the labels and
// the icons the form needs are declared here.
export const AUTH_METHOD_LABELS = {
  oauth: "OAuth",
  apikey: "API Key",
  cookie: "Cookie",
};

export const AUTH_METHOD_ICONS = {
  oauth: "lock",
  apikey: "key",
  cookie: "cookie",
};

// OAuth has no credential to type: the sign-in flow creates the connection
// itself, so the form only collects a value for the other two methods.
export function usesCredential(authMethod) {
  return authMethod === "apikey" || authMethod === "cookie";
}

export function credentialLabel(authMethod) {
  return authMethod === "cookie" ? "Cookie Value" : "API Key";
}
