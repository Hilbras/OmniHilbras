import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Which build this process is.
 *
 * ## Why this exists
 *
 * Twice during the Codex work a change was described as "live" while the gateway was still serving
 * the previous build, and nothing on screen could tell the difference. `/health` reported
 * `{"service":"omnihilbras-gateway","status":…}` and not one version number, so neither the operator
 * nor the dashboard could compare the running process against the source in front of them. Both
 * discoveries cost a full diagnosis cycle, and both started from the same invisible state.
 *
 * A build identity is the smallest thing that makes that state visible. It is read **once**, at module
 * load, and never re-read: a value that changed while the process ran would be worse than none,
 * because it would describe a build that is not the one answering.
 */

export type GatewayBuild = {
  /** The version in this gateway's own `package.json`. */
  readonly version: string;
  /**
   * The commit this was built from, when the operator supplied one.
   *
   * `OMNIHILBRAS_BUILD_COMMIT` is read rather than shelling out to git: a packaged gateway may have
   * no repository beside it, and a build that cannot answer must not fail to start over it.
   */
  readonly commit?: string;
  /** When this process started — not when it was built. */
  readonly startedAt: string;
};

function readPackageVersion(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8'),
    ) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : 'unknown';
  } catch {
    // A gateway whose manifest cannot be read still has to run, and "unknown" is the honest answer.
    return 'unknown';
  }
}

let cached: GatewayBuild | undefined;

/** The running build. Computed once; every later call answers from that first result. */
export function gatewayBuild(): GatewayBuild {
  cached ??= Object.freeze({
    version: readPackageVersion(),
    ...(process.env.OMNIHILBRAS_BUILD_COMMIT?.trim() ? { commit: process.env.OMNIHILBRAS_BUILD_COMMIT.trim() } : {}),
    startedAt: new Date().toISOString(),
  });
  return cached;
}