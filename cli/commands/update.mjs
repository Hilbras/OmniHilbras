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

    if (flags.check) {
      out.data(result);
      if (out.json) return 0;
      if (result.updateAvailable) out.line(out.warn(`A newer version is available: ${result.current} → ${result.latest}. Run \`omnihilbras update\` to install it.`));
      else out.line(out.muted(result.latest ? `Up to date (${result.current}).` : 'Could not reach the registry to check for updates.'));
      return 0;
    }

    if (!result.updateAvailable) {
      out.data({ ...result, installed: result.current });
      if (out.json) return 0;
      out.line(out.muted(result.latest ? `Already up to date (${result.current}).` : 'Could not reach the registry; nothing to do.'));
      return 0;
    }

    if (!out.json) out.line(`Updating ${result.current} → ${result.latest}...`);
    try {
      // `--json` must remain one document. npm's progress output is human-oriented, so it is captured
      // and discarded rather than inherited into a machine-readable answer.
      execFileSync('npm', ['i', '-g', `${PACKAGE_NAME}@latest`], {
        stdio: out.json ? 'pipe' : 'inherit',
        timeout: 180000,
        shell: process.platform === 'win32',
      });
    } catch (error) {
      throw new CliError('The update did not complete.', { hint: `Run \`${updateCommand()}\` manually. ${error.message}` });
    }
    let installed = result.latest;
    try {
      const listing = execFileSync('npm', ['ls', '-g', '--depth=0', '--json', PACKAGE_NAME], {
        encoding: 'utf8',
        timeout: 15_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });
      const parsed = JSON.parse(listing);
      installed = parsed?.dependencies?.[PACKAGE_NAME]?.version ?? installed;
    } catch {
      // The install command succeeded but the post-check could not run. Say that rather than claiming
      // the requested version is what is now on disk.
    }
    out.data({ ...result, installed });
    if (out.json) return 0;
    out.title(installed === result.latest
      ? `Updated to ${installed}. Restart any running servers with \`omnihilbras restart\`.`
      : `The installer finished, but the installed version is ${installed}, not ${result.latest}.`);
    return 0;
  },
};
