import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

/**
 * The dashboard's first paint, held down.
 *
 * Measured before this: `dashboardApp` was **406 KB raw / 106 KB gzip** and `src/pages` alone was 289 KB of it,
 * because `dashboardApp.tsx` imported all eleven pages eagerly — opening `/providers` downloaded the settings page
 * and everything it pulls in. After splitting, the entry chunk is **71 KB raw / 23 KB gzip**.
 *
 * A number in a release note does not stay true. These do: no page may be imported eagerly again, every route the
 * router serves must be prefetchable, and the entrance animation must stay short and switchable.
 */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const PAGES = [
  'AppHomePage',
  'ProvidersPage',
  'ProviderDetailPage',
  'ModelsPage',
  'RoutingPage',
  'ApiKeysPage',
  'UsagePage',
  'LogsPage',
  'SettingsPage',
  'AboutPage',
  'TokenSaverPage',
];

test('no dashboard page is imported into the entry chunk', async () => {
  const app = await read('src/dashboardApp.tsx');
  const eager = app.match(/^import[\s\S]*?from '\.\/pages\/[^']+'/gm) ?? [];
  assert.deepEqual(eager, [], 'a page is imported eagerly again, so every route pays for it');
  assert.match(app, /from '\.\/lib\/pageChunks'/, 'the router no longer reads the lazy page map');
});

test('every page is a lazy chunk, and the map names all eleven', async () => {
  const chunks = await read('src/lib/pageChunks.ts');
  const loaded = [...chunks.matchAll(/lazy\(\(\) => import\('\.\.\/pages\/([A-Za-z]+)'\)/g)].map((match) => match[1]);
  assert.deepEqual([...loaded].sort(), [...PAGES].sort(), 'a page is missing from the lazy map, or one was added without it');
  assert.equal((chunks.match(/lazy\(\(\) => import\(/g) ?? []).length, PAGES.length, 'a lazy() call was duplicated or dropped');
});

test('the preload map covers every route the router serves', async () => {
  // The preload is a hint, so a missing path costs a skeleton flash rather than a broken page — which is exactly the
  // kind of gap nobody reports. Held equal to the router instead.
  const app = await read('src/dashboardApp.tsx');
  const routes = [...app.matchAll(/<Route path="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((path) => path !== '*')
    // The two provider-detail routes are reached through `/providers`, which is what the nav link points at.
    .map((path) => (path.startsWith('/providers/') ? '/providers' : path));
  const chunks = await read('src/lib/pageChunks.ts');
  const prefetchable = new Set([...chunks.matchAll(/^ {2}'([^']+)': \(\) => import\(/gm)].map((match) => match[1]));
  const missing = [...new Set(routes)].filter((path) => !prefetchable.has(path));
  assert.deepEqual(missing, [], 'a route the router serves cannot be prefetched');
});

test('the page entrance is short, travels little, and can be switched off', async () => {
  const css = await read('src/index.css');
  const rule = /\.page-enter \{\s*animation: page-enter (\d+)ms/.exec(css);
  assert.ok(rule, 'the page entrance lost its rule');
  const duration = Number(rule[1]);
  // 420 ms was the old value: long enough to read as loading rather than as motion.
  assert.ok(duration <= 200, `the entrance is ${duration}ms, which reads as waiting`);
  assert.match(css, /\.page-enter \{/, 'the rule vanished');
  const travel = /@keyframes page-enter \{\s*from \{\s*opacity: 0;\s*transform: translateY\((\d+)px\)/.exec(css);
  assert.ok(travel && Number(travel[1]) <= 4, 'the entrance travels far enough to move the header');

  // Inside a reduced-motion block, not beside one: this animation used to run whatever the system setting said,
  // which is the single thing that setting exists to prevent.
  const index = css.indexOf('.page-enter {');
  const opened = css.lastIndexOf('@media (prefers-reduced-motion: no-preference) {', index);
  assert.ok(opened !== -1, 'the entrance is not inside a reduced-motion block');
  const between = css.slice(opened, index);
  const closes = (between.match(/\n\}/g) ?? []).length;
  assert.equal(closes, 0, 'the entrance rule sits after the reduced-motion block closed');
});

test('a badge tone is named once, not spelled out per page', async () => {
  // Measured before `src/ui/primitives.ts`: the success tone appeared 7 times, the gold 11, the danger 12 — thirty
  // copies of three decisions. A new tone token had to be applied three dozen times or the dashboard drifted.
  const literals = [
    'border-success/20 bg-success/10 text-success',
    'border-gold/30 bg-gold-soft text-gold-text',
    'border-danger/25 bg-danger/10 text-danger',
  ];
  const files = [];
  const walk = async (dir) => {
    const { readdir } = await import('node:fs/promises');
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.tsx')) files.push(path);
    }
  };
  await walk('src');
  const offences = [];
  for (const file of files) {
    if (file.endsWith('src/ui/primitives.ts')) continue;
    const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const literal of literals) {
      if (text.includes(literal)) offences.push(`${file}: ${literal}`);
    }
  }
  assert.deepEqual(offences, [], `a badge tone was spelled out instead of named:\n${offences.join('\n')}`);
});
