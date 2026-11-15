/**
 * The `User-Agent` a provider gates on, per provider id.
 *
 * ## The measurement
 *
 * AgentRouter (`https://agentrouter.org/v1`) refuses every request with
 * `401 {"message":"UNAUTHENTICATED","type":"unauthorized_client_error"}` and the sentence
 * `unauthorized client detected, contact support for assistance at https://discord.gg/...` — and it
 * refuses **before it reads the key**: a valid key, a deliberately bogus one and no key at all produce
 * the byte-identical body. That is why the dashboard's Add-connection flow reported "Provider
 * authentication failed. UNAUTHENTICATED" and never saved, whatever was pasted in.
 *
 * The gate is the client identity. Measured against `GET https://agentrouter.org/v1/models` on
 * 2026-11-16, same deliberately-bogus bearer key throughout, changing only `User-Agent`:
 *
 * ```
 * curl/8.5.0                                    -> 401 unauthorized client detected   (refused before the key)
 * claude-cli/2.1.296 (external, cli)            -> 401 无效的令牌 (new_api_error)       (gate passed; the key was judged)
 * codex_cli_rs/0.159.2 (Mac OS 26.6.0; arm64)   -> same, gate passed
 * Cline/3.5.54                                  -> same, gate passed
 * opencode/1.18.34                              -> same, gate passed
 * ```
 *
 * Their relay accepts a short allowlist of coding-CLI fingerprints and refuses everything else; the
 * Discord invite in the refusal is their blocked-client support channel. Nothing in their own
 * documentation says so, which is why the table below records it rather than a link.
 *
 * ## What the gateway does, and what that is
 *
 * For `agentrouter` — and **only** for `agentrouter` — the gateway sends one of the fingerprints their
 * relay accepts, so the request reaches the key check at all.
 *
 * **This is impersonation of another vendor's client.** The identity sent is Claude Code's, a tool this
 * gateway is not, and the relay is deciding what to do with this traffic on the strength of a false
 * claim. It can start failing the moment they change the allowlist, or block an account for it, and
 * `OMNIHILBRAS_AGENTROUTER_USER_AGENT` (below) is the way out when that happens.
 *
 * ## Why per provider, never global
 *
 * Rewriting `User-Agent` for every provider would misattribute this gateway's traffic to another client
 * everywhere — in every other vendor's logs and rate-limit attribution — to work around one gate that
 * one provider imposes. A provider that is not in the table gets no header from this module and keeps the
 * transport's own identity, and there is a test that pins exactly that.
 *
 * `x-app: cli` goes with it because the third-party fixes carry both, and because the header is
 * harmless. It is **not** what opens the gate: measured in the same session, `x-app: cli` with a stock
 * `curl/8.5.0` `User-Agent` was refused with the byte-identical `unauthorized client detected` body that
 * `curl/8.5.0` alone gets, while the fingerprint above with the key left out passed the gate. A `node`
 * and an `OmniHilbras/1.0` `User-Agent` were refused too, which is the reason this file exists at all:
 * the transport's own identity is not on their list.
 */
type ClientIdentity = {
  /** Sent as `User-Agent`. */
  userAgent: string;
  /** Sent verbatim alongside it. */
  headers: Record<string, string>;
  /** The variable that replaces `userAgent`, for when the allowlist moves. */
  userAgentEnv: string;
};

const CLIENT_IDENTITIES: Readonly<Record<string, ClientIdentity>> = {
  agentrouter: {
    userAgent: 'claude-cli/2.1.296 (external, cli)',
    headers: { 'x-app': 'cli' },
    userAgentEnv: 'OMNIHILBRAS_AGENTROUTER_USER_AGENT',
  },
};

/**
 * The headers a provider's client-identity gate needs, or `undefined` when it needs none.
 *
 * `undefined` rather than `{}` on purpose: the caller passes the result into an adapter only when there
 * is one, so "this provider has no identity override" is a state the type carries rather than an empty
 * object every reader has to interpret.
 *
 * The environment is a parameter — as `loadGatewayConfig`'s is — so a test can state an override
 * without assigning to the process. A blank value counts as unset, so a variable exported as empty
 * string does not send an empty `User-Agent`.
 */
export function providerClientHeaders(
  providerId: string,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> | undefined {
  const identity = CLIENT_IDENTITIES[providerId];
  if (!identity) return undefined;
  const override = env[identity.userAgentEnv]?.trim();
  return { 'User-Agent': override || identity.userAgent, ...identity.headers };
}
