/**
 * Remove build output before it is rebuilt.
 *
 * ## Why this exists
 *
 * `tsc` emits over `dist/` and never empties it first. So a stale artifact outlives the source that
 * produced it, and a local tree can typecheck against an export that no longer exists in any
 * `.ts` file. The developer sees green. A fresh checkout — CI, a new machine, a teammate — sees
 * `TS2307: Cannot find module`. That divergence is exactly how 25 consecutive CI runs failed while
 * every local run passed.
 *
 * Cleaning first removes the divergence rather than testing for it: once `dist/` is rebuilt from
 * scratch every time, a local tree and a fresh checkout are the same tree, and there is no leftover
 * state left for the two to disagree about.
 *
 * ## What is cleaned
 *
 * - One `Kernel/SDK/<provider>/dist` per package. There is no single `Kernel/SDK/dist` any more.
 * - `Kernel/API/dist` when `--gateway` is passed. The dashboard imports
 *   `@omnihilbras/kernel-api/public` from that directory, so it has the same stale-artifact problem;
 *   the gateway's own `build` script calls this before `tsc`.
 */

import { readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sdkRoot = join(root, 'Kernel', 'SDK');

const gatewayOnly = process.argv.includes('--gateway');

if (gatewayOnly) {
  rmSync(join(root, 'Kernel', 'API', 'dist'), { recursive: true, force: true });
} else {
  for (const entry of readdirSync(sdkRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) rmSync(join(sdkRoot, entry.name, 'dist'), { recursive: true, force: true });
  }
}
