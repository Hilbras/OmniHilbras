import fs from "node:fs";

/**
 * Permission helpers for the directories and files that hold secrets.
 *
 * The small secret files (`jwt-secret`, `auth/cli-secret`) were always written
 * 0600, but the big one — the SQLite database, which holds every provider
 * `apiKey`/`accessToken`/`refreshToken` in plaintext — was created with the
 * default mode, so on a shared host any local user could read every
 * configured provider account.
 *
 * Every function here is best-effort: a failure to change the mode is
 * reported once and never throws, because refusing to start over a permission
 * would be worse than the exposure it is meant to close. That matters for the
 * container case, where DATA_DIR may live on a volume this process does not
 * own.
 */

let warned = false;

function warnOnce(message) {
  if (warned) return;
  warned = true;
  console.warn(`[SecureFS] ${message}`);
}

/**
 * Create a directory (and its parents) and make it private.
 *
 * `mkdir`'s mode only applies to the directories it actually creates, so an
 * existing directory keeps its old mode — hence the explicit chmod.
 */
export function ensureSecureDir(dir, mode = 0o700) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode });
  } catch (error) {
    // A directory that cannot be created is reported, not thrown: the caller
    // (the DB driver) will fail with a clearer message when it opens the
    // database, and refusing to start here would only move the error.
    if (error?.code !== "EEXIST") {
      warnOnce(`could not create ${dir}: ${error.message}`);
      return dir;
    }
  }
  try {
    fs.chmodSync(dir, mode);
  } catch (error) {
    // Not the owner, or a filesystem without modes (some network mounts).
    warnOnce(`could not set ${mode.toString(8)} on ${dir}: ${error.message}`);
  }
  return dir;
}

/**
 * Make an existing file private. A missing file is not an error — the caller
 * usually creates it afterwards.
 */
export function ensureSecureFile(file, mode = 0o600) {
  try {
    if (!fs.existsSync(file)) return false;
    fs.chmodSync(file, mode);
    return true;
  } catch (error) {
    warnOnce(`could not set ${mode.toString(8)} on ${file}: ${error.message}`);
    return false;
  }
}
