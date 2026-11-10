/**
 * Packaged-size audit.
 *
 * The app is an Electron runtime plus `app.asar` plus the unpacked gateway. "The installer is 109 MB"
 * says nothing about which of those grew, so this prints the split and the largest unpacked entries.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const release = join(root, 'release');

function sizeOf(path) {
  try {
    const info = statSync(path);
    if (!info.isDirectory()) return info.size;
    return readdirSync(path).reduce((sum, entry) => sum + sizeOf(join(path, entry)), 0);
  } catch {
    return 0;
  }
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const unpacked = join(release, 'linux-unpacked');
if (!statSync(unpacked, { throwIfNoEntry: false })) {
  console.error('release/linux-unpacked is missing; run `pnpm app:build` first.');
  process.exit(1);
}

const asar = join(unpacked, 'resources/app.asar');
const asarUnpacked = join(unpacked, 'resources/app.asar.unpacked');
const entries = ['resources/app.asar', 'resources/app.asar.unpacked', 'locales']
  .map((name) => [name, sizeOf(join(unpacked, name))]);
const rest = sizeOf(unpacked) - entries.reduce((sum, [, bytes]) => sum + bytes, 0);

console.log(`unpacked app        ${mb(sizeOf(unpacked))}`);
console.log(`  ${relative(unpacked, asar) || 'app.asar'}        ${mb(sizeOf(asar))}`);
console.log(`  app.asar.unpacked ${mb(sizeOf(asarUnpacked))}`);
console.log(`  locales           ${mb(sizeOf(join(unpacked, 'locales')))}`);
console.log(`  electron runtime  ${mb(rest)}`);

const unpackedTop = readdirSync(asarUnpacked, { withFileTypes: true })
  .map((entry) => [entry.name, sizeOf(join(asarUnpacked, entry.name))])
  .sort((a, b) => b[1] - a[1])
  .slice(0, 8);
console.log('\nlargest unpacked entries:');
for (const [name, bytes] of unpackedTop) console.log(`  ${name.padEnd(24)} ${mb(bytes)}`);

for (const file of readdirSync(release).filter((name) => /\.(deb|exe|zip|dmg|AppImage)$/.test(name))) {
  console.log(`\n${file.padEnd(36)} ${mb(sizeOf(join(release, file)))}`);
}
