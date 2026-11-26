import { PROVIDER_MANIFESTS } from '@omnihilbras/sdk-shared/provider-manifests';
import type { ToolChoice } from './types.js';

/**
 * Which providers serve tools, and how far `tool_choice` can be pushed.
 *
 * ## Why one table in one package
 *
 * The alternative is 29 vendors of the same decision, each a `capabilities` field in a package that cannot see its
 * neighbours. That is how the state this table records came about: `anthropic/lib/types.ts` declared `toolChoice` and
 * no adapter code ever sent Anthropic's `tool_choice`; Gemini did not mention it at all; `codex` refused tools outright;
 * and the web adapters dropped them without a word. Nothing compared the claims, so nothing disagreed out loud.
 *
 * `tests/tools-caps.test.js` is what keeps this from being fiction: it drives every adapter with a scripted transport
 * and asserts the body the adapter actually built, so a row that says `required` is a row that was seen sending one.
 *
 * ## What the modes mean
 *
 * - `required` in the list — the adapter maps a forced call onto that provider's own wire shape.
 * - `required` absent — the provider accepts tools, but cannot be told to call one. Asking is a stated refusal, not a
 *   silent downgrade, because a client that asked for a forced call and got prose has been lied to about its request.
 * - `tools: false` — tools do not reach the model at all. `web: true` marks the cookie/browser providers, which are
 *   excluded from the tool contract on purpose: they are a page being driven, not an API with a function-calling
 *   surface, and pretending otherwise was the earlier plan's mistake.
 */

export type ToolCaps = {
  tools: boolean;
  toolChoice: readonly ToolChoice[];
  /** A cookie/browser session rather than an API. Named so the surfaces can say "not supported" rather than "broken". */
  web: boolean;
  /** The row was missing and a conservative default was used. False for every provider in a released build. */
  assumed?: boolean;
};

/**
 * The capability row is a field on the same manifest the dashboard card reads.
 *
 * `tools`, `toolChoice` and `web` used to live here in three hand-maintained lists, while the card's
 * name, auth and description lived in `src/data/providers.ts`. A provider added to one and not the
 * other was a card with no row or a row with no card; `tests/tools-caps.test.js` caught the pair only
 * because it compared the two. V4 collapses that: the manifest is the one description, and this file
 * projects the row. `tests/vendored-lib-drift.test.js` and `tests/tools-caps.test.js` still drive the
 * adapters, so a row that claims a forced call the wire does not send still fails.
 */
function build(): Record<string, ToolCaps> {
  return Object.fromEntries(PROVIDER_MANIFESTS.map((manifest) => [
    manifest.id,
    { tools: manifest.tools, toolChoice: [...manifest.toolChoice], web: manifest.web },
  ]));
}

export const PROVIDER_TOOLS: Readonly<Record<string, ToolCaps>> = Object.freeze(build());

/** Cookie/browser sessions, projected from the same manifest. */
export const WEB_PROVIDERS: readonly string[] = PROVIDER_MANIFESTS.filter((manifest) => manifest.web).map((manifest) => manifest.id);

/** Every provider id this table names. The guard compares it against catalogue cards and gateway registrations. */
export function toolProviderIds(): readonly string[] {
  return Object.keys(PROVIDER_TOOLS);
}

/**
 * The capability row for a provider.
 *
 * An unknown id answers conservatively — tools pass through, forcing does not — and says `assumed: true` so the
 * caller can report it. It does not throw: a provider shipped a release ahead of its row must still serve, and the
 * guard test is what stops that from being the normal case rather than an incident.
 */
export function toolCaps(providerId: string): ToolCaps {
  const row = PROVIDER_TOOLS[providerId];
  if (row) return row;
  return { tools: true, toolChoice: ['auto', 'none'], web: false, assumed: true };
}
