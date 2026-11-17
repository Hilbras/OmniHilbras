import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

/**
 * The API keys page holds one of the two things in this dashboard that cannot be recovered: a secret that is shown
 * once. Its rules are cheap to state and easy to break, so they are checked rather than remembered.
 *
 * The defect this file was written for: `requireApiKey` started at `true`, so the enforcement switch claimed a value
 * before the gateway had answered — and it was only disabled while saving, so an operator could flip a setting the
 * page had guessed at. On a gateway where enforcement was off, that turned "off" into a no-op that reported success.
 */

const page = await readFile(new URL('../src/pages/ApiKeysPage.tsx', import.meta.url), 'utf8');

test('enforcement is unknown until the gateway answers, and the switch says so', () => {
  assert.match(page, /useState<boolean \| null>\(null\)/, 'enforcement claims a value before it is read');
  assert.doesNotMatch(page, /const \[requireApiKey, setRequireApiKey\] = useState\(true\)/, 'the guessed default is back');
  assert.match(page, /disabled=\{saving \|\| requireApiKey === null\}/, 'the switch can be flipped on a guess');
  assert.match(page, /if \(saving \|\| requireApiKey === null\) return;/, 'the handler acts on a guess');
  assert.match(page, /whether keys are required is unknown/, 'the page does not say that it does not know');
});

test('a secret is printed in exactly one place: the create dialog', () => {
  // `keyHash` must never reach the browser — the gateway does not send it, and this fails if someone starts to.
  assert.doesNotMatch(page, /keyHash/, 'the page reads a hash field the gateway never sends');
  // Two, and both inside the one-time dialog: the line that shows it and the copy button that reads it.
  const prints = [...page.matchAll(/\{createdKey\.key\}/g)].length;
  assert.equal(prints, 2, 'the secret is rendered somewhere other than the one-time dialog');
  assert.doesNotMatch(page, /\{apiKey\.key\}/, 'a list row renders a secret it was never given');
  // The list may only show the masked prefix.
  assert.match(page, /maskPrefix\(apiKey\.prefix\)/, 'the key list no longer renders the masked prefix');
});

test('deleting a key needs a second click', () => {
  assert.match(page, /pendingDelete === apiKey\.id \?/, 'the delete button is not gated behind a confirmation');
  assert.match(page, /onClick=\{\(\) => setPendingDelete\(apiKey\.id\)\}/, 'the trash icon deletes immediately');
  assert.match(page, /onClick=\{\(\) => void deleteKey\(apiKey\)\}/, 'the confirm button does not delete');
});

test('a new key is created with a trimmed name and the secret is shown once', () => {
  assert.match(page, /createGatewayApiKey\(newKeyName\.trim\(\)\)/, 'the name is sent untrimmed');
  assert.match(page, /setCreatedKey\(\{ name: result\.apiKey\.name, key: result\.key \}\)/, 'the one-time secret is discarded');
  assert.match(page, /This is the only time the secret is shown/, 'the dialog does not tell the operator this is the only time');
});

test('a notice cannot outlive itself, or clear the notice after it', () => {
  assert.match(page, /noticeTimer\.current = window\.setTimeout/, 'the notice timer is not tracked');
  assert.match(page, /window\.clearTimeout\(noticeTimer\.current\)/, 'a second notice does not cancel the first timer');
});

test('a key can be renamed in place, without rotating it', () => {
  // Before 3.63.0 the only way to change a name was to mint a new key and revoke the old one, which invalidates
  // every client already using it. The gateway refused `{name}` on PATCH outright.
  assert.match(page, /renameGatewayApiKey\(apiKey\.id, name\)/, 'renaming does not reach the gateway');
  assert.match(page, /aria-label=\{`Rename \$\{apiKey\.name\}`\}/, 'the rename control has no accessible name');
  assert.match(page, /setRenameDraft\(apiKey\.name\)/, 'the editor does not start from the current name');
  assert.match(page, /if \(event\.key === 'Escape'\)/, 'Escape does not abandon a rename');
  assert.match(page, /name === apiKey\.name\) \{ setRenamingId\(null\)/, 'saving an unchanged name sends a request');
});

test('the row reports how much traffic the key has actually served', () => {
  assert.match(page, /\(apiKey\.requests \?\? 0\)\.toLocaleString\(\)/, 'the request count is not shown, or a gateway that does not send it blanks the row');
  assert.match(page, /\(apiKey\.requests \?\? 0\) === 1 \? 'request' : 'requests'/, 'the count reads "1 requests"');
});

test('there is one create button, not two in the same view', () => {
  // The card header and the page header both offered "Create key"; the card header's duplicate is gone.
  const offers = [...page.matchAll(/setCreateOpen\(true\)/g)].length;
  assert.equal(offers, 2, 'a duplicate create control came back (expected the page header and the empty state)');
  assert.doesNotMatch(page, />\s*New key\s*</, 'the card header still says "New key"');
});

test('a copy that fails says so instead of doing nothing', () => {
  // `if (!write) return;` was a button that silently did nothing when the clipboard API was unavailable — the same
  // defect as claiming a copy that never happened, in the other direction.
  assert.match(page, /outcome === 'failed' \? `\$\{label\} could not be copied`/, 'a refused copy is reported');
  assert.match(page, /if \(!write\) \{\s*setOutcome\('failed'\);\s*return;/, 'a missing clipboard API is a silent no-op again');
  assert.doesNotMatch(page, /if \(!write\) return;/, 'the silent early return is back');
});

test('closing a dialog gives focus back to the control that opened it', () => {
  assert.match(page, /const opener = document\.activeElement/, 'the opener is not remembered');
  assert.match(page, /opener\?\.focus\(\)/, 'focus is not restored on close');
});

test('a row control cannot accept a click that it would silently ignore', () => {
  // `toggleKey`, `renameKey` and `deleteKey` all begin with `if (busyKeyId) return;` — so while one row was saving,
  // every other row's switch still looked enabled and did nothing. Disabled is the honest rendering of "not now".
  assert.doesNotMatch(page, /disabled=\{busyKeyId === apiKey\.id\}/, 'a control is enabled while its handler would ignore it');
  assert.match(page, /disabled=\{busyKeyId !== null\}/, 'the row controls are not gated on the global busy state');
});
