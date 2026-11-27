import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultStateDirectory } from './secure-store.js';

/**
 * The operator's settings file, read once at gateway start.
 *
 * ## Why a file and not only environment variables
 *
 * A gateway started by a desktop icon, a service manager or a bundled launcher inherits whatever
 * environment that process happened to have. The knobs that matter for a long agent conversation —
 * history trimming in particular — are exactly the ones an operator needs to keep across restarts, and
 * `OMNIHILBRAS_HISTORY_TRIM_TOKENS=… omnihilbras` is a setting that lives until the next terminal is
 * opened. This file is the persistent half.
 *
 * ## Precedence, stated
 *
 * **An explicitly set environment variable wins over the file.** That is what makes a one-off
 * `OMNIHILBRAS_HISTORY_TRIM_TOKENS=50000 omnihilbras` a real override rather than a value the file
 * silently replaces. The file is read by `main.ts` before `loadGatewayConfig`, which keeps
 * `loadGatewayConfig` itself deterministic for embedders and tests that pass their own environment.
 *
 * ## Only settings that can be validated here
 *
 * The file may grow, but a key is only translated when this module knows its bounds; an unknown key is
 * ignored rather than forwarded as an environment variable. Forwarding arbitrary keys would turn the
 * file into a second environment, which is a larger and less reviewable surface than the one setting
 * it exists for.
 *
 * A malformed file never prevents the gateway from starting: it is reported on stderr and ignored, the
 * same way a broken saved setting should not take the service down.
 */

export type GatewaySettings = {
  /**
   * Trim a conversation before it reaches the provider.
   *
   * `maxInputTokens` is the estimated-token threshold; `keepRecent` is how many trailing messages stay
   * verbatim. The trimmer itself keeps system prompts, the first ask, error-bearing tool results and
   * the recent window; older messages become retrieval markers.
   */
  historyTrim?: { maxInputTokens: number; keepRecent?: number };
};

export type GatewaySettingsLoad = {
  /** Absolute path this process looked at, whether or not it exists. */
  path: string;
  /** Environment variables the file contributes, already filtered against explicit environment values. */
  env: Record<string, string>;
  /** Human-readable problems; the entry point prints these and continues. */
  warnings: string[];
};

const MIN_TRIM_TOKENS = 1_000;
const MAX_TRIM_TOKENS = 10_000_000;
const MAX_KEEP_RECENT = 200;

export function gatewaySettingsPath(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return join(defaultStateDirectory(env), 'settings.json');
}

/**
 * Reads the file and turns its recognized settings into environment variables.
 *
 * This is pure apart from the read, and it is the function a test can drive with a temporary
 * `XDG_CONFIG_HOME`; `main.ts` only spreads the result and prints the warnings.
 */
export function gatewayEnvFromSettings(env: Readonly<Record<string, string | undefined>> = process.env): GatewaySettingsLoad {
  const path = gatewaySettingsPath(env);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { path, env: {}, warnings: [] };
    return { path, env: {}, warnings: [`${path} could not be read (${error instanceof Error ? error.message : 'unknown error'}); using environment values only.`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { path, env: {}, warnings: [`${path} is not valid JSON; ignored.`] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { path, env: {}, warnings: [`${path} must contain a JSON object; ignored.`] };
  }

  const warnings: string[] = [];
  const out: Record<string, string> = {};
  const settings = parsed as Record<string, unknown>;
  if (settings.historyTrim !== undefined) {
    const trim = settings.historyTrim;
    if (typeof trim !== 'object' || trim === null || Array.isArray(trim)) {
      warnings.push(`${path}: historyTrim must be an object with maxInputTokens and optionally keepRecent; ignored.`);
    } else {
      const record = trim as Record<string, unknown>;
      const max = record.maxInputTokens;
      const keep = record.keepRecent;
      let maxValid = false;
      if (max === undefined) {
        warnings.push(`${path}: historyTrim.maxInputTokens is required; historyTrim ignored.`);
      } else if (!Number.isSafeInteger(max) || (max as number) < MIN_TRIM_TOKENS || (max as number) > MAX_TRIM_TOKENS) {
        warnings.push(`${path}: historyTrim.maxInputTokens must be an integer from ${MIN_TRIM_TOKENS} to ${MAX_TRIM_TOKENS}; historyTrim ignored.`);
      } else {
        maxValid = true;
      }
      let keepValid = true;
      if (keep !== undefined && (!Number.isSafeInteger(keep) || (keep as number) < 0 || (keep as number) > MAX_KEEP_RECENT)) {
        warnings.push(`${path}: historyTrim.keepRecent must be an integer from 0 to ${MAX_KEEP_RECENT}; using the gateway default.`);
        keepValid = false;
      }
      if (maxValid) {
        out.OMNIHILBRAS_HISTORY_TRIM_TOKENS = String(max);
        if (keepValid && keep !== undefined) out.OMNIHILBRAS_HISTORY_TRIM_KEEP_RECENT = String(keep);
      }
    }
  }

  // An explicitly set environment variable wins. The check is per key, so a shell that sets only the
  // threshold still gets the file's keepRecent.
  for (const key of Object.keys(out)) {
    const explicit = env[key]?.trim();
    if (explicit) delete out[key];
  }
  return { path, env: out, warnings };
}
