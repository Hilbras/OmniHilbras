#!/usr/bin/env node

/**
 * `omnihilbras <verb>` — the gateway's client.
 *
 * ## Why this exists next to the launcher
 *
 * `bin/omnihilbras.js` starts things. Until now there was nothing that let a person or a script *ask the
 * gateway something* without curl, and curl needs the management headers, the JSON shapes and the
 * dashboard token to be assembled by hand every time. The verbs here are thin: each one calls a route the
 * gateway already serves, so a change to a route breaks the CLI and the dashboard in the same way rather
 * than in two.
 *
 * ## The rules this follows
 *
 * - **No dependencies.** The launcher's own comment makes the argument — "one dependency to draw twelve
 *   frames would be a poor trade" — and it applies harder here: the CLI is on the same trust footing as
 *   the launcher, so its dependency tree being empty is a feature, not an aesthetic.
 * - **`--json` is the whole answer**, on every verb, so a script never parses a table.
 * - **Errors carry a next step.** A failure says what happened *and* what to do; a message that only
 *   states the fact gets read as a bug.
 * - **Exit codes mean something**: `0` fine, `1` the thing did not work, `2` the command was wrong, `130`
 *   interrupted.
 * - **Nothing that starts work happens before argument parsing.** The reference implementation ran its
 *   runtime self-heal ahead of `--help`, so asking for help could install packages; here `--help` reads a
 *   string and exits.
 */

import { CliError, createClient } from './lib/client.mjs';
import { createOutput } from './lib/output.mjs';
import { doctor } from './commands/doctor.mjs';
import { keys } from './commands/keys.mjs';
import { logs } from './commands/logs.mjs';
import { models } from './commands/models.mjs';
import { open } from './commands/open.mjs';
import { providers } from './commands/providers.mjs';
import { ps } from './commands/ps.mjs';
import { restart } from './commands/restart.mjs';
import { routing } from './commands/routing.mjs';
import { setup } from './commands/setup.mjs';
import { status } from './commands/status.mjs';
import { stop } from './commands/stop.mjs';
import { test } from './commands/test.mjs';
import { update } from './commands/update.mjs';

export const verbs = { setup, doctor, status, ps, open, stop, restart, update, providers, models, test, keys, routing, logs };

/** Flags every verb accepts, so none of them has to re-implement them or forget one. */
const globalFlags = new Set(['--json', '--gateway', '--api-key', '--help', '-h']);

const valueFlags = new Set(['--gateway', '--api-key', '--provider', '--mint', '--limit']);

export function parseArgv(argv) {
  const args = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      args.push(...argv.slice(index + 1));
      break;
    }
    if (token.startsWith('-')) {
      const [name, inline] = token.includes('=') ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)] : [token, undefined];
      const key = name.replace(/^--?/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      if (valueFlags.has(name)) {
        const value = inline ?? argv[index + 1];
        if (value === undefined || (value.startsWith('-') && !/^-?\d/.test(value))) {
          throw new CliError(`\`${name}\` needs a value.`, { code: 2 });
        }
        if (inline === undefined) index += 1;
        flags[key] = name === '--limit' ? Number(value) : value;
      } else {
        flags[key] = true;
      }
      continue;
    }
    args.push(token);
  }
  return { args, flags };
}

/**
 * What the command is, in the words that decide whether "no verb" can start anything.
 *
 * The two entry points share this text. `bin/omnihilbras.js` in a checkout is the **launcher**: no
 * verb starts the gateway and the dashboard. The published `cli/bin/omnihilbras.js` is the **client**:
 * there is no checkout, so no verb cannot start a server. The footer used to say the launcher's line in
 * both cases, and a person who followed `npm i -g` and typed `omnihilbras` was told it had just started
 * servers it cannot start.
 */
export function usage({ launcher = false } = {}) {
  const rows = Object.values(verbs).map((verb) => [`  ${verb.usage.replace('omnihilbras ', '')}`, verb.summary]);
  return `omnihilbras — the gateway's client

  omnihilbras <verb> [options]

Verbs
${rows.map(([left, right]) => `${left.padEnd(46)}${right}`).join('\n')}

Options
  --gateway <url>      gateway to talk to       (default 127.0.0.1:20138, or OMNIHILBRAS_GATEWAY_URL)
  --api-key <key>      authenticate with a key  (default: the local dashboard token; or OMNIHILBRAS_API_KEY)
  --json               print the answer as JSON, and nothing else
  -h, --help           this text
  -v, --version        print the version

${launcher
    ? 'Run `omnihilbras` with no verb to start the gateway and the dashboard.'
    : 'This installed command is the gateway client. With a checkout launcher registered\n(`omnihilbras setup` in the checkout), no verb starts the servers; otherwise it says how.\nThe desktop app is the zero-checkout way to start them.'}`;
}

/** Shown only by the published client when no launcher is registered, before the verb list. */
export function clientOnlyNotice() {
  return `This is the gateway client. It cannot start a gateway or the dashboard.

To start the servers:
  • open the OmniHilbras desktop app, or
  • from a checkout: pnpm install && npm link, then run \`omnihilbras\`
    (the checkout's \`omnihilbras setup\` records it for this installed client)`;
}

export async function run(argv, { version, launcher = false } = {}) {
  const { args, flags } = parseArgv(argv);
  const name = args.shift();

  if (flags.version || name === 'version') {
    process.stdout.write(`${version ?? 'unknown'}\n`);
    return 0;
  }
  const bare = name === undefined && !flags.help;
  if (flags.help || name === undefined || name === 'help') {
    if (bare && !launcher) process.stdout.write(`${clientOnlyNotice()}\n\n`);
    process.stdout.write(`${usage({ launcher })}\n`);
    return bare ? 2 : 0;
  }

  const verb = verbs[name];
  if (!verb) {
    throw new CliError(`\`${name}\` is not a verb this CLI knows.`, { code: 2, hint: `Run \`omnihilbras help\` for the list.` });
  }

  // An unknown flag is refused rather than ignored: a silently dropped `--strict` on the wrong verb is a
  // check that never ran, which is worse than one that is missing.
  const accepted = new Set([...globalFlags, ...(verb.flags ?? [])]);
  for (const flag of Object.keys(flags)) {
    const asWritten = `--${flag.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
    if (!accepted.has(asWritten)) {
      throw new CliError(`\`${verb.name}\` does not take \`${asWritten}\`.`, { code: 2, hint: `Usage: ${verb.usage}` });
    }
  }

  const client = createClient(flags);
  const out = createOutput({ json: Boolean(flags.json) });
  return (await verb.run({ client, out, args, flags })) ?? 0;
}

/** The entry used by `bin/omnihilbras.js`; owns the exit code and the error rendering. */
export async function main(argv, { version, launcher = false } = {}) {
  try {
    const code = await run(argv, { version, launcher });
    process.exitCode = code;
    return code;
  } catch (error) {
    const failure = error instanceof CliError ? error : new CliError(error instanceof Error ? error.message : String(error));
    process.stderr.write(`\u2716 ${failure.message}\n`);
    if (failure.hint) process.stderr.write(`  ${failure.hint}\n`);
    process.exitCode = failure.exitCode;
    return failure.exitCode;
  }
}
