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

import { main } from '../index.mjs';
import { createRequire } from 'node:module';

// Read from this package's own manifest, so the version a published install reports is the version that
// was published rather than a constant that can drift from it.
const { version } = createRequire(import.meta.url)('../package.json');

process.exitCode = await main(process.argv.slice(2), { version });
