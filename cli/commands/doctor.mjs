/**
 * `omnihilbras doctor` — what this machine has, and what it is missing.
 *
 * Reports only: every fix is printed as a command for a person to run, and nothing here executes one.
 * `setup` is the verb that runs them, after showing what they are. Splitting report from act is what
 * makes this safe to run anywhere, including in a script or on someone else's machine.
 */

import { inspect } from '../lib/detect.mjs';
import { inspectShortcut } from '../lib/shortcut.mjs';

const SEVERITY_LABEL = {
  blocking: 'blocking',
  'needed-from-source': 'from source',
  optional: 'optional',
};

export const doctor = {
  name: 'doctor',
  summary: 'Check the runtime, the tools, and every Omnihilbras install on this machine',
  usage: 'omnihilbras doctor [--json] [--installs]',
  flags: ['--installs'],
  async run({ out, flags, client }) {
    const report = await inspect();

    // The gateway is a separate process and may simply not be running; that is a fact about the moment,
    // not a defect in the installation, so it is reported the same way as the rest and never thrown.
    let gateway;
    try {
      const health = await client.request('/health');
      gateway = { reachable: true, version: health.build?.version, status: health.status, url: client.baseUrl };
    } catch (error) {
      gateway = { reachable: false, url: client.baseUrl, reason: error instanceof Error ? error.message : String(error) };
    }

    const blocking = report.gaps.filter((gap) => gap.severity === 'blocking');
    out.data({ ...report, gateway, blocking: blocking.length });

    if (out.json) return blocking.length > 0 ? 1 : 0;

    const { runtime, installs } = report;
    out.title('Environment');
    out.line(`  ${out.muted('os')}        ${runtime.platform} ${runtime.arch}`);
    out.line(`  ${out.muted('node')}      ${runtime.node}${runtime.nodeSatisfies ? '' : out.bad(` (needs v${runtime.requiredNodeMajor}+)`)}`);
    out.line(`  ${out.muted('npm')}       ${runtime.npm ?? out.warn('not found')}`);
    out.line(`  ${out.muted('pnpm')}      ${runtime.pnpm ?? out.warn('not found')}`);
    out.line(`  ${out.muted('git')}       ${runtime.git ?? out.warn('not found')}`);
    out.line(`  ${out.muted('gateway')}   ${gateway.reachable ? out.ok(`${gateway.version} at ${gateway.url}`) : out.warn(`not running (${gateway.url})`)}`);
    out.line();

    /**
     * The `omnihilbras` command itself: is there one, is it ours, and does its target still exist.
     *
     * A dangling link is the failure worth naming — the checkout was moved or deleted after `setup` made
     * the shortcut, so the command exists and does nothing, which is the least diagnosable state of all.
     */
    const shortcut = inspectShortcut();
    const foreign = shortcut.foreign[0];
    out.line(`  ${out.muted('command')}   ${shortcut.pointsAtUs
      ? `${shortcut.commandPath} ${shortcut.onPath ? out.ok('on PATH') : out.warn('(not on PATH)')}`
      : shortcut.present
        ? out.warn(`${shortcut.commandPath} belongs to something else${shortcut.link ? ` → ${shortcut.link}` : ''}`)
        : foreign
          // Says which command would run, not just that ours is absent: on this machine an older global
          // install is what `omnihilbras` resolves to, and "not on PATH" would have been false.
          ? out.warn(`this checkout's shortcut is absent; \`omnihilbras\` resolves to ${foreign}`)
          : out.warn('omnihilbras is not on PATH')}`);
    if (shortcut.pointsAtUs && shortcut.dangling) {
      out.line(`             ${out.bad(`its target ${shortcut.link} no longer exists — re-run \`omnihilbras setup\` to point it somewhere real`)}`);
    }
    out.line();

    out.title('Missing tools');
    if (report.gaps.length === 0) out.line(out.ok('  Nothing missing.'));
    else {
      for (const gap of report.gaps) {
        const label = gap.severity === 'blocking' ? out.bad(SEVERITY_LABEL[gap.severity]) : out.warn(SEVERITY_LABEL[gap.severity]);
        out.line(`  ${label}  ${gap.title}`);
        out.line(`            ${out.muted(gap.detail)}`);
        out.line(`            ${out.muted('fix:')} ${gap.fix}`);
      }
    }
    out.line();

    /**
     * Other copies on this machine.
     *
     * Reported always, because the most confusing failure this project can have is two versions of it
     * answering on the same port — and the reason the reference implementation's launcher killed anything
     * that looked like itself. This says what is there and how to remove it; it removes nothing.
     */
    out.title('Other installations');
    if (report.otherVersionCount === 0) out.line(out.muted('  None found (npm global, PATH binaries, app directories).'));
    else {
      if (installs.globalPackages.length > 0) {
        out.line(`  ${out.muted('npm global')}`);
        for (const entry of installs.globalPackages) out.line(`    ${entry.name}@${entry.version}  ${out.muted('remove: npm rm -g ' + entry.name)}`);
      }
      if (installs.pathBinaries.length > 0) {
        out.line(`  ${out.muted('on PATH')}`);
        for (const entry of installs.pathBinaries) out.line(`    ${entry.path}${entry.target ? out.muted(` → ${entry.target}`) : ''}`);
      }
      if (installs.appPaths.length > 0) {
        out.line(`  ${out.muted('app directories')}`);
        for (const entry of installs.appPaths) out.line(`    ${entry}`);
      }
      if (installs.autostart.length > 0) {
        out.line(`  ${out.muted('autostart entries')}`);
        for (const entry of installs.autostart) out.line(`    ${entry}`);
      }
      out.line();
      out.line(out.muted('  To remove all of it: scripts/uninstall/ (see docs/INSTALL.md). Your vault is left alone unless you ask for it.'));
    }

    if (flags.installs) {
      out.line();
      out.line(out.muted(`  data directories kept on uninstall unless --purge-data: ${installs.dataPaths.join(', ') || 'none'}`));
    }

    if (blocking.length > 0) {
      out.line();
      out.line(out.bad(`${blocking.length} blocking problem${blocking.length === 1 ? '' : 's'} — the gateway will not run until ${blocking.length === 1 ? 'it is' : 'they are'} fixed.`));
      return 1;
    }
    return 0;
  },
};
