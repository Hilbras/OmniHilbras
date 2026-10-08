import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * The dashboard must not statically pull an animation library.
 *
 * ## What this is about
 *
 * `ThemeToggle` was the only user of `motion` on the dashboard — for one icon flip — but
 * `DashboardShell` imports it, so `motion/react` landed in the shared chunk `dashboard.html`
 * loads: **284 KB rendered** (`node scripts/analyze-bundle.mjs`), about 90 KB gzipped on every
 * dashboard page load. The measurement lived only in a conversation until this file.
 *
 * The subtlety that makes this assertable at all: `motion` still appears in the module graph after
 * the fix, because Rollup knows about a dynamic import. What changed is **how it is imported** —
 * dynamically, from a leaf module (`ThemeAnimatedIcon.tsx`), so the browser fetches it on intent
 * rather than on load. So the property is about the *import form*, not the library's absence, and
 * that is exactly what a source check can see.
 *
 * ## Why it reads the source rather than the built bundle
 *
 * Same reason `providerOptions` and `providerCards` moved out of `.tsx` files: a check that reads
 * the build needs a build. This runs in `pnpm test:repo`, before anything is compiled, so a
 * regression fails in two seconds instead of after a four-minute `pnpm verify`. The build-side
 * half — the real byte count — is `scripts/analyze-bundle.mjs --check`.
 */

const ROOT = new URL('..', import.meta.url);
const read = (file) => readFileSync(new URL(file, ROOT), 'utf8');

const MOTION_MODULES = ['motion/react', 'motion', 'framer-motion'];

test('the dashboard shell reaches motion only through a dynamic import', () => {
  const toggle = read('src/components/ThemeToggle.tsx');

  // The library must not be imported for its own sake here...
  for (const specifier of MOTION_MODULES) {
    const staticImport = new RegExp(`^\\s*import[^;]*from\\s*['"]${specifier.replace('/', '\\/')}['"]`, 'm');
    assert.equal(staticImport.test(toggle), false, `ThemeToggle statically imports ${specifier}, which puts it back in the dashboard's initial chunk`);
  }

  // ...and the animated half must be reached by a dynamic `import()`, which is what keeps it out.
  assert.match(
    toggle,
    /import\(\s*['"]\.\/ThemeAnimatedIcon['"]\s*\)/,
    'ThemeToggle no longer dynamically imports ThemeAnimatedIcon, so the animation library is static again',
  );
});

test('the animated icon is a leaf, so the dynamic import is a real boundary', () => {
  // If `ThemeAnimatedIcon` were also imported statically from somewhere the dashboard loads, the
  // dynamic import would be decoration: Rollup would put it back in the initial chunk and this
  // whole mechanism would be a comment that does not hold.
  const files = [
    'src/components/DashboardShell.tsx',
    'src/components/ThemeToggle.tsx',
    'src/dashboardApp.tsx',
    'src/dashboard.tsx',
  ];
  for (const file of files) {
    const source = read(file);
    const staticImport = /^\s*import[^;]*from\s*['"][^'"]*ThemeAnimatedIcon['"]/m;
    assert.equal(staticImport.test(source), false, `${file} statically imports ThemeAnimatedIcon, which defeats the lazy split`);
  }
});

test('motion is imported from exactly one file on the dashboard side', () => {
  // The rule is "one lazy boundary", not "motion is banned". A second file importing it directly
  // would be a second place to keep honest, which is the duplication this repository keeps paying
  // for. The marketing page is allowed its own (`App.tsx`, `Navbar.tsx`) — it is a different entry
  // and has no first-paint budget to protect.
  const owners = [];
  const candidates = ['src/components/ThemeAnimatedIcon.tsx', 'src/App.tsx', 'src/components/Navbar.tsx'];
  for (const file of candidates) {
    const source = read(file);
    if (/from\s*['"]motion\/react['"]/.test(source)) owners.push(file);
  }
  assert.deepEqual(
    owners,
    candidates,
    `the files importing motion/react moved: ${owners.join(', ')}. If ThemeAnimatedIcon stopped importing it, the lazy split is pointless; ` +
      'if a new file started, it is a new place for the library to leak into the dashboard.',
  );
  assert.ok(existsSync(fileURLToPath(new URL('src/components/ThemeAnimatedIcon.tsx', ROOT))), 'the lazy module must exist');
});

test('the particle canvas does not draw when it cannot be seen', () => {
  // The scripted animation is O(n^2) over up to 72 particles, so "keep animating in a hidden tab"
  // and "keep animating while scrolled past" are both real work for nothing. Both guards are
  // asserted here because they are the same decision: do not draw when nobody is looking.
  const source = read('src/components/ParticleBackground.tsx');
  assert.match(source, /document\.hidden/, 'the particle loop no longer checks document.hidden, so a background tab keeps animating');
  assert.match(source, /IntersectionObserver/, 'the particle loop no longer pauses when scrolled out of view');
  assert.match(source, /FRAME_INTERVAL_MS/, 'the frame budget cap is gone, so the loop runs at the display rate');
});