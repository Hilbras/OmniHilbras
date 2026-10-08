/**
 * Providers that share another provider's stored credential.
 *
 * ## Why this exists
 *
 * Two cards can be one account. `cline` and `clinepass` are that case: Cline's own auth registry
 * registers `cline-pass` as an **alias** of the `cline` handler (`storageProviderId: "cline"`), reusing
 * the identical stored credential, and its client signs in once for both. Our cards mirror that — the
 * ClinePass card is signed into by signing into Cline — so a request made for `clinepass` has to use the
 * credential the `cline` connection stores.
 *
 * The gateway had **no** cross-provider credential lookup before this: every request resolves only its
 * own provider's first credentialed connection, plus an environment fallback under the same id. This is
 * the one deliberate exception, and it is a named map rather than a special case inside the resolver so
 * there is exactly one place to read what the aliases are.
 *
 * ## What it is not
 *
 * It does not merge the two providers. They keep separate cards, separate ids on the request path, and
 * separate model lists; only the credential is shared. A provider that merely *resembles* another — the
 * `kimi` API key versus the `kimi-code` subscription token, or `anthropic` versus `claude-code` — is a
 * different account and must **not** be listed here.
 */
const providerAliases: Readonly<Record<string, string>> = {
  // ClinePass reads Cline's connection. See the module comment, and `clinepass.ts` in the SDK.
  clinepass: 'cline',
};

/** The provider whose credential this one uses, or `undefined` when it uses its own. */
export function providerAlias(providerId: string): string | undefined {
  return providerAliases[providerId];
}
