import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The SDK's provider sources, read from its provider folders.
 *
 * Each provider is a folder under `packages/omnihilbras-sdk/src/providers/`, and its code is the
 * folder's `index.ts`. The shared base `openai-compatible` is a folder too, but providers extend it,
 * so it is not itself a provider and is left out.
 */
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const PROVIDERS = join(ROOT, 'packages/omnihilbras-sdk/src/providers');
const SHARED_BASES = new Set(['openai-compatible']);

/** `[{ id, file }]` for each provider, where `file` is its `index.ts`. */
export function providerFiles() {
  return readdirSync(PROVIDERS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !SHARED_BASES.has(entry.name))
    .map((entry) => ({ id: entry.name, file: join(PROVIDERS, entry.name, 'index.ts') }));
}

/** The source of every provider's `index.ts`, keyed by provider id. */
export function providerSources(read = (file) => readFileSync(file, 'utf8')) {
  return Object.fromEntries(providerFiles().map(({ id, file }) => [id, read(file)]));
}

/** The source of one file inside the SDK's `src/`, by its path relative to `src/`. */
export function sdkSource(relative, read = (file) => readFileSync(file, 'utf8')) {
  return read(join(ROOT, 'packages/omnihilbras-sdk/src', relative));
}

export { PROVIDERS, ROOT };
