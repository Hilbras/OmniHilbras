/**
 * Reads 9router's provider registry and emits one Markdown file: every provider, every model.
 *
 * Run from anywhere:  node scripts/build-9router-catalog.mjs [--check]
 *
 * `--check` exits non-zero when the committed file differs from what this script generates, which is
 * the only property that makes this document trustworthy: it is derived, so it is either current or
 * wrong, and there is no third state.
 *
 * The numbers in the header are counted from the parsed data, never typed in, so they cannot drift
 * from the tables below them.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REGISTRY = '/home/gin/work/9router/open-sse/providers/registry';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'architecture', '9router-provider-catalog.md');

if (!existsSync(REGISTRY)) {
  console.error(`Registry not found at ${REGISTRY}. This document is generated from that tree.`);
  process.exit(2);
}

/** One registry entry, parsed. `models` is empty when the file declares no static array. */
function parse(file) {
  const source = readFileSync(join(REGISTRY, file), 'utf8');
  // Comments are stripped so a commented-out model cannot be counted, and the line-comment pass must
  // NOT treat the `//` inside `https://` as the start of a comment. It did, and the damage was silent
  // and wrong in a way that looked like a parser bug: every `website:` line was cut at `https:`, and
  // the capture then ran across the following lines, so 118 of 124 entries rendered a link reading
  // `[site](https:\n notice: { apiKeyUrl: )`. The fix is to require a `//` that is not preceded by a
  // character that can only appear inside a URL or a regex literal.
  const text = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\w])\/\/[^\n]*/g, '$1');

  const id = /^[\s]*id:\s*["']([^"']+)/m.exec(text)?.[1] ?? file.replace(/\.js$/, '');
  const name = /display:\s*\{[\s\S]{0,600}?\bname:\s*["']([^"']+)/.exec(text)?.[1] ?? id;
  const category = /category:\s*["']([^"']+)/.exec(text)?.[1] ?? 'unknown';
  // Anchored to the `website` key rather than matched loosely, because several entries put
  // display.notice.apiKeyUrl before website in the same block, and a loose window picks up the
  // notice URL instead - a different page, and a link that goes nowhere useful. Requiring the key
  // to be preceded by whitespace keeps the two apart, since every entry here puts each key on its
  // own line.
  const website = /(?:^|[\n\r\t ])website:\s*["']([^"']+)/.exec(text)?.[1];
  const serviceKindsBlock = /serviceKinds:\s*\[([^\]]*)\]/.exec(text)?.[1];
  const serviceKinds = serviceKindsBlock?.trim()
    ? serviceKindsBlock.split(',').map((value) => value.trim().replace(/^["']|["']$/g, ''))
    : [];

  const models = [];
  const pattern = /\{\s*id:\s*["']([^"']+)["']\s*,\s*name:\s*["']([^"']*)["']([^\n]*)\}/g;
  for (const match of text.matchAll(pattern)) {
    models.push({
      id: match[1],
      name: match[2] || match[1],
      kind: /kind:\s*["']([^"']+)/.exec(match[3])?.[1] ?? null,
    });
  }

  return { id, name, category, website, serviceKinds, models, file: file.replace(/\.js$/, '') };
}

const entries = readdirSync(REGISTRY)
  .filter((file) => file.endsWith('.js') && file !== 'index.js')
  .sort()
  .map(parse);

const totalModels = entries.reduce((sum, entry) => sum + entry.models.length, 0);
const withModels = entries.filter((entry) => entry.models.length > 0);
const dynamicOnly = entries.filter((entry) => entry.models.length === 0);

const count = (list, key) => {
  const tally = new Map();
  for (const item of list) tally.set(item[key], (tally.get(item[key]) ?? 0) + 1);
  return [...tally.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
};

const MODEL_KIND_LABEL = {
  image: 'image generation',
  stt: 'speech-to-text',
  embedding: 'embeddings',
  tts: 'text-to-speech',
  systemone: 'system (non-LLM)',
  video: 'video',
};

const lines = [];
const out = (line = '') => lines.push(line);

out('# 9router provider and model catalog');
out();
out('**Generated file — do not edit by hand.**');
out('Source: `open-sse/providers/registry/*.js` in `/home/gin/work/9router`.');
out('Regenerate with `node scripts/build-9router-catalog.mjs`; `node scripts/build-9router-catalog.mjs --check`');
out('fails when the committed file is stale.');
out();
out('| | Count |');
out('| --- | --- |');
out(`| Registry entries | ${entries.length} |`);
out(`| Models declared in the registry | ${totalModels} |`);
out(`| Entries with a static model list | ${withModels.length} |`);
out(`| Entries that resolve models at runtime | ${dynamicOnly.length} |`);
out();
out('A model id here is a **string the registry declares**. Nothing in this file is a measurement:');
out('none of it was confirmed by calling a provider, and a model id being present is not evidence');
out('that the model is reachable, that it still exists, or that any account can use it. Several');
out('entries list models that only a paid tier serves.');
out();

out('## Entries by category');
out();
out('| Category | Entries |');
out('| --- | --- |');
for (const [key, n] of count(entries, 'category')) out(`| \`${key}\` | ${n} |`);
out();

out('## Models by kind');
out();
const kindTally = new Map();
for (const entry of entries) for (const model of entry.models) {
  kindTally.set(model.kind ?? 'chat / language', (kindTally.get(model.kind ?? 'chat / language') ?? 0) + 1);
}
out('| Kind | Models |');
out('| --- | --- |');
for (const [key, n] of [...kindTally.entries()].sort((a, b) => b[1] - a[1])) {
  out(`| ${MODEL_KIND_LABEL[key] ? `${MODEL_KIND_LABEL[key]} (\`${key}\`)` : key} | ${n} |`);
}
out();

out('## Providers');
out();
out('Each entry lists every model the registry file declares. `kind` is shown only when it is');
out('something other than chat.');
out();

for (const [category, entriesInCategory] of groupByCategory(entries)) {
  out(`### ${category}`);
  out();
  for (const entry of entriesInCategory) {
    const label = entry.name === entry.id ? `\`${entry.id}\`` : `\`${entry.id}\` — ${entry.name}`;
    const notes = [];
    if (entry.website) notes.push(`[site](${entry.website})`);
    if (entry.serviceKinds.length) notes.push(entry.serviceKinds.map((k) => `\`${k}\``).join(', '));
    out(`#### ${label}${notes.length ? ` <sub>${notes.join(' · ')}</sub>` : ''}`);
    out();
    if (entry.models.length === 0) {
      out('- No static model list. This entry resolves its models at runtime — from the account, the');
      out('  provider\'s own catalogue endpoint, or a local daemon — so nothing can be enumerated here.');
      out();
      continue;
    }
    out('| Model id | Name | Kind |');
    out('| --- | --- | --- |');
    for (const model of entry.models) {
      const kind = model.kind ? MODEL_KIND_LABEL[model.kind] ?? model.kind : 'chat';
      out(`| \`${model.id}\` | ${escapeCell(model.name)} | ${kind} |`);
    }
    out();
  }
}

out('## Entries with no static model list');
out();
out('These are listed separately because "no models" and "zero models" are different facts, and only');
out('one of them is a statement about this registry.');
out();
out('| Entry | Category | Service kinds |');
out('| --- | --- | --- |');
for (const entry of dynamicOnly) {
  out(`| \`${entry.id}\` | ${entry.category} | ${entry.serviceKinds.map((k) => `\`${k}\``).join(', ') || '—'} |`);
}
out();

function groupByCategory(list) {
  const groups = new Map();
  for (const entry of list) {
    if (!groups.has(entry.category)) groups.set(entry.category, []);
    groups.get(entry.category).push(entry);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function escapeCell(value) {
  return String(value).replace(/\|/g, '\\|');
}

const document = `${lines.join('\n')}\n`;

if (process.argv.includes('--check')) {
  if (!existsSync(OUT)) {
    console.error(`${OUT} does not exist. Run without --check to write it.`);
    process.exit(1);
  }
  if (readFileSync(OUT, 'utf8') !== document) {
    console.error(`${OUT} is stale relative to the registry.`);
    process.exit(1);
  }
  console.log(`${OUT} is current.`);
} else {
  writeFileSync(OUT, document);
  console.log(`Wrote ${OUT}`);
  console.log(`  ${entries.length} entries, ${totalModels} models, ${dynamicOnly.length} resolve at runtime`);
}