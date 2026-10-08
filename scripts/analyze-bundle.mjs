import { build } from 'vite';

/**
 * What the browser actually downloads, attributed to the package that shipped it.
 *
 * ## Why this exists
 *
 * "The dashboard is heavy" was a feeling with three candidate causes and no number. I sized them
 * by grepping the built chunk for `MotionValue` and counting occurrences, which is a heuristic
 * dressed as a measurement — it says the string is present, not how many bytes it costs. The
 * dashboard really was shipping `motion` for one icon-flip, but "really" rested on that count.
 *
 * Rollup reports `renderedLength` **per module**, so the honest number is available from the real
 * build with no sourcemap library and no extra dependency. This script reads it and answers the
 * only question that matters: **which packages are in the chunks a given page loads, and how big**.
 *
 * ## The two things it is careful about
 *
 * - **Per page, not per build.** `dashboard.html` and `index.html` share most chunks, so a
 *   build-wide total hides whether the dashboard pays for the marketing page's animation library.
 *   The entry each chunk belongs to is `facadeModuleId`; the chunks a page loads are that entry
 *   plus everything it statically imports.
 * - **Package, not file.** Forty `lucide-react` icon modules are one vendor cost, not forty. The
 *   pnpm store path is unwrapped (`node_modules/.pnpm/pkg@ver/node_modules/pkg/...` → `pkg`) so a
 *   dependency's cost is one row.
 *
 * Sizes are **rendered**, i.e. pre-gzip. Gzip is applied at the chunk level in the summary, because
 * a module's gzip size cannot be measured separately without lying about shared dictionary reuse.
 */

const MOTION_PACKAGES = /^(framer-motion|motion|motion-dom|motion-utils)$/;

/** `node_modules/.pnpm/lucide-react@1.47.0_react@19.3.0/node_modules/lucide-react/dist/...` */
function packageOf(moduleId) {
  const normalized = moduleId.replace(/\\/g, '/');
  const pnpm = normalized.match(/\/node_modules\/\.pnpm\/[^/]+\/node_modules\/(.+)$/);
  const tail = pnpm ? pnpm[1] : normalized.match(/\/node_modules\/(.+)$/)?.[1];
  if (tail) {
    // Scope-aware: `@scope/name/rest` keeps two segments.
    const parts = tail.split('/');
    return parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
  }
  if (normalized.startsWith('src/') || normalized.includes('/src/')) {
    const after = normalized.slice(normalized.indexOf('/src/') + 1);
    const parts = after.split('/');
    return parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0];
  }
  if (normalized.startsWith('\0') || normalized.startsWith('rolldown/') || normalized.startsWith('vite/')) return '(build runtime)';
  return '(app)';
}

function chunkAggregate(chunk) {
  const byPackage = new Map();
  let total = 0;
  for (const [id, mod] of Object.entries(chunk.modules ?? {})) {
    const size = mod.renderedLength ?? 0;
    const name = packageOf(id);
    byPackage.set(name, (byPackage.get(name) ?? 0) + size);
    total += size;
  }
  return { total, byPackage };
}

/** Entry chunk → the chunks its page loads: itself plus everything it statically imports. */
function chunksForEntry(chunksById, entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const chunk = stack.pop();
    if (!chunk || seen.has(chunk.fileName)) continue;
    seen.add(chunk.fileName);
    for (const imported of chunk.imports ?? []) stack.push(chunksById.get(imported));
  }
  return [...seen].map((fileName) => chunksById.get(fileName)).filter(Boolean);
}

const outputs = await build({ logLevel: 'error', build: { write: false } });
const out = Array.isArray(outputs) ? outputs[0] : outputs;
const chunks = out.output.filter((item) => item.type === 'chunk');
const chunksById = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));

const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;

console.log('bundle analysis — rendered bytes per package, in the chunks each page loads\n');

for (const chunk of chunks) {
  const { total, byPackage } = chunkAggregate(chunk);
  const top = [...byPackage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  console.log(`${chunk.fileName}  ${kb(total)} rendered  (${Object.keys(chunk.modules ?? {}).length} modules)`);
  for (const [name, size] of top) console.log(`    ${name.padEnd(28)} ${kb(size).padStart(9)}`);
}

console.log('\nper page (the chunks that page statically loads):');
const entries = chunks.filter((chunk) => chunk.isEntry);
const pageCost = new Map();
for (const entry of entries) {
  const page = (entry.facadeModuleId ?? '').split('/').pop() ?? entry.fileName;
  const loaded = chunksForEntry(chunksById, entry);
  const merged = new Map();
  let total = 0;
  for (const chunk of loaded) {
    const { total: chunkTotal, byPackage } = chunkAggregate(chunk);
    total += chunkTotal;
    for (const [name, size] of byPackage) merged.set(name, (merged.get(name) ?? 0) + size);
  }
  const motion = [...merged].filter(([name]) => MOTION_PACKAGES.test(name)).reduce((sum, [, size]) => sum + size, 0);
  pageCost.set(page, { total, motion, chunks: loaded.length });
  console.log(`  ${page.padEnd(16)} ${kb(total).padStart(9)} rendered over ${loaded.length} chunk(s)   motion: ${kb(motion)}`);
}

/**
 * `--check` is the release gate: the dashboard must not statically pull the motion library.
 *
 * A budget rather than "zero bytes", because a lazily-imported module still appears in the module
 * graph the analyzer reads — Rollup knows about it, the browser does not fetch it until the toggle
 * is pressed. The number to assert is therefore small-but-present, and the *dynamic* import is what
 * keeps it off the critical path. `tests/bundle-budget.test.js` asserts the source side of the same
 * rule (the import must be dynamic), so a regression that inlines it fails a fast test.
 */
const MOTION_BUDGET_BYTES = 8 * 1024;

if (process.argv.includes('--check')) {
  const failures = [];
  for (const [page, cost] of pageCost) {
    if (page !== 'dashboard.html') continue;
    if (cost.motion > MOTION_BUDGET_BYTES) {
      failures.push(`dashboard.html statically loads ${kb(cost.motion)} of motion (budget ${kb(MOTION_BUDGET_BYTES)}) — its only use is the theme-toggle flip; make that import dynamic`);
    }
  }
  if (failures.length) {
    console.error('\nBUNDLE BUDGET FAILED:');
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  console.log('\nbundle budget: dashboard motion cost within budget');
}

// Also print the raw file sizes + gzip for the shape a user actually downloads.
console.log('\nemitted files:');
for (const item of out.output) {
  const size = item.type === 'chunk' ? item.code.length : (item.source?.length ?? 0);
  const bytes = item.type === 'chunk' ? Buffer.from(item.code) : Buffer.from(item.source ?? '');
  const gzip = (await import('node:zlib')).gzipSync(bytes, { level: 9 }).length;
  console.log(`  ${item.fileName.padEnd(34)} ${kb(size).padStart(8)}  gzip ${kb(gzip)}`);
}

/**
 * The build above runs in memory (`write: false`) so this script never touches a working tree it
 * was not asked to. That is why there is no "what `dist/*.html` references" line here: it would
 * have to read a `dist/` this run did not write, and a stale answer to "what does the page load"
 * is worse than no answer. The per-page section above is computed from the same output you just
 * built, which is the honest version of the same question.
 */