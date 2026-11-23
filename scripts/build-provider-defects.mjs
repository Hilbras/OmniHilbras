/**
 * Generates `docs/architecture/provider-defects.md`: one row per provider id, with the known failure,
 * the source line that proves it, the status and the test that proves the claim.
 *
 * `node scripts/build-provider-defects.mjs [--root <9router root>] [--check]` — `--root` or
 * `NINEROUTER_ROOT` names the external tree; `--check` exits non-zero when the committed file differs
 * byte-for-byte from what this script generates. The same explicit-root / skip-without-root rule as
 * `build-9router-catalog.mjs` applies: an absent tree never looks like a green run when the caller
 * named one, and a checkout without the tree skips the external half instead of failing CI.
 *
 * The defect rows are **curated**, not inferred from a model list. A row's `source` is a path + line a
 * reader can open, and its `test` is the local check that proves the state. An id with no recorded
 * defect says so; it does not get a made-up failure to fill the column.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'docs', 'architecture', 'provider-defects.md');
const CARDS = join(ROOT, 'src', 'data', 'providers.ts');

const rootArg = process.argv.indexOf('--root');
const NINE_ROOT = rootArg >= 0
  ? resolve(process.argv[rootArg + 1] ?? '')
  : process.env.NINEROUTER_ROOT || '/home/gin/work/9router';
const REGISTRY = join(NINE_ROOT, 'open-sse', 'providers', 'registry');

/**
 * The recorded defects. Adding a row here is a deliberate edit reviewed alongside its proving test;
 * the generated document cannot grow one by accident, and a new provider id without any row at all is
 * caught by `tests/9router-catalog.test.js` and `tests/provider-cards.test.js`.
 */
const DEFECTS = {
  'codex': {
    failure: 'The pinned CLI identity was older than the published client, so catalog entries gated by minimal_client_version could be absent in a 200.',
    source: 'Kernel/SDK/codex/adapter/index.ts:19',
    status: 'fixed — identity raised to the published client version',
    test: 'Kernel/SDK/tests/codex.test.js',
  },
  'opencode-console': {
    failure: 'The free tier refuses direct requests from this host; the gateway must drive the local OpenCode service.',
    source: 'Kernel/API/src/core/opencode-service.ts:1',
    status: 'documented and mitigated — falls back to the direct lane only when no service is running',
    test: 'Kernel/API/test/opencode-runtime-ui.test.js',
  },
  'deepseek': {
    failure: 'The reference strips tool definitions on its wire; OmniHilbras refuses an unserved contract before spending a request instead.',
    source: '9router/open-sse/providers/registry/deepseek.js:31',
    status: 'documented divergence',
    test: 'tests/tools-caps.test.js',
  },
  // xAI and Claude had cards and chat adapters already; the missing half was the video flow and the
  // authorization-code sign-in respectively. Saying "no card, adapter or flow" for either overstated
  // the finding and could misdirect the next cycle, so each now records exactly what was closed.
  'xai': {
    failure: 'The reference ships an async video lane for xAI; OmniHilbras served /v1/videos but refused every job.',
    source: '9router/open-sse/providers/registry/xai.js:44',
    status: 'fixed — dedicated SDK adapter creates and polls real jobs with the pinned connection',
    test: 'Kernel/API/test/video-route.test.js',
  },
  'claude': {
    failure: 'The reference ships a plain authorization-code + PKCE sign-in for claude; OmniHilbras had no flow for that id.',
    source: '9router/src/lib/oauth/providers/claude.js:2',
    status: 'fixed — separate card, adapter and PKCE S256 flow on its own connection',
    test: 'Kernel/API/test/oauth-claude.test.js',
  },
  ...Object.fromEntries(['gemini-cli', 'cursor', 'zed', 'glm'].map((id) => [id, {
    failure: 'The reference ships a registry/OAuth flow for this id; OmniHilbras has no card, adapter or flow.',
    source: `9router/open-sse/providers/registry/${id}.js:1`,
    status: 'gap — parity backlog',
    test: 'tests/9router-catalog.test.js',
  }])),
};

const escapeCell = (value) => String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');

function cardIds() {
  const source = readFileSync(CARDS, 'utf8');
  const rows = [];
  source.split('\n').forEach((line, index) => {
    const match = /^\s*id:\s*'([^']+)'/.exec(line);
    if (match) rows.push({ id: match[1], line: index + 1 });
  });
  return rows;
}

function registryIds() {
  if (!existsSync(REGISTRY)) return [];
  return readdirSync(REGISTRY)
    .filter((file) => file.endsWith('.js') && file !== 'index.js')
    .sort()
    .map((file) => {
      const source = readFileSync(join(REGISTRY, file), 'utf8');
      const text = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      const match = /^\s*id:\s*["']([^"']+)/m.exec(text);
      return { id: match?.[1] ?? file.replace(/\.js$/, ''), file };
    });
}

const cards = cardIds();
const registry = registryIds();
const nine = new Map(registry.map((entry) => [entry.id, entry]));
const oh = new Map(cards.map((entry) => [entry.id, entry]));
const ids = [...new Set([...cards.map((entry) => entry.id), ...registry.map((entry) => entry.id)])].sort();

const lines = [];
const out = (line = '') => lines.push(line);

out('# Provider defect register');
out();
out('**Generated file — do not edit by hand.** Regenerate with `node scripts/build-provider-defects.mjs`;');
out('`node scripts/build-provider-defects.mjs --check` fails when the committed file is stale.');
out(`Source for the external half: \`open-sse/providers/registry/*.js\` in \`${NINE_ROOT}\`.`);
out(`Source for the OmniHilbras half: \`src/data/providers.ts\` (${cards.length} cards).`);
out();
out('| | Count |');
out('| --- | --- |');
out(`| Provider ids with a row | ${ids.length} |`);
out(`| OmniHilbras cards | ${cards.length} |`);
out(`| 9router registry entries | ${registry.length} |`);
out(`| Ids with a recorded defect | ${ids.filter((id) => DEFECTS[id]).length} |`);
out();
out('A row is a **recorded claim**, not a live measurement. No provider was called to build this file.');
out('`source` is a path + line a reader can open; `test` is the local check that proves the stated status.');
out('An id with no recorded defect says so rather than acquiring a fabricated failure to fill the column.');
out();
out('| Provider id | In OH | In 9R | Failure | Source | Status | Proving test |');
out('| --- | --- | --- | --- | --- | --- | --- |');
for (const id of ids) {
  const defect = DEFECTS[id];
  const ohLine = oh.get(id)?.line;
  const nineFile = nine.get(id)?.file;
  out(`| \`${escapeCell(id)}\` | ${ohLine ? `src/data/providers.ts:${ohLine}` : '—'} | ${nineFile ? `9router/open-sse/providers/registry/${nineFile}` : '—'} | ${escapeCell(defect?.failure ?? 'No defect recorded.')} | ${escapeCell(defect?.source ?? '—')} | ${escapeCell(defect?.status ?? 'no recorded defect')} | ${escapeCell(defect?.test ?? '—')} |`);
}
out();

const document = `${lines.join('\n')}\n`;

if (process.argv.includes('--check')) {
  if (!existsSync(OUT)) {
    console.error(`${OUT} does not exist. Run without --check to write it.`);
    process.exit(1);
  }
  if (readFileSync(OUT, 'utf8') !== document) {
    console.error(`${OUT} is stale relative to the cards, registry or recorded defects.`);
    process.exit(1);
  }
  console.log(`${OUT} is current.`);
} else {
  writeFileSync(OUT, document);
  console.log(`Wrote ${OUT}`);
  console.log(`  ${ids.length} ids, ${ids.filter((id) => DEFECTS[id]).length} recorded defects`);
}
