// The gateway key the app uses for its own traffic.
//
// Since the database stopped holding usable keys, the app can no longer read
// one out to authenticate against itself (the dashboard's model test, the
// dashboard chat panel, the MITM proxy) or to hand one to a CLI tool config.
// This key is derived from the same per-install pepper instead: the app can
// always reproduce it, the database never stores it, and someone holding only
// the database cannot reproduce it either.
//
// It authenticates like any other gateway key (unrestricted, no access rules)
// and is deliberately not a row in apiKeys: it is not listed in the dashboard,
// it is not revocable from there, and it does not take part in the "first
// active key" fallbacks. Deleting the pepper invalidates it.
import crypto from "node:crypto";
import { getKeyPepper } from "./keyPepper.js";

const INTERNAL_KEY_LABEL = "omnihilbras-internal-key";

let cachedKey = null;

function deriveInternalKey() {
  const material = crypto
    .createHmac("sha256", getKeyPepper())
    .update(INTERNAL_KEY_LABEL)
    .digest("base64url");
  return `sk-int-${material}`;
}

/** The plaintext internal key. Same value for the whole life of the install. */
export function getInternalApiKey() {
  if (!cachedKey) cachedKey = deriveInternalKey();
  return cachedKey;
}

/** Whether the presented key is the internal one. */
export function isInternalApiKey(key) {
  if (!key || typeof key !== "string") return false;
  const expected = getInternalApiKey();
  if (key.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expected));
}
