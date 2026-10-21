/**
 * The display form of an API key.
 *
 * `sk-{machineId}-{keyId}-{crc}` is 53 characters: the first 8 are the
 * "sk-" prefix plus the head of the machine id, the last 4 are the tail of the
 * CRC. The key id — 24 characters of real entropy, the only part that makes
 * the key a secret — is dropped entirely, so the display form identifies a
 * key (same machine, same CRC tail) but cannot be used to authenticate: the
 * 4 surviving CRC characters are 16 bits of an HMAC over a value the reader
 * does not have.
 *
 * Two keys of one machine share the first 8 characters, which is why the tail
 * is kept: keys that differ in the CRC tail stay distinguishable.
 *
 * One rule, one place: the dashboard, the CLI and the usage tables all show
 * the key through this function.
 */
export function maskApiKey(key) {
  if (!key || typeof key !== "string") return null;
  const trimmed = key.trim();
  if (trimmed.length <= 12) return trimmed.charAt(0) + "***";
  // Keep the tail: keys sharing a machine-id prefix (team keys) must not collide.
  return trimmed.slice(0, 8) + "***" + trimmed.slice(-4);
}
