/**
 * Remove the SDK's build output before it is rebuilt.
 *
 * ## Why this exists
 *
 * `packages/omnihilbras-sdk/dist` is consumed by two other things in this repository, and neither
 * of them builds it:
 *
 * - the dashboard's `tsc --noEmit`, which resolves `@hilbras/omnihilbras` through `node_modules`
 *   to `package.json`'s `types: ./dist/index.d.ts` — there is no `paths` mapping in the root
 *   `tsconfig.json`, so a build artifact *is* the type surface;
 * - the gateway's `tsc`, likewise.
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
 * Deliberately narrow. Only the SDK's output is removed, because only the SDK's output is consumed
 * by something that does not build it. The gateway's `dist` is the deployable and nothing in this
 * repository imports it, so there is no demonstrated failure behind cleaning it and no reason to
 * touch it.
 */

import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'omnihilbras-sdk');
const DIST = join(PACKAGE, 'dist');

rmSync(DIST, { recursive: true, force: true });
