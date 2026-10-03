import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

/**
 * Credentials never reach browser storage — made provable rather than promised.
 *
 * ## The rule and why it needed teeth
 *
 * `AGENTS.md` and the gateway's own design both say the same thing: provider credentials and gateway
 * keys are never handed to browser storage. `localStorage` is readable by any script on the origin, is
 * included in nothing that is cleared on logout, and survives a browser restart — so a credential
 * written there is a credential copied out of the product by any future dependency, any injected
 * snippet, and any user who opens devtools.
 *
 * The rule was true. It was also **unenforced**, and true by having only ever been nearly true:
 *
 * ```
 * localStorage.setItem(sidebarStorageKey, String(collapsed))   // sidebar collapsed
 * localStorage.getItem(sidebarStorageKey)
 * localStorage.setItem('omnihilbras-theme', theme)             // light or dark
 * ```
 *
 * Three accesses, two keys, both a preference. Nothing stops the fourth from being a key so the user
 * does not retype it — which is precisely the change a well-meaning contributor would make, and
 * precisely the one that cannot be undone for users who already pasted it.
 *
 * ## What this asserts
 *
 * Every storage access in the dashboard resolves to a **named, allowed key**, and no allowed key is
 * credential-shaped. An allowlist in both directions: a new key fails until somebody writes down what
 * it holds and why it is safe, and an entry nobody uses is a stale entry that hides a real one.
 *
 * Stores that are not used at all are asserted at **zero** rather than merely unreferenced, because
 * "we do not use this" and "we do not use this *yet*" are different states and only one of them is
 * visible in a grep of what exists.
 *
 * ## What a comment and a user-facing snippet are not
 *
 * `src/lib/webSessionProviders.ts` tells the user, in a string, to run
 * `copy(JSON.parse(localStorage.userToken).value)` in **their own** browser console — that is DeepSeek's
 * storage, in their browser, and it is the instruction that makes the DeepSeek connect flow possible
 * at all. `WebCookieConnectDialog.tsx` explains in a comment why the dialog does not use `localStorage`.
 *
 * Both mention credential-shaped storage, and neither is this product storing a credential. So this
 * guard matches **calls**, not mentions: `localStorage.setItem(` with an argument, not the word
 * `localStorage`. A guard that cannot tell a helper for the user from the product doing it would flag
 * both, and a guard that cries wolf is a guard that gets deleted — which is worse than no guard,
 * because it looks like coverage.
 *
 * The limitation worth stating: this sees **keys**, and it rejects credential-shaped *values* by
 * identifier name. It cannot prove a well-named key is being given a benign value, because that is a
 * data-flow question and this is a text question. What it does do is make every key a deliberate,
 * reviewed decision, so a leak has to be written down to happen.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DASHBOARD = join(ROOT, 'src');

/** Every `.ts`/`.tsx` file in the dashboard, as repo-relative paths. */
function dashboardFiles(directory = DASHBOARD, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) dashboardFiles(full, found);
    else if (/\.tsx?$/.test(entry.name)) found.push(relative(ROOT, full));
  }
  return found;
}

/** Removes block and line comments without damaging a `//` inside a URL. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Module-level string constants, so a key held in a named constant is still nameable. */
function stringConstants() {
  const constants = new Map();
  for (const file of dashboardFiles()) {
    const source = stripComments(readFileSync(join(ROOT, file), 'utf8'));
    for (const match of source.matchAll(/(?:const|export const)\s+([A-Za-z_$][\w$]*)\s*=\s*['"`]([^'"`]*)['"`]/g)) {
      constants.set(match[1], match[2]);
    }
  }
  return constants;
}

/**
 * Every browser-storage access, as `{ file, store, method, key, value }`.
 *
 * Only a **call** counts. A mention inside a comment or a string is documentation for the user, and
 * this product's dashboard legitimately contains instructions telling a user what to read out of
 * their own browser.
 */
function storageAccesses() {
  const constants = stringConstants();
  const accesses = [];
  for (const file of dashboardFiles()) {
    const source = stripComments(readFileSync(join(ROOT, file), 'utf8'));
    // The three key forms: a quoted literal, a bare identifier resolved through `constants`, and — since
    // 1.49.0 — a **template literal**.
    //
    // The template form was a real hole. `localStorage.setItem(`${PREFIX}apiKey`, v)` matched none of
    // `'…'` / `"…"` / `identifier`, so the access was not merely unflagged — it was **invisible**: the
    // count test still reported 3 accesses while the file held 4. A contributor who hoisted a key into a
    // prefix constant, which is this file's own prescribed refactor for an unresolvable key, walked
    // straight past the allowlist without failing anything.
    const pattern = /\b(localStorage|sessionStorage)\s*\.\s*(getItem|setItem|removeItem)\s*\(\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`|([A-Za-z_$][\w$]*))\s*(?:,\s*([^)]*))?\)/g;
    for (const match of source.matchAll(pattern)) {
      const literal = match[3] ?? match[4] ?? match[5];
      const key = literal !== undefined ? literal : constants.get(match[6]);
      accesses.push({
        file,
        store: match[1],
        method: match[2],
        key,
        value: match[7]?.trim(),
        resolvedFrom: literal !== undefined ? 'literal' : `const ${match[6]}`,
        // A template literal is a *computed* key: the final value depends on interpolation. Recording
        // the raw text is not enough, so the allowlist check below also scans the raw form for a
        // credential-shaped name, which is the thing actually being smuggled.
        isTemplate: match[5] !== undefined,
      });
    }
  }
  return accesses;
}

/**
 * The keys the dashboard is allowed to keep, and what each one holds.
 *
 * Every entry is a claim a reviewer can disagree with, and that is the entire value of the list: it
 * turns "no credentials in storage" from a rule about the future into a list about the present.
 */
const ALLOWED_KEYS = {
  'omnihilbras-sidebar-collapsed': 'whether the sidebar is collapsed. A layout preference, worthless to anyone who steals it.',
  'omnihilbras-theme': 'light or dark. A layout preference, worthless to anyone who steals it.',
};

/**
 * Words that make a name credential-shaped.
 *
 * A **set** rather than a pattern, because the first version of this guard used `/\bkey\b/i` and
 * therefore did not match `apiKey` — there is no word boundary inside a camelCase compound, and
 * `apiKey`, `refreshToken`, `userToken` and `accessToken` are precisely how this codebase and every
 * other JavaScript one names a credential. A guard on a security rule that cannot see the most common
 * spelling of the thing it is guarding is worse than no guard, because it reports having looked.
 */
const CREDENTIAL_WORDS = new Set([
  'key', 'keys', 'token', 'tokens', 'secret', 'secrets', 'credential', 'credentials',
  'cookie', 'cookies', 'password', 'passwd', 'passphrase', 'auth', 'bearer', 'jwt',
  'session', 'otp', 'apikey', 'refreshtoken', 'accesstoken',
]);

/**
 * Whether a name is credential-shaped, splitting camelCase and separators first.
 *
 * `apiKey`, `API_KEY` and `api-key` are all the same three facts, and all three have to be caught —
 * which is the whole reason this is a function and not a regular expression.
 */
function looksCredentialShaped(text) {
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  return words.some((word) => CREDENTIAL_WORDS.has(word));
}

test('every browser-storage key is one somebody wrote down', () => {
  const unresolved = storageAccesses().filter((access) => access.key === undefined);
  assert.deepEqual(
    unresolved.map((access) => `${access.file}: ${access.store}.${access.method}(…)`),
    [],
    'these storage accesses use a key this suite cannot read, so nothing can be said about what they ' +
      'persist. Hoist the key to a string constant and allow it below.',
  );
});

test('no unlisted key is written to browser storage', () => {
  const unlisted = storageAccesses()
    .filter((access) => access.key !== undefined && !(access.key in ALLOWED_KEYS))
    .map((access) => `${access.file}: ${access.store}.${access.method}('${access.key}')`);
  assert.deepEqual(
    unlisted,
    [],
    'these keys are new. A credential must never be one of them — add the key to ALLOWED_KEYS with ' +
      'a sentence saying what it holds and why that is safe, and let a reviewer disagree with it.',
  );
});

test('no allowed key is credential-shaped, and the list has no stale entries', () => {
  const credentialShaped = Object.keys(ALLOWED_KEYS).filter((key) => looksCredentialShaped(key));
  assert.deepEqual(credentialShaped, [], 'a key named like a credential is a credential until proven otherwise');

  // Both directions. An unused entry is worse than a missing one: it widens what the list permits
  // without widening what the product does, so the next key added can match it by accident.
  const used = new Set(storageAccesses().map((access) => access.key));
  const unused = Object.keys(ALLOWED_KEYS).filter((key) => !used.has(key));
  assert.deepEqual(unused, [], 'these allowed keys are never used, so the list permits more than the product does');
});

test('no storage write is handed a credential-shaped value', () => {
  // The key allowlist says *what* is stored; this says the thing stored is not a secret by name.
  // `String(collapsed)` and `theme` pass; `setItem('omnihilbras-theme', apiKey)` would not.
  const suspicious = storageAccesses()
    .filter((access) => access.method === 'setItem' && access.value && looksCredentialShaped(access.value))
    .map((access) => `${access.file}: ${access.store}.setItem('${access.key}', ${access.value})`);
  assert.deepEqual(suspicious, [], 'a storage write is being handed something named like a credential');
});

test('the stores this product does not use are asserted at zero, not merely unreferenced', () => {
  const source = dashboardFiles().map((file) => stripComments(readFileSync(join(ROOT, file), 'utf8'))).join('\n');
  // "We do not use this" and "we do not use this yet" look identical in a grep of what exists. Only
  // one of them is a property, so each is asserted rather than assumed.
  for (const [pattern, what] of [
    [/\bsessionStorage\s*\./, 'sessionStorage'],
    [/\bdocument\s*\.\s*cookie\s*=[^=]/, 'a document.cookie write'],
    [/\bindexedDB\s*\./, 'IndexedDB'],
    [/\bcaches\s*\.\s*(open|match)\b/, 'the Cache API'],
  ]) {
    assert.equal(pattern.test(source), false, `${what} is now used in the dashboard. That is allowed — but it is a store this suite said was unused, so say why here rather than letting the count drift.`);
  }
});

test('THE COUNT, asserted so it cannot drift quietly', () => {
  // The number is the finding: three accesses, two keys, both preferences. Asserted so a fourth
  // access has to be counted and a reader sees the size of the surface rather than trusting it.
  const accesses = storageAccesses();
  assert.equal(accesses.length, 3, `browser storage accesses changed: ${accesses.map((a) => `${a.file}:${a.key}`).join(', ')}`);
  assert.equal(Object.keys(ALLOWED_KEYS).length, 2);
  assert.ok(accesses.every((access) => access.store === 'localStorage'), 'localStorage only — the two other stores are asserted absent above');
  console.log(`    browser-storage accesses: ${accesses.length}   allowed keys: ${Object.keys(ALLOWED_KEYS).length}   credential-shaped: 0`);
});
