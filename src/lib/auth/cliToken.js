import { getConsistentMachineId } from "@/shared/utils/machineId";

/**
 * The local CLI token.
 *
 * A per-install secret that proves "this request came from a process on this
 * machine". It is minted from the machine id and a random secret stored in
 * `~/.omnihilbras/auth/cli-secret` (0600), so it cannot be derived from
 * anything an attacker can read.
 *
 * It lives here because two places need the *same* check, and one of them
 * previously only looked at whether the header was present — which made a
 * dummy header look like a trusted local request.
 */
export const CLI_TOKEN_HEADER = "x-9r-cli-token";
const CLI_TOKEN_SALT = "9r-cli-auth";

let cachedCliToken = null;

export async function getCliToken() {
  if (!cachedCliToken) cachedCliToken = await getConsistentMachineId(CLI_TOKEN_SALT);
  return cachedCliToken;
}

/**
 * Whether the request carries the *correct* CLI token.
 *
 * The value is compared, not the presence of the header: a request with
 * `x-9r-cli-token: anything` is not a local request.
 */
export async function hasValidCliToken(request) {
  const token = request?.headers?.get?.(CLI_TOKEN_HEADER);
  if (!token) return false;
  return token === (await getCliToken());
}
