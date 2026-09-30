/**
 * The providers the "add a connection" dialog can collect a key for.
 *
 * ## Why this is a module and not part of the dialog
 *
 * It was in `AddProviderModal.tsx`, and that is why the guarantees below could only be checked by
 * scraping text out of a `.tsx` file: the logic was trapped inside a view that imports React, renders
 * a portal, and cannot be loaded by a test. So the checks written for it were things like *"the
 * fallback must not be `providerOptions[providerOptions.length - 1]`"* — reading the source to infer
 * what it does, which is how `tests/provider-cards.test.js` ended up asserting on the *text* of a group
 * set and then failing on its own doc comment.
 *
 * Nothing here needs a DOM. Node imports a type-erased `.ts` module directly, so moving it out of the
 * view turns "the source says it does not do the bad thing" into **"call it and check"** —
 * `tests/provider-options.test.js` does that, and the text checks that stood in for it are gone.
 *
 * ## The guarantee, and the incident that produced it
 *
 * A provider id resolves either to itself or to the neutral custom option. **Never to a named
 * vendor.** `resolveProviderOption` used to fall back to `providerOptions[0]`, which was OpenAI, so a
 * card the dialog did not know about became OpenAI with OpenAI's endpoint — a key typed for one
 * provider was validated against, and transmitted to, another. The fix hardened the fallback and left
 * the cause in place, and the cause was a second copy of the provider list; that is now derived from
 * `providerCatalog` rather than re-declared beside it.
 *
 * The one remaining hand-written list is `withoutCard`, the three providers the gateway serves that the
 * providers page has no card for. Adding a card for one of them means deleting its entry, and
 * `tests/provider-cards.test.js` fails if both exist — because a card plus a hand-written entry is two
 * copies of eight fields free to disagree, which is how seven providers ended up with two different
 * descriptions.
 */

import { providerCatalog } from '../data/providers.ts';
import { webSessionProviderIds } from './webSessionProviders.ts';

export type ProviderOption = {
  id: string;
  name: string;
  description: string;
  auth: string;
  color: string;
  initial: string;
  logo?: string;
  defaultEndpoint?: string;
};

/**
 * Providers this dialog can key that have **no card** on the providers page.
 *
 * **Empty since 1.43.0.** It held `openai`, `anthropic` and `google`, and those three now have cards in
 * `providerCatalog`. A card plus a hand-written entry is two copies of eight fields free to disagree,
 * which is how seven of seven shared providers ended up with two different descriptions before the list
 * was derived — the dialog is now built from the catalog, so a card is the only place a provider is
 * described.
 *
 * It is kept as an empty list rather than deleted because the module still spreads it, and an empty
 * spread is the honest statement of "nothing is described twice". `tests/provider-options.test.js`
 * fails if a provider appears in both places.
 */
const withoutCard: ProviderOption[] = [];

/**
 * Which kinds of card this dialog can collect a key for.
 *
 * A web-session or OAuth card is signed into rather than keyed, so opening this for one asks for a
 * credential the provider does not use. `custom` is here because its group is `custom` and not
 * `api-key`, and leaving it out drops the neutral option from the list entirely — which is what made
 * the positional fallback below resolve to Google while this refactor was being written.
 */
const eligibleGroups = new Set(['api-key', 'local', 'custom']);

/** One list of providers, derived rather than re-declared. */
export const providerOptions: ProviderOption[] = [
  ...providerCatalog.filter((card) => eligibleGroups.has(card.group)).map((card) => ({
    id: card.id,
    name: card.name,
    description: card.description,
    auth: card.auth,
    color: card.color,
    initial: card.initial,
    logo: card.logo,
    defaultEndpoint: card.endpoint,
  })),
  ...withoutCard,
];

/**
 * The neutral option. Never a named vendor.
 *
 * Found **by id**, not by position. This was `providerOptions[providerOptions.length - 1]`, a bet that
 * the custom entry is last — and when the list was first derived from the catalog and the `custom` card
 * fell out of the group filter, the last element became Google. A positional lookup for "the neutral
 * fallback" is a lookup that names a vendor the day the ordering changes, and the whole point of this
 * function is that it never does. Throwing rather than returning something keeps that promise loud.
 */
export function customOption(): ProviderOption {
  const option = providerOptions.find((item) => item.id === 'custom');
  if (!option) {
    throw new Error('providerOptions: the neutral "custom" option is missing, so an unknown provider would fall back to a named vendor.');
  }
  return option;
}

/**
 * Whether this dialog is the wrong tool for a provider.
 *
 * It collects an API key. A web-session provider has none — it is signed into — so opening this for
 * one asks for a credential the provider does not use, and the saved result is a connection that cannot
 * work. Checked here rather than only at the call site so no other caller can repeat the mistake.
 */
export function isWebSessionProvider(providerId: string | undefined): boolean {
  if (!providerId) return false;
  const card = providerCatalog.find((item) => item.id === providerId);
  return Boolean(card && webSessionProviderIds().includes(card.id));
}

/** Resolves a provider id to an option, substituting a different vendor for no input. */
export function resolveProviderOption(providerId: string | undefined): ProviderOption {
  const known = providerOptions.find((item) => item.id === providerId);
  if (known) return known;
  const card = providerCatalog.find((item) => item.id === providerId);
  if (!card) return customOption();
  return {
    id: card.id,
    name: card.name,
    description: card.description,
    // The catalog spells keyless auth as "No key", which is what the dialog tests for.
    auth: /no key/i.test(card.auth) ? 'No key' : card.auth,
    color: card.color,
    initial: card.initial,
    ...(card.logo ? { logo: card.logo } : {}),
    defaultEndpoint: card.endpoint,
  };
}
