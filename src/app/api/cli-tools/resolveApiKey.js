/**
 * Resolves the API key to write into a CLI tool config.
 *
 * The key table holds no usable key any more — the dashboard shows the
 * display form of a key, and that is what a client sends back. A display form
 * cannot authenticate, so it is replaced by the app's own key, which the
 * server can always reproduce. A real key — one the user pasted — is used as
 * it is.
 *
 * The placeholder "sk_omnihilbras" is NEVER written; it was never a real key.
 */

import { getApiKeys } from "@/lib/db";
import { getInternalApiKey } from "@/lib/auth/internalKey";

/**
 * The display form of a key is the masked value the dashboard shows. The mask
 * marker never appears in a real key.
 * @param {string} value
 * @returns {Promise<boolean>}
 */
async function isDisplayForm(value) {
  if (value.includes("***")) return true;
  try {
    const keys = await getApiKeys();
    return keys.some((k) => k.key && k.key === value);
  } catch {
    return false;
  }
}

/**
 * @param {string|null|undefined} callerKey  Key sent by the frontend.
 * @returns {Promise<string>}
 */
export async function resolveCliApiKey(callerKey) {
  const candidate = (callerKey || "").trim();
  if (candidate && candidate !== "sk_omnihilbras" && !(await isDisplayForm(candidate))) {
    return candidate;
  }
  return getInternalApiKey();
}
