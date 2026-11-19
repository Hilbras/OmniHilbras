#!/usr/bin/env node

/**
 * The published CLI's entry point.
 *
 * ## Why this is separate from `bin/omnihilbras.js`
 *
 * They are two different products and the difference matters. The root package is **private** and its
 * `bin/omnihilbras.js` is a *developer launcher for a checkout*: it runs `pnpm dev` and `pnpm dev:gateway`
 * in this repository, and the working agreement keeps it off any publishable package so a consumer who
 * installs an SDK does not acquire a command that starts a development server.
 *
 * This one is the **client**: the verbs that ask a running gateway something. It is what a published
 * `@hilbras/omnihilbras` would install as the `omnihilbras` shortcut, and it can stand alone because none
 * of the verbs needs the checkout — they are HTTP calls to a gateway that may be started by the desktop
 * app, by a checkout, or by anything else.
 */

import { clientOnlyNotice, main } from '../index.mjs';
import { clientEntryPath, findLauncher, runLauncher } from '../lib/launcher.mjs';
import { createRequire } from 'node:module';
import path from 'node:path';

// Read from this package's own manifest, so the version a published install reports is the version that
// was published rather than a constant that can drift from it.
const { version } = createRequire(import.meta.url)('../package.json');

const argv = process.argv.slice(2);
const first = argv[0];
/**
 * `start` is an alias for the launcher's bare form. It is not a verb of the client: the client cannot
 * start anything, and inventing a verb for it would make the failure look like a feature.
 */
const startAlias = first === 'start';
/** A verb is a bare word this client may know; `start` is stripped before delegation. */
const hasVerb = first !== undefined && !first.startsWith('-') && !startAlias;

// Bare `omnihilbras` (and `omnihilbras start`, and options such as `--port`) belong to the launcher
// when one is registered. A client that printed help here is the defect this delegation exists for.
if (!hasVerb) {
  const launcher = findLauncher();
  const self = path.resolve(clientEntryPath());
  if (launcher && path.resolve(launcher.path) !== self) {
    process.exit(await runLauncher(launcher.path, startAlias ? argv.slice(1) : argv));
  }
  if (startAlias) {
    process.stdout.write(`${clientOnlyNotice()}\n`);
    process.exitCode = 2;
  } else {
    process.exitCode = await main(argv, { version });
  }
} else {
  process.exitCode = await main(argv, { version });
}
