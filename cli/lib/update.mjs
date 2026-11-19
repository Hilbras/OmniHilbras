/**
 * Update awareness — fail-open, and never silent about what it will do.
 *
 * 9router checks the registry on every start and offers an in-menu upgrade that it then runs and relaunches.
 * We take the awareness but not the automation: the launcher *notices* a newer release and says how to get
 * it, and `omnihilbras update` is the explicit, opt-in act that installs it. Nothing upgrades the person's
 * global package without them asking, and a registry that is slow or unreachable never blocks or fails a
 * start — the check fails open.
 *
 * `fetchImpl` is injectable so the decision is testable without the network.
 */

export const PACKAGE_NAME = '@hilbras/omnihilbras';

/** Numeric dot comparison: -1 when a < b, 0 when equal, 1 when a > b. Non-numeric segments read as 0. */
export function compareVersions(a, b) {
  const left = String(a).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const right = String(b).split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

/** The latest published version, or undefined when it could not be read. Never throws. */
export async function fetchLatestVersion({ packageName = PACKAGE_NAME, registry = 'https://registry.npmjs.org', timeoutMs = 2500, fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(`${registry}/${packageName}/latest`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return undefined;
    const body = await response.json();
    return typeof body?.version === 'string' ? body.version : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a newer release exists. `updateAvailable` is false when the registry could not be read. */
export async function checkForUpdate(currentVersion, options = {}) {
  const latest = await fetchLatestVersion(options);
  if (!latest) return { current: currentVersion, latest: undefined, updateAvailable: false };
  return { current: currentVersion, latest, updateAvailable: compareVersions(currentVersion, latest) < 0 };
}

/** The command a person runs to upgrade — shown, never run on their behalf without `omnihilbras update`. */
export function updateCommand(packageName = PACKAGE_NAME) {
  return `npm i -g ${packageName}@latest`;
}
