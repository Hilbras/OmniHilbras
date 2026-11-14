/**
 * Compares two release versions, newest first.
 *
 * ## Why this is plain JavaScript in a `.mjs`
 *
 * Because it has a bug worth a test, and a test can only catch it if it can *run* the code. Everything
 * else in `src/lib` is TypeScript, which `node --test` cannot import; a source-scanning test could assert
 * this function exists and messages the right strings, and would still pass with the arithmetic wrong. The
 * sibling `versionCompare.d.mts` is what gives the dashboard's typecheck its types back.
 *
 * ## The bug it exists to not have
 *
 * The reference implementation split on `.` and called `Number` on each part:
 *
 *     "1.2.3-beta".split(".").map(Number)   // [1, 2, NaN]
 *
 * Every comparison against `NaN` is `false`, so a prerelease was silently treated as *not newer* — an
 * update that never announced itself, with no error anywhere. A prerelease is deliberately **older** than
 * its release (`3.49.0-rc.1 < 3.49.0`), and differing segment counts are equal (`3.49` === `3.49.0`).
 *
 * @param {string} left
 * @param {string} right
 * @returns {number} `1` when `left` is newer, `-1` when older, `0` when the same.
 */
export function compareVersions(left, right) {
  const parse = (value) => {
    const trimmed = String(value ?? '').trim().replace(/^v/i, '');
    const dash = trimmed.indexOf('-');
    const core = dash === -1 ? trimmed : trimmed.slice(0, dash);
    const prerelease = dash === -1 ? '' : trimmed.slice(dash + 1);
    const numbers = core.split('.').map((part) => {
      // `parseInt` and not `Number`: `Number('')` is 0 but `Number('beta')` is NaN, and NaN is the whole
      // problem. A segment that is not a number contributes nothing rather than poisoning the comparison.
      const parsed = Number.parseInt(part, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });
    return { numbers, prerelease };
  };

  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.numbers.length, b.numbers.length);
  for (let index = 0; index < length; index += 1) {
    const mine = a.numbers[index] ?? 0;
    const theirs = b.numbers[index] ?? 0;
    if (mine !== theirs) return mine > theirs ? 1 : -1;
  }
  // Same core: a release outranks its own prerelease, and two prereleases fall back to text order.
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === '') return 1;
  if (b.prerelease === '') return -1;
  return a.prerelease.localeCompare(b.prerelease);
}
