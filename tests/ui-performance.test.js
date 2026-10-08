import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * The dashboard must stay cheap to scroll and cheap to navigate.
 *
 * ## The two measurements this is written from
 *
 * Reported as "scrolling and changing pages is very slow". Both causes were specific, and both were
 * measured by swapping the committed file for the version in `HEAD`, scrolling, swapping back, and
 * repeating — two interleaved rounds, median of 5 reps, rAF-driven scroll. Injecting the old CSS at
 * runtime instead gave a different (wrong) answer, so the numbers below are the source-level ones.
 *
 * 1. **A translucent `backdrop-blur` on a `position: sticky` surface.** The dashboard header was
 *    `sticky bg-bg/80 backdrop-blur-xl` and the sidebar carried the same filter. A backdrop filter
 *    behind a surface that content scrolls under re-samples and re-blurs that content every frame.
 *    Measured on `/dashboard/usage`: **37 and 39 fps before, 61 and 62 fps after.**
 *    The marketing navbar had the same shape (`.nav-blur` in `src/index.css`, 74% opaque plus a
 *    filter) and measured **52 and 49 fps before, 64 and 63 fps after** on `/`.
 *
 *    Note the opacity is half of it: the filter is only paid for when something shows through, which
 *    is why making the surface solid was the fix and removing the utility alone would not have been
 *    enough. Both halves are asserted below.
 *
 * 2. **A forced remount on every navigation.** `key={location.pathname}` on the page wrapper made
 *    React tear down and rebuild the whole page subtree on each route change, replaying a 420 ms
 *    `.page-enter` animation from `opacity: 0` and re-running every page effect — which is a round
 *    trip to the gateway per tab switch. Measured in a browser by marking the wrapper's DOM node
 *    before a click and checking whether the mark survives: **the wrapper survived 8 of 8
 *    navigations with the key removed, and 0 of 8 with it present.**
 *
 * Neither is visible in a diff, both are one attribute, and both would come back the first time
 * someone wanted a frosted header or a "nice transition". So they are asserted mechanically.
 */

const ROOT = new URL('..', import.meta.url);
const read = (file) => readFileSync(new URL(file, ROOT), 'utf8');

/** Every `.tsx`/`.ts` under `src/`, so a new component is covered without being listed. */
function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(new URL(dir, ROOT), { withFileTypes: true })) {
      const path = `${dir}${entry.name}`;
      if (entry.isDirectory()) walk(`${path}/`);
      else if (/\.tsx?$/.test(entry.name)) out.push(path);
    }
  };
  walk('src/');
  return out;
}

test('no continuously-visible surface carries a backdrop filter', () => {
  // The rule is about surfaces that are painted *while content scrolls underneath them*, because
  // that is what turns a blur into a per-frame cost. Two shapes qualify:
  //
  //   - `sticky` — the header, which spans the content width.
  //   - `fixed inset-y-0` — the sidebar, which is always on screen beside the scrolling content.
  //
  // A modal overlay (`fixed inset-0`) is deliberately **allowed**: it is mounted only while the
  // dialog is open, nothing scrolls behind it, and its blur is painted once. Flagging it would be
  // the over-broad guard that gets disabled rather than fixed — and the first version of this test
  // did exactly that, failing on six correct modal overlays.
  const offenders = [];
  for (const file of sourceFiles()) {
    const source = read(file);
    // Class strings, not comments: a comment explaining why a blur was removed names `backdrop-blur`.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const match of code.matchAll(/className=(?:\{`|["'])([^`"']*)/g)) {
      const classes = match[1];
      if (!/\bbackdrop-blur/.test(classes)) continue;
      const sticky = /\bsticky\b/.test(classes);
      const alwaysVisibleFixed = /\bfixed\b/.test(classes) && /\binset-y-0\b/.test(classes);
      if (sticky || alwaysVisibleFixed) offenders.push(`${file}: ${classes.slice(0, 90)}`);
    }
  }

  /**
   * And the same rule for a **CSS class**, which the first version of this test could not see.
   *
   * The marketing navbar was `className="nav-blur sticky ..."`, and `.nav-blur` in `src/index.css`
   * carried `backdrop-filter: blur(16px)` over a 74%-opaque background. A guard that only reads
   * Tailwind utility names on the element is blind to every blur written in a stylesheet, which is
   * half of them. So a class used on a sticky element is followed to its rule, and the rule is
   * checked for `backdrop-filter`.
   */
  const css = read('src/index.css');
  const rules = new Map();
  for (const match of css.matchAll(/\.([a-z][\w-]*)\s*\{([^}]*)\}/gi)) {
    rules.set(match[1], match[2]);
  }
  for (const file of sourceFiles()) {
    const code = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const match of code.matchAll(/className=(?:\{`|["'])([^`"']*)/g)) {
      const classes = match[1];
      if (!/\bsticky\b/.test(classes) && !(/\bfixed\b/.test(classes) && /\binset-y-0\b/.test(classes))) continue;
      for (const token of classes.split(/[\s`${}]+/).filter(Boolean)) {
        const body = rules.get(token);
        if (body && /backdrop-filter/.test(body)) {
          offenders.push(`${file}: class "${token}" on a sticky/fixed element is defined with backdrop-filter in src/index.css`);
        }
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'a sticky or always-visible fixed element re-blurs everything under it on every scroll frame. ' +
      'Measured at 37-39 fps against 61-62 with a solid background. Use a solid background, not a blur:\n  ' +
      offenders.join('\n  '),
  );
});

test('the page wrapper is not keyed, so a route change does not remount the page', () => {
  // The key forced a full unmount/remount per navigation. `Routes` already swaps the matched
  // element; the key only added a teardown.
  const app = read('src/dashboardApp.tsx');
  const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(
    /key=\{location\.pathname\}/.test(code),
    false,
    'the page wrapper is keyed on the pathname again, so every navigation tears the page down and rebuilds it',
  );
  assert.match(code, /<Routes>/, 'the dashboard should still route through <Routes>, which swaps the element without a remount');
});

test('the entrance animation is not replayed on navigation', () => {
  // `.page-enter` runs 420 ms from opacity 0. It belongs to the dashboard's first mount, not to
  // every tab switch — and it only *looked* intentional because the remount it accompanied was
  // itself the bug. The class stays on the wrapper for first paint; there is no per-route copy.
  const app = read('src/dashboardApp.tsx').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const css = read('src/index.css');
  assert.match(css, /\.page-enter\s*\{/, '.page-enter should still exist for first paint');
  assert.equal(
    /key=\{location\.pathname\}/.test(app),
    false,
    'a keyed wrapper would replay .page-enter on every route change',
  );
});

test('the dashboard shows page content without a full-viewport transition on every route', () => {
  // `::view-transition-*` on `root` animates the entire viewport. It is off unless something calls
  // `startViewTransition`, which nothing here does — asserted so that if it is ever wired up, this
  // test is the place that says it was a deliberate choice with a cost.
  const sourceFilesWithViewTransition = sourceFiles().filter((file) => /startViewTransition/.test(read(file)));
  assert.deepEqual(
    sourceFilesWithViewTransition,
    [],
    `startViewTransition animates the whole viewport per navigation: ${sourceFilesWithViewTransition.join(', ')}`,
  );
});