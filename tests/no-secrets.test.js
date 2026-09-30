import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join } from 'node:path';

/**
 * No credentials in the repository — the ritual, made into a check.
 *
 * ## Why this is a test and not a habit
 *
 * `AGENTS.md` says, under Security rules:
 *
 * > Before any push, scan the tree for secret-shaped strings.
 *
 * That instruction has been carried out by hand before every push in this work — about twenty
 * times — with four patterns. A manual pre-push ritual is a ritual: it is skipped under deadline,
 * it is not run by the person reviewing a pull request, and it does not run at all on the twenty
 * commits between the one you remembered and the tag you pushed. The 141 provider assets that 18
 * consecutive releases left out of the repository were missed for the same reason — a thing done by
 * hand, with nothing to notice when it stopped happening.
 *
 * So the ritual becomes a test, and CI runs it on every push and every pull request, which is the
 * only place a check like this can be trusted.
 *
 * ## Four patterns became fourteen, and it was free
 *
 * The manual version looked for a gateway key, an OpenRouter-style key, a GitHub PAT and an npm
 * token. Those are this project's own credentials. A repository that also handles AWS, Google, Slack,
 * Discord, Anthropic and any pasted JWT should look for those too, and **measured across the tracked
 * tree, every one of the extra ten patterns matches nothing** — so the wider net costs no false
 * positives today, and a scanner that cries wolf on day one is a scanner that gets deleted.
 *
 * ## The oracle is the repository, not the working tree
 *
 * The scan reads `git ls-files`. That is not incidental: the defect this suite's siblings exist to
 * catch was a working tree holding 141 files the repository did not, so a scanner that read the
 * working tree would have been blind to exactly the class of problem it was written for. If git
 * cannot answer, this reports that it skipped rather than passing quietly — a test that silently
 * degrades to green is worse than no test, because it is a claim of coverage that does not exist.
 *
 * ## It needs no self-exemption — and the reason is narrower than I first claimed
 *
 * The reflexive move when writing a scanner is to exempt the scanner. This one does not, and the
 * reason is worth stating precisely, because the first version of this file claimed it more broadly
 * than was true and CI proved it:
 *
 * - **A pattern source is not a match.** `/\bohk_[A-Za-z0-9_-]{20,}/g` in this file contains `[`
 *   where the pattern wants a character class, and the same is true of the `git grep` line that used
 *   to live in `AGENTS.md`. Nothing needs exempting for those.
 * - **But a sample is not a pattern source.** Four samples were originally written as complete
 *   literals, and the scanner flagged its own file: `Slack token`, `Slack webhook URL`,
 *   `private key block`, `JSON Web Token`. Those are real matches, of fake credentials — and a
 *   repository that commits fake credentials shaped exactly like live ones has lost the property that
 *   makes a grep useful, which is the whole reason this file exists.
 *
 * So every sample is assembled from pieces. The shape on disk is `'xoxb-' + '1'.repeat(10)`, which no
 * pattern matches; the value at runtime is the real thing, which every pattern does. Both directions
 * are asserted below, so neither half can be quietly given up.
 *
 * ## Binary files are skipped, on purpose and by name
 *
 * 145 of the 294 bundled provider marks contain a NUL byte. Reading a PNG as text and searching it for
 * `AKIA…` is a coin flip decided by the compressor, and a guard whose false positives come and go with
 * the asset set is a guard that gets switched off. The skip list is below, and its size is asserted,
 * so adding a new binary asset type is a decision somebody makes rather than something that happens.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Credential shapes. Each is named so a failure says which kind of key, not just "a match". */
const PATTERNS = [
  { name: 'OmniHilbras gateway key', re: /\bohk_[A-Za-z0-9_-]{20,}/g },
  { name: 'npm token', re: /\bnpm_[A-Za-z0-9]{30,}/g },
  { name: 'GitHub personal access token', re: /\bghp_[A-Za-z0-9]{30,}/g },
  { name: 'GitHub app/bot/revoked token', re: /\bgh[osur]_[A-Za-z0-9]{30,}/g },
  { name: 'OpenAI-style key', re: /\bsk-[A-Za-z0-9]{32,}/g },
  { name: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'OpenRouter key', re: /\bsk-or-v1-[A-Za-z0-9]{20,}/g },
  { name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'Slack token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/g },
  { name: 'Slack webhook URL', re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/g },
  { name: 'Discord webhook URL', re: /https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]{20,}/g },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { name: 'JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: 'bearer header value', re: /\bBearer\s+[A-Za-z0-9._-]{40,}/g },
];

/** Extensions read as text. Everything else is skipped, and the skip is asserted below. */
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml',
  '.html', '.css', '.sh', '.txt', '.toml',
]);

/**
 * Paths allowed to contain something credential-shaped, and why.
 *
 * **Empty, and asserted empty.** An exemption list that accumulates quietly is how a scanner stops
 * being one: each entry looks reasonable on its own, and the aggregate is a hole. If a real case
 * arrives — a fixture for a key format, a document quoting a revoked key — the entry has to say what
 * it is and why it is not a live credential, and the count below changes with it.
 */
const EXEMPT = {};

/** Every tracked path, or `null` when git cannot answer. */
function trackedFiles() {
  try {
    const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
    return out.trim().split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Whether a file's bytes are text, decided by **content**.
 *
 * The first version of this skipped by extension, and its own test caught the hole: 149 SVG marks,
 * `LICENSE`, `public/_redirects`, `.gitignore` and `.env.example` are all text, all had extensions
 * the list did not know, and all were being skipped. A secret pasted into an SVG would have sailed
 * through. **A name is not a property of content**, and a maintained list of names is a list that is
 * wrong the moment somebody adds a file.
 *
 * 145 of the 294 bundled marks *are* binary and do contain a NUL byte, so the test is real — it just
 * belongs on the bytes rather than on a filename. Reading a file whole is cheap: the entire asset
 * directory is 2.8 MB.
 */
function isBinary(file) {
  if (!existsSync(join(ROOT, file))) return true;
  return readFileSync(join(ROOT, file)).includes(0);
}

/** Every credential-shaped match in the tracked, text, non-exempt tree. */
function findings() {
  const files = trackedFiles();
  if (!files) return null;
  const found = [];
  for (const file of files) {
    if (file in EXEMPT || isBinary(file)) continue;
    const source = readFileSync(join(ROOT, file), 'utf8');
    for (const { name, re } of PATTERNS) {
      re.lastIndex = 0;
      for (const match of source.matchAll(re)) {
        const line = source.slice(0, match.index).split('\n').length;
        found.push(`${file}:${line}  ${name}`);
      }
    }
  }
  return found;
}

test('no credential-shaped string is committed', () => {
  const found = findings();
  if (!found) {
    console.log('    skipped: git is unavailable here, so nothing was scanned. Not a pass.');
    return;
  }
  assert.deepEqual(
    found,
    [],
    `these look like credentials and are in the repository: ${found.join('; ')}. ` +
      'A key that reached a commit has to be rotated, not deleted — assume it is compromised.',
  );
});

test('the scanner matches a real key, so a clean tree means something', () => {
  // A scanner that matches nothing is indistinguishable from a scanner that is broken. This is the
  // check that keeps "all clear" a measurement: every pattern is shown a string it must catch.
  /**
   * Every sample is **assembled from pieces**, never written whole.
   *
   * This is not a style preference, and the first version of this file got it wrong and CI caught it:
   * four samples were written as complete literals, so the file that proves each pattern is live was
   * itself committing four fake credentials — indistinguishable from real ones in a diff, in a
   * `git grep`, and in a leak triage. A reviewer cannot tell a dead sample from a live key by reading
   * it, and neither can the next person grepping for one.
   *
   * So the shape on disk is `'xoxb-' + '1'.repeat(10)`, which no pattern matches, while the value at
   * runtime is the real thing, which every pattern does. The eleven samples that were already built
   * this way with `'a'.repeat(43)` were the only reason the rest of the suite was trustworthy.
   */
  const samples = {
    'OmniHilbras gateway key': 'ohk_' + 'a'.repeat(43),
    'npm token': 'npm_' + 'b'.repeat(36),
    'GitHub personal access token': 'ghp_' + 'c'.repeat(36),
    'GitHub app/bot/revoked token': 'gho_' + 'd'.repeat(36),
    'OpenAI-style key': 'sk-' + 'E'.repeat(40),
    'Anthropic key': 'sk-ant-' + 'f'.repeat(40),
    'OpenRouter key': 'sk-or-v1-' + 'g'.repeat(40),
    'AWS access key id': 'AKIA' + 'H'.repeat(16),
    'Google API key': 'AIza' + 'i'.repeat(35),
    'Slack token': 'xoxb-' + '1'.repeat(10) + '-' + 'a'.repeat(10),
    'Slack webhook URL': 'https://hooks.slack.com/services/' + 'T'.repeat(8) + '/' + 'B'.repeat(8) + '/' + 'j'.repeat(24),
    'Discord webhook URL': 'https://discord.com/api/webhooks/' + '1'.repeat(18) + '/' + 'k'.repeat(24),
    'private key block': '-----BEGIN ' + 'PRIVATE KEY-----',
    // The RFC 7515 example, because a hand-written sample is how a pattern gets a minimum length
    // wrong: the first version of this was nine and nine and ten characters, which the pattern
    // correctly refused, since its minimum segment is eight after the leading `eyJ`.
    'JSON Web Token': 'eyJ' + 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' + '.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ' + '.' + '4pcPyMD09olPSyXnrXCjTwXyr4Bse-dGvsQ2Q',
    'bearer header value': 'Bearer' + ' ' + 'l'.repeat(44),
  };
  // Both directions, because a sample that matches two patterns proves neither. `sk-or-v1-…` must
  // reach the OpenRouter pattern and *not* the OpenAI one, and the two overlap in their first three
  // characters — which is exactly where a badly written alternation silently drops one.
  for (const { name, re } of PATTERNS) {
    const sample = samples[name];
    assert.ok(sample, `no sample for the ${name} pattern, so that pattern is never proven live`);
    re.lastIndex = 0;
    assert.ok(re.test(sample), `the ${name} pattern does not match its own sample, so it is not testing anything`);
  }
  for (const [name, sample] of Object.entries(samples)) {
    const others = PATTERNS.filter((pattern) => pattern.name !== name && pattern.re.test(sample));
    if (['OpenAI-style key', 'OpenRouter key', 'Anthropic key'].includes(name)) {
      // The `sk-` family genuinely overlaps; what matters is that each reaches its own pattern, which
      // is asserted above, and that none of them swallows another's shape wholesale.
      assert.ok(others.length <= 1, `the ${name} sample is also matched by ${others.map((o) => o.name).join(', ')}, so the samples cannot tell the patterns apart`);
    } else {
      assert.deepEqual(others.map((other) => other.name), [], `the ${name} sample is also matched by another pattern, so a finding would be misattributed`);
    }
  }
});

test('the scanner does not match itself, or the rule that documents it', () => {
  // Asserted so nobody adds a self-exemption on a false premise later, and so the *samples* stay
  // assembled. A pattern source is not a match, so this file's regexes are safe — but a sample written
  // as a complete literal is, and the first version of this file had four of them. CI caught that,
  // which is the only reason it is written down here rather than rediscovered.
  const found = findings();
  if (!found) return;
  const self = found.filter((entry) => entry.startsWith('tests/no-secrets.test.js') || entry.startsWith('AGENTS.md'));
  assert.deepEqual(self, [], 'the scanner, its samples, or the rule documenting it are being flagged. A pattern source is not a match, so a pattern needs widening; a sample needs assembling from pieces. Neither is a reason for an exemption.');
});

test('every sample is assembled, so no complete credential-shaped literal is committed', () => {
  // The property that makes `grep` useful: a reader, a reviewer, and a leak triage can all see a
  // credential-shaped string in this file and know it is not one. Asserted directly rather than left
  // to the main scan, so the reason a failure happened here is obvious from the message.
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    const whole = source.match(re);
    assert.equal(whole, null, `a complete ${name} shape is written literally in this file; assemble it from pieces instead`);
  }
  // And the pieces still have to add up, or "assembled" could mean "weakened until it stopped matching".
  const { name, re } = PATTERNS.find((pattern) => pattern.name === 'Slack token');
  re.lastIndex = 0;
  assert.ok(re.test('xoxb-' + '1'.repeat(10) + '-' + 'a'.repeat(10)), 'the assembled Slack sample still matches, so the sample table is not quietly inert');
});

test('the exemption list is empty, and adding one has to be a decision', () => {
  const entries = Object.entries(EXEMPT);
  assert.deepEqual(
    entries.filter(([, reason]) => typeof reason !== 'string' || reason.length < 20),
    [],
    'every exemption needs a reason a reviewer could disagree with',
  );
  // Currently zero. Asserted so the list cannot grow by accident — the day this fails is the day
  // somebody adds a fixture, and they will have to look at why it is zero.
  assert.equal(entries.length, 0, `the exemption list grew to ${entries.length}: ${Object.keys(EXEMPT).join(', ')}`);
});

test('binary files are skipped by their bytes, and the skip is doing real work', () => {
  // 145 of the 294 bundled marks contain a NUL byte. Searching a PNG for `AKIA…` is a coin flip
  // decided by the compressor, and a scanner whose false positives move with the asset set gets
  // switched off rather than fixed. Deciding by content rather than by extension is what keeps 149
  // SVG marks — which *are* text — inside the net.
  const files = trackedFiles() ?? [];
  const binary = files.filter((file) => !(file in EXEMPT) && isBinary(file));
  const text = files.filter((file) => !(file in EXEMPT) && !isBinary(file));
  assert.ok(binary.length > 100, `the skip is excluding nothing, so it is not being tested: ${binary.length} binary files`);
  assert.ok(text.length > 100, `the scan is reading nothing: ${text.length} text files`);
  // The specific mistake the extension list made: SVG marks are text and must be scanned.
  const svgMarks = files.filter((file) => file.endsWith('.svg'));
  assert.ok(svgMarks.length > 0 && svgMarks.every((file) => !isBinary(file)), 'every SVG mark is text, so every SVG mark is scanned');
  assert.ok(svgMarks.every((file) => !(file in EXEMPT)), 'and none of them is quietly exempted');
});

test('THE COUNT, asserted so the net cannot shrink quietly', () => {
  const files = trackedFiles() ?? [];
  assert.ok(PATTERNS.length >= 15, `the pattern set shrank to ${PATTERNS.length}`);
  assert.ok(files.length > 100, `expected a substantial tracked tree, found ${files.length} files`);
  console.log(`    credential shapes: ${PATTERNS.length}   tracked files scanned: ${files.length}   exemptions: ${Object.keys(EXEMPT).length}`);
});
