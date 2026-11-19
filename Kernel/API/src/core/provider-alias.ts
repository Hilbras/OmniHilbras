/**
 * Providers that share another provider's stored credential.
 *
 * ## Why the mechanism exists, and why it is empty
 *
 * Two cards can be one account. When that is true, a request made for the second card has to use the
 * credential the first one stores, and this map is the one place that says so: a named entry rather
 * than a special case inside the resolver.
 *
 * **No provider is an alias today.** Cline and ClinePass were the case, and they are not one any more:
 * ClinePass is a separate card with its own connection, its own sign-in (a separate WorkOS grant on
 * the same account) and its own `cline-pass/…` model tier. Reading Cline's credential made its card
 * show Cline's catalog and Cline's usage, which is precisely what a separate provider must not do.
 *
 * ## What it is not
 *
 * It does not merge two providers. They keep separate cards, separate ids on the request path, and
 * separate model lists; only the credential is shared. A provider that merely *resembles* another —
 * the `kimi` API key versus the `kimi-code` subscription token, or `anthropic` versus `claude-code` —
 * is a different account and must **not** be listed here.
 */
const providerAliases: Readonly<Record<string, string>> = {};

/** The provider whose credential this one uses, or `undefined` when it uses its own. */
export function providerAlias(providerId: string): string | undefined {
  return providerAliases[providerId];
}
