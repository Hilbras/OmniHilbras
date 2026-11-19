/**
 * `omnihilbras update` — check for a newer release, or install it.
 *
 * The check is fail-open and the install is **opt-in**: running this verb is the person asking for the
 * upgrade, so it runs `npm i -g @hilbras/omnihilbras@latest`. `--check` only reports. The launcher never
 * runs this on its own — it only notices a newer version and points here.
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { CliError } from '../lib/client.mjs';
import { checkForUpdate, updateCommand, PACKAGE_NAME } from '../lib/update.mjs';

const { version } = createRequire(import.meta.url)('../package.json');

export const update = {
  name: 'update',
  summary: 'Check for a newer release, or install it',
  usage: 'omnihilbras update [--check] [--json]',
  flags: ['--check'],
  async run({ out, flags }) {
    const result = await checkForUpdate(version);
    out.data(result);

    if (flags.check) {
      if (out.json) return 0;
      if (result.updateAvailable) out.line(out.warn(`A newer version is available: ${result.current} → ${result.latest}. Run \`omnihilbras update\` to install it.`));
      else out.line(out.muted(result.latest ? `Up to date (${result.current}).` : 'Could not reach the registry to check for updates.'));
      return 0;
    }

    if (!result.updateAvailable) {
      out.line(out.muted(result.latest ? `Already up to date (${result.current}).` : 'Could not reach the registry; nothing to do.'));
      return 0;
    }

    out.line(`Updating ${result.current} → ${result.latest}…`);
    try {
      execFileSync('npm', ['i', '-g', `${PACKAGE_NAME}@latest`], { stdio: 'inherit', timeout: 180000 });
    } catch (error) {
      throw new CliError('The update did not complete.', { hint: `Run \`${updateCommand()}\` manually. ${error.message}` });
    }
    out.title(`Updated to ${result.latest}. Restart any running servers with \`omnihilbras restart\`.`);
    return 0;
  },
};
