/**
 * A provider-supplied URL, or `undefined` when it is not safe to navigate to.
 *
 * Sign-in URLs come from the provider's own response and are put into a tab that was opened as
 * `about:blank` — which inherits the dashboard's origin. A `javascript:` value there runs with the
 * dashboard's privileges, including access to the dev proxy that carries the gateway token. Only
 * `http:` and `https:` are navigation targets; everything else is refused rather than sanitised.
 */
export function safeProviderUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
