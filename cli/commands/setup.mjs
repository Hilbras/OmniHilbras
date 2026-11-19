/**
 * `omnihilbras setup` — the first-run terminal.
 *
 * What it is for: a person who just installed this should not have to read a README to find out that
 * `pnpm` is missing. So it checks, *says* what it found, and offers the two things that follow from that —
 * install what is missing, and deal with an older copy of this project that is still on the machine.
 *
 * Two rules it does not bend:
 *
 * - **Nothing is installed without being shown first.** The exact command line is printed and confirmed.
 *   `--yes` skips the confirmation for automation, and still prints it.
 * - **Nothing is removed here.** Uninstalling lives in `scripts/uninstall/`, which shows the file list
 *   before it deletes anything; a first-run wizard is the wrong place to hold a delete key.
 *
 * Without a terminal it refuses to guess: it prints the report and the commands, and exits non-zero if
 * something blocking was found. A prompt nobody can answer is a hang, and a wizard that silently does
 * nothing is worse than one that says why.
 */

import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import { inspect } from '../lib/detect.mjs';
import { registerLauncher } from '../lib/launcher.mjs';
import { inspectShortcut, installShortcut, shortcutTarget } from '../lib/shortcut.mjs';

const SEVERITY_LABEL = { blocking: 'blocking', 'needed-from-source': 'from source', optional: 'optional' };

/** Runs one fix command, with its output attached — the person asked for it, so they should see it. */
function runFix(command) {
  return new Promise((resolve) => {
    const child = spawn(command, [], { shell: true, stdio: 'inherit' });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

export const setup = {
  name: 'setup',
  summary: 'First-run check: what is missing, and what to do about it',
  usage: 'omnihilbras setup [--yes] [--json]',
  flags: ['--yes'],
  async run({ out, flags, client }) {
    const report = await inspect();
    // A gateway that is not running is the normal state of a fresh install, so it is reported rather than
    // thrown — `setup` exists precisely for the case where nothing is running yet.
    let gateway;
    try {
      const health = await client.request('/health');
      gateway = { reachable: true, version: health.build?.version };
    } catch {
      gateway = { reachable: false };
    }

    const blocking = report.gaps.filter((gap) => gap.severity === 'blocking');
    out.data({ ...report, gateway, blocking: blocking.length });

    if (out.json) return blocking.length > 0 ? 1 : 0;

    out.title('Omnihilbras setup');
    out.line(`  ${out.muted('node')}     ${report.runtime.node}${report.runtime.nodeSatisfies ? out.ok(' ok') : out.bad(` — needs v${report.runtime.requiredNodeMajor}+`)}`);
    out.line(`  ${out.muted('pnpm')}     ${report.runtime.pnpm ?? out.warn('not found')}`);
    out.line(`  ${out.muted('git')}      ${report.runtime.git ?? out.warn('not found')}`);
    out.line(`  ${out.muted('gateway')}  ${gateway.reachable ? out.ok(`${gateway.version} running`) : out.warn('not running')}`);
    if (report.otherVersionCount > 0) out.line(`  ${out.muted('others')}   ${out.warn(`${report.otherVersionCount} other installation${report.otherVersionCount === 1 ? '' : 's'} found`)}`);

    /**
     * The shortcut, reported the way everything else here is: what is actually true.
     *
     * A foreign `omnihilbras` is the interesting case and gets the command that removes it, because the
     * alternative — silently replacing an older installation's command — breaks something the person still
     * has. The count of "other installations" above and this line are usually about the same thing.
     */
    const shortcut = inspectShortcut();
    // The checkout's launcher can start the servers; the published package's client cannot. Deciding
    // this from `shortcutTarget()` is the same answer the shortcut itself uses, so setup cannot offer a
    // start that the linked command would not perform.
    const startTarget = shortcutTarget();
    const canStart = startTarget?.kind === 'launcher';
    /**
     * Record the launcher even when the shortcut cannot be installed.
     *
     * The shortcut and the delegation answer different questions: the shortcut decides what `PATH`
     * runs, while this record lets the **published client** — which may still own `PATH` — hand a
     * bare invocation to the checkout. Recording it here is what makes `npm i -g` followed by
     * `omnihilbras setup` survive a later reinstall of the client.
     */
    if (canStart && startTarget) {
      try {
        registerLauncher(startTarget.path);
      } catch {
        // A read-only config directory is reported by the shortcut's own failure below; the verbs
        // still work, and a launcher that cannot be recorded is not a reason to fail setup.
      }
    }
    if (!shortcut.present) {
      const foreign = shortcut.foreign[0];
      // "Not on PATH" alone was false where an older global install still provides the command, so where
      // one exists it is named.
      out.line(`  ${out.muted('command')}  ${foreign
        ? out.warn(`this checkout's shortcut is absent; \`omnihilbras\` resolves to ${foreign}`)
        : out.warn('omnihilbras is not on PATH')}`);
    }
    else if (shortcut.pointsAtUs) {
      const where = shortcut.onPath ? out.ok('on PATH') : out.warn('not on PATH yet');
      out.line(`  ${out.muted('command')}  ${shortcut.commandPath} ${out.muted(`(${where})`)}`);
    } else if (shortcut.link) {
      out.line(`  ${out.muted('command')}  ${out.warn(`${shortcut.commandPath} belongs to something else`)} ${out.muted(`→ ${shortcut.link}`)}`);
      out.line(`             ${out.muted('npm rm -g @hilbras/omnihilbras')} ${out.muted('removes the older one, if that is what it is')}`);
    } else {
      out.line(`  ${out.muted('command')}  ${out.warn(`${shortcut.commandPath} exists and is not ours`)}`);
    }
    out.line();

    /**
     * Without a terminal there is nobody to answer, and inventing an answer is how a wizard installs
     * something nobody asked for. Print the plan and stop, with an exit code a script can act on.
     */
    if (!(process.stdin.isTTY && process.stdout.isTTY)) {
      /**
       * `--yes` is what makes this usable from a script, and it is also the only way to install the
       * shortcut without a terminal. Nothing else in this branch changes anything: the report is the point
       * of running `setup` non-interactively, and `doctor` exists for the read-only case.
       */
      if (flags.yes && !shortcut.pointsAtUs) {
        out.line();
        const result = await installShortcut();
        out.line(result.ok
          ? out.ok(`  installed the \`omnihilbras\` command: ${result.commandPath} → ${result.version ?? 'no version printed'}`)
          : out.bad(`  could not install the shortcut: ${result.reason}`));
        if (result.ok && result.hint) out.line(`  ${out.warn(result.hint)}`);
        if (result.ok && shortcut.foreign[0]) {
          out.line(`  ${out.warn(`Note: ${shortcut.foreign[0]} also provides \`omnihilbras\`; whichever directory comes first on PATH wins.`)}`);
        }
      }
      if (!canStart) {
        out.line(out.muted('Starting the servers is the desktop app, or a checkout linked with `npm link`;'));
        out.line(out.muted('this installed command is the client.'));
      }
      if (report.gaps.length > 0) {
        out.title('Run these to finish setting up');
        for (const gap of report.gaps) out.line(`  ${gap.fix}   ${out.muted(`# ${gap.title}`)}`);
      } else {
        out.line(out.ok('Everything the gateway needs is present.'));
      }
      if (report.otherVersionCount > 0) out.line(`\n${out.muted('Other versions found; `omnihilbras doctor` lists them, `scripts/uninstall/` removes them.')}`);
      return blocking.length > 0 ? 1 : 0;
    }

    // One interface for the whole session. Creating one per question leaks a listener per prompt, and the
    // process then will not exit on its own after the last answer.
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      for (;;) {
        const options = [];
        if (report.gaps.length > 0) options.push(['install the missing tools', 'gaps']);
        if (!shortcut.pointsAtUs) options.push(['install the `omnihilbras` command', 'shortcut']);
        options.push(['show the full report', 'report']);
        if (report.otherVersionCount > 0) options.push(['remove another version on this machine', 'uninstall']);
        // Only the checkout launcher can start both halves. Offering it from the published client
        // spawned `node_modules/bin/omnihilbras.js`, a path that does not exist in the tarball.
        if (canStart) options.push(['start the gateway and dashboard', 'start']);
        options.push(['exit', 'exit']);

        if (!canStart) {
          out.line(out.muted('The servers start from the desktop app or a checkout (`npm link`); this command is the client.'));
        }
        out.line(out.muted('What next?'));
        options.forEach(([label], index) => out.line(`  ${index + 1}. ${label}`));
        const answer = (await rl.question('  > ')).trim();
        const chosen = options[Number(answer) - 1]?.[1] ?? 'exit';

        switch (chosen) {
          case 'gaps': {
            for (const gap of report.gaps) {
              out.line();
              out.line(`${SEVERITY_LABEL[gap.severity] ?? gap.severity}  ${gap.title}`);
              out.line(`  ${out.muted(gap.detail)}`);
              out.line(`  command: ${gap.fix}`);
              const go = flags.yes || (await rl.question('  Run it? [y/N] ')).trim().toLowerCase().startsWith('y');
              if (!go) {
                out.line(out.muted('  skipped'));
                continue;
              }
              const code = await runFix(gap.fix);
              out.line(code === 0 ? out.ok('  done') : out.bad(`  exited ${code} — run it yourself to see why`));
            }
            break;
          }
          case 'shortcut': {
            const target = shortcut.target;
            out.line();
            if (!target) {
              out.line(out.warn('  Neither this checkout nor the CLI package could be found.'));
              break;
            }
            out.line(`  It will link ${out.ok(shortcut.commandPath)}`);
            out.line(`  to ${target.path}`);
            out.line();
            out.line(target.kind === 'launcher'
              ? `  That entry point runs ${out.ok('both halves')}: a verb asks the gateway something, and no verb starts the gateway and the dashboard.`
              : `  That entry point is the ${out.warn('published client')}: verbs work, and starting the servers does not — there is no checkout for it to run.`);
            if (!shortcut.onPath) out.line(`  ${out.warn(`${shortcut.directory} is not on PATH yet; you will need a new shell, and possibly to add it.`)}`);
            out.line();
            const go = flags.yes || (await rl.question('  Create it? [y/N] ')).trim().toLowerCase().startsWith('y');
            if (!go) {
              out.line(out.muted('  skipped'));
              break;
            }
            const result = await installShortcut();
            if (result.ok) {
              // The verification is a run of the command itself; the version is reported as measured.
              out.line(out.ok(`  installed, and it runs: ${out.muted(result.commandPath)} → ${result.version ?? 'no version printed'}`));
              if (result.hint) out.line(`  ${out.warn(result.hint)}`);
            } else {
              out.line(out.bad(`  not installed: ${result.reason}`));
              if (result.hint) out.line(`  ${out.muted(result.hint)}`);
            }
            break;
          }
          case 'report': {
            const { doctor } = await import('./doctor.mjs');
            out.line();
            await doctor.run({ out, flags: {}, client });
            break;
          }
          case 'uninstall': {
            // A pointer, not an action: removal prints a file list and asks, and that belongs in one place
            // rather than two copies that can disagree about what "uninstalled" means.
            const command = report.runtime.platform === 'win32'
              ? 'powershell -File scripts/uninstall/windows.ps1'
              : 'bash scripts/uninstall/unix.sh';
            out.line();
            out.line('  Uninstallers live in scripts/uninstall/. Each prints everything it would remove and');
            out.line('  asks first, and leaves your vault alone unless you pass --purge-data:');
            out.line(`    ${command}`);
            break;
          }
          case 'start': {
            // Started through the checkout's own entry point rather than through whatever `omnihilbras`
            // resolves to: this verb's job is to start *these* servers, and the command on PATH may be the
            // published client, which cannot. `canStart` above is the same check, so this path exists.
            if (!startTarget || startTarget.kind !== 'launcher') break;
            out.line();
            out.line(out.muted('  Starting. Ctrl-C stops both servers.'));
            out.line();
            rl.close();
            const child = spawn(process.execPath, [startTarget.path], { stdio: 'inherit' });
            return await new Promise((resolve) => child.on('close', (code) => resolve(code ?? 0)));
          }
          default:
            return 0;
        }
        out.line();
      }
    } finally {
      rl.close();
    }
  },
};
