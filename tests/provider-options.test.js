import assert from 'node:assert/strict';
import test from 'node:test';
import { customOption, isWebSessionProvider, providerOptions, resolveProviderOption } from '../src/lib/providerOptions.ts';
import { providerCatalog } from '../src/data/providers.ts';

/**
 * The dialog's provider resolution, called rather than read.
 *
 * ## Why this file exists instead of more text checks
 *
 * `resolveProviderOption` and the list it reads were in `AddProviderModal.tsx` — a view that imports
 * React and renders a portal, so nothing could load it. The guarantees around it therefore had to be
 * checked by scraping source, and that produced checks like *"the fallback must not be
 * `providerOptions[providerOptions.length - 1]`"*, which infers behaviour from the shape of the code and
 * then failed on its own doc comment.
 *
 * The logic moved to `src/lib/providerOptions.ts` because none of it needs a DOM. Node imports a
 * type-erased `.ts` module directly, so the same guarantees are now **run**: call it with an input,
 * assert what comes back. A text check cannot tell a correct implementation from a correct-looking one;
 * this can.
 *
 * ## The guarantee, and why it is worth this much machinery
 *
 * A provider id resolves to itself or to the neutral custom option. **Never to a named vendor.**
 *
 * This is not hypothetical. `resolveProviderOption` used to fall back to `providerOptions[0]`, which was
 * OpenAI, so a card the dialog did not know about became OpenAI with OpenAI's endpoint — **a key typed
 * for one provider was validated against, and transmitted to, another.** The fix hardened the fallback
 * and left the cause in place. A second copy of the provider list was not a hazard waiting to happen; it
 * was one, and it shipped.
 *
 * The properties below are stated over *inputs* rather than over the source, so they keep holding if the
 * implementation is rewritten — which is the point of moving it out of the view in the first place.
 */

/** Ids no card claims, to prove a near-miss is still a near-miss. */
const UNKNOWN_IDS = [undefined, '', '   ', 'openai ', 'OpenAI', 'openrouter2', 'clines', '../openai', 'toString', 'constructor', '__proto__', 'constructor.name'];

/** Every id the product knows about, from both lists. */
function knownIds() {
  return [...new Set([...providerCatalog.map((card) => card.id), ...providerOptions.map((option) => option.id)])];
}

test('THE GUARANTEE: a provider id resolves to itself, or to the neutral option, and never to a vendor', () => {
  const neutral = customOption();
  for (const id of UNKNOWN_IDS) {
    const resolved = resolveProviderOption(id);
    assert.equal(
      resolved.id,
      'custom',
      `resolveProviderOption(${JSON.stringify(id)}) resolved to ${JSON.stringify(resolved.id)} — a key pasted for an unknown ` +
        `provider would be sent to ${resolved.defaultEndpoint}, which is a vendor nobody named`,
    );
    assert.equal(resolved.id, neutral.id);
  }
});

test('every id the product knows resolves to itself', () => {
  // The other half of the same property: resolution is not lossy for anything real, or the fix would
  // be "send it to the wrong place" rather than "ask the user".
  for (const id of knownIds()) {
    assert.equal(resolveProviderOption(id).id, id, `${id} did not resolve to itself`);
  }
});

test('the neutral option is the local custom endpoint, not a hosted vendor', () => {
  const neutral = customOption();
  assert.equal(neutral.id, 'custom');
  // A hostname check rather than a string match, because this is the property that matters: where does
  // a key go? `localhost` and `127.0.0.1` are the only two answers that are safe by construction.
  const host = new URL(neutral.defaultEndpoint ?? '').hostname;
  assert.ok(host === 'localhost' || host === '127.0.0.1', `the neutral fallback points at ${host}, which is a machine the operator does not own`);
  assert.equal(isWebSessionProvider(neutral.id), false);
});

test('a web-session provider is recognised, so the keyed dialog is never opened for one', () => {
  // A card for a provider that is *signed into* has no key to collect, and opening the keyed dialog
  // for one produces a form that asks for a credential the provider does not use.
  const webSession = providerCatalog.filter((card) => ['chatgpt-web', 'qwen-web', 'deepseek-web', 'tokenharbor-web'].includes(card.id));
  assert.equal(webSession.length, 4, 'the fixture moved: update the ids here');
  for (const card of webSession) assert.equal(isWebSessionProvider(card.id), true, `${card.id} is a web-session provider`);
  for (const card of providerCatalog.filter((c) => !webSession.includes(c))) {
    assert.equal(isWebSessionProvider(card.id), false, `${card.id} should not be treated as a web-session provider`);
  }
  assert.equal(isWebSessionProvider(undefined), false);
  assert.equal(isWebSessionProvider('nope'), false);
});

test('no id appears twice, and every option is usable', () => {
  const ids = providerOptions.map((option) => option.id);
  assert.deepEqual([...new Set(ids)].sort(), [...ids].sort(), `duplicate option ids: ${ids.filter((id, index) => ids.indexOf(id) !== index).join(', ')}`);
  for (const option of providerOptions) {
    for (const field of ['id', 'name', 'description', 'auth', 'color', 'initial']) {
      assert.equal(typeof option[field], 'string', `${option.id}.${field} is not a string`);
      assert.ok(String(option[field]).length > 0, `${option.id}.${field} is empty`);
    }
    assert.match(option.color, /^#[0-9a-fA-F]{6}$/, `${option.id} has a colour that is not a hex triple`);
    assert.equal(option.initial.length, 1, `${option.id} has a ${option.initial.length}-character initial`);
    assert.ok(option.defaultEndpoint, `${option.id} has no default endpoint, so a key would be sent nowhere`);
    assert.doesNotThrow(() => new URL(String(option.defaultEndpoint)), `${option.id} has an unparseable endpoint`);
  }
});

test('an option is derived from its card, so the two cannot hold different copy', () => {
  // The duplication this replaced: seven of seven shared providers had two different descriptions, and
  // the dialog's was the one a user read while pasting a key that would be sent to that vendor. Now the
  // dialog's text *is* the card's text, which is a stronger claim than "they agree today".
  for (const card of providerCatalog) {
    const option = providerOptions.find((item) => item.id === card.id);
    if (!option) continue;
    for (const field of ['name', 'description', 'auth', 'color', 'initial']) {
      assert.equal(option[field], card[field], `${card.id}.${field} differs between the card and the dialog`);
    }
    assert.equal(option.defaultEndpoint, card.endpoint, `${card.id}'s endpoint differs between the card and the dialog`);
  }
});

test('a provider is described in exactly one place, so two copies cannot disagree', () => {
  // The rule `providerOptions.ts` states and this file could not enforce until now: a card plus a
  // hand-written `withoutCard` entry is two copies of eight fields free to disagree, and that is how
  // seven of seven shared providers ended up with two different descriptions before the dialog list was
  // derived from the catalog.
  //
  // It bit this change immediately. `openai`, `anthropic` and `google` were in `withoutCard` because
  // they had no card; adding the cards without deleting the entries would have produced the exact
  // duplicate this forbids, and no existing test failed.
  //
  // Measured against `withoutCard` **only** — `providerOptions` is derived from `providerCatalog`, so a
  // card legitimately appears in both the catalog and the dialog. My first version compared against
  // `providerOptions` and flagged all sixteen cards, which is a check that cannot pass and is therefore
  // a check nobody keeps.
  const handWritten = providerOptions.filter((option) => !providerCatalog.some((card) => card.id === option.id));
  assert.deepEqual(handWritten.map((option) => option.id), [], `hand-written entries that a card now duplicates: ${handWritten.map((o) => o.id).join(', ')}`);
});

test('the neutral custom option is still reachable, and nothing else shadows it', () => {
  // Ten cards were added and `withoutCard` emptied, so the list the dialog renders changed shape. This
  // is the check that the neutral option survived it — the fallback resolving to a named vendor is the
  // defect `customOption()` was extracted to prevent.
  assert.equal(providerOptions.some((option) => option.id === 'custom'), true, 'custom must be offered');
  assert.equal(providerOptions[providerOptions.length - 1]?.id, 'custom', 'and it is last, which the by-id lookup no longer relies on');
});

test('THE COUNT, asserted so it cannot drift quietly', () => {
  // Sixteen options from thirteen eligible cards and no declared exceptions, over twenty-two cards
  // (1.43.0 added nine API-key providers and emptied `withoutCard`). These
  // were the counts when the list stopped being a second copy; a change to any of them is a product
  // decision, so it has to be made here rather than arriving as an off-by-one.
  // Cards 13 -> 22 in 1.43.0: Kimi, DeepSeek, Qwen, Groq, Grok, NVIDIA, OpenAI, Anthropic, Gemini.
  // Mistral was already a card, so it is not among the additions.
  //
  // Options 10 -> 16: +9 from the new cards, −3 because `openai`, `anthropic` and `google` left
  // `withoutCard` for the catalog. I first wrote 19 by adding the nine to the old ten without noticing
  // three had moved, which is the arithmetic of a list described in two places — the reason the next
  // test exists.
  // Cards 23 -> 24 in 1.72.0 (`claude-code`); the dialog offers no option for it, because it is an
  // OAuth card and `eligibleGroups` is `api-key`, `free-tier`, `local` and `custom` only.
  // Cards 24 -> 25 in 1.73.0 (`tokenharbor-web`); no option either, for the same reason one level
  // over — its group is `web-cookie`, which the keyed dialog does not offer.
  // Cards 25 -> 26 in 1.76.0 (`clinepass`), the first card added here whose *base* is also a card.
  // 1.77.0 moved `clinepass` to the OAuth group — it is the same account as Cline, reached by the same
  // sign-in — so the dialog offers no option for it either: options go 17 -> 16, back to exactly the
  // count before `clinepass` existed. Both halves of that pair are now OAuth cards, and neither is keyed.
  assert.equal(providerCatalog.length, 30, `the catalog now has ${providerCatalog.length} cards`);
  assert.equal(providerOptions.length, 20, `the dialog now offers ${providerOptions.length} options`);
  console.log(`    cards: ${providerCatalog.length}   dialog options: ${providerOptions.length}   ids tested: ${knownIds().length + UNKNOWN_IDS.length}`);
});
