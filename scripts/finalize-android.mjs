import { copyFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';

const out = join(process.cwd(), 'dist-android');

const entries = await readdir(out);
const html = entries.find((entry) => entry.endsWith('.html'));
if (!html) throw new Error('The Android build produced no HTML entry.');
if (html !== 'index.html') await rename(join(out, html), join(out, 'index.html'));

// The dashboard has no marketing shell in this build; keep its icon and theme boot available.
for (const file of ['favicon.svg', 'theme-boot.js']) {
  try {
    await copyFile(join(out, file), join(out, file));
  } catch {
    // Vite already copied public files; a missing optional file is not a build failure.
  }
}

console.log(`android shell: ${html} → index.html`);
