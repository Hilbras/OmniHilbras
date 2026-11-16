import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, posix, sep } from 'node:path';
import { chatGptWebProfileDir } from '../providers/chatgptWeb.js';
import { geminiWebProfileDir } from '../providers/geminiWeb.js';

/**
 * The browser profiles a backup carries, and why it carries only part of them.
 *
 * Two providers drive a real browser — ChatGPT Web and Gemini Web — and an interactive sign-in writes the
 * session into that browser's profile on disk. Leaving the profile out means a restored installation asks
 * the user to sign in again; carrying it whole means dragging Chromium's caches into the payload, which on
 * this installation is **6.9 MB per profile against ~40 KB of session files** (measured), against a payload
 * capped at 20 MiB in `core/backup.ts`. Two or three signed-in web providers would push the export over the
 * cap and break it for exactly the people using it most, so the carried set is the four places a session
 * actually lives and nothing else.
 */
const carriedPaths = ['Default/Cookies', 'Default/Local Storage', 'Default/Session Storage', 'Default/IndexedDB'] as const;

/** A whole profile is small; a payload that claims otherwise is not one this reads. */
const maxProfileBytes = 4 * 1024 * 1024;
const maxFilesPerProfile = 2_000;

/** One connection's session files, as relative paths and base64, keyed by the provider that owns them. */
export type WebProfileSection = {
  version: 1;
  profiles: Array<{ providerId: string; connectionId: string; files: Record<string, string> }>;
};

export type WebProfilesBackupState = WebProfileSection;

/** The providers whose driver keeps a persistent profile, with the directory each one uses. */
function profileDirFor(providerId: string, connectionId: string): string | undefined {
  if (providerId === 'chatgpt-web') return chatGptWebProfileDir(connectionId);
  if (providerId === 'gemini-web') return geminiWebProfileDir(connectionId);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every carried file under one profile directory, as `<relative path>` → base64.
 *
 * Walks the allowlisted subtrees rather than naming Chromium's internal files, because their names are
 * hashed per origin and change between versions — an allowlist of exact paths would silently stop matching
 * and a backup would quietly stop carrying the session it was written to carry.
 */
async function readProfileFiles(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  let bytes = 0;
  const walk = async (relative: string) => {
    const info = await stat(join(directory, relative)).catch(() => undefined);
    if (!info) return;
    if (info.isDirectory()) {
      for (const entry of await readdir(join(directory, relative)).catch(() => [] as string[])) {
        if (Object.keys(files).length >= maxFilesPerProfile) return;
        await walk(posix.join(relative, entry));
      }
      return;
    }
    if (!info.isFile() || info.size > maxProfileBytes) return;
    bytes += info.size;
    if (bytes > maxProfileBytes) return;
    const content = await readFile(join(directory, relative)).catch(() => undefined);
    if (content) files[relative] = content.toString('base64');
  };
  for (const carried of carriedPaths) await walk(carried);
  return files;
}

/**
 * The session files of every connection whose provider drives a browser.
 *
 * A connection whose provider keeps no profile, or which never opened one, contributes nothing — and an
 * empty section is written anyway, so a reader can tell "this installation had no web sessions" from
 * "this backup predates the section".
 */
export async function exportWebProfiles(connections: readonly { id: string; providerId: string }[]): Promise<WebProfilesBackupState> {
  const profiles: WebProfileSection['profiles'] = [];
  for (const connection of connections) {
    const directory = profileDirFor(connection.providerId, connection.id);
    if (!directory) continue;
    const files = await readProfileFiles(directory);
    if (Object.keys(files).length > 0) profiles.push({ providerId: connection.providerId, connectionId: connection.id, files });
  }
  return { version: 1, profiles };
}

/**
 * Reads a backup's web-profile section strictly.
 *
 * The paths arrive from the file and are written to disk, so they are the one place a payload could name a
 * file of its choosing. Every path must sit under a carried subtree and may not climb out of it, every
 * value must decode as base64 within the byte bound, and a duplicate connection is refused rather than
 * letting the last one win — a profile that was silently overwritten is a session the user lost.
 */
export function parseWebProfilesState(value: unknown): WebProfilesBackupState {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.profiles)) {
    throw new Error('The backup\'s web-profile section is not readable.');
  }
  const profiles: WebProfileSection['profiles'] = [];
  const seen = new Set<string>();
  for (const entry of value.profiles) {
    if (!isRecord(entry) || typeof entry.providerId !== 'string' || typeof entry.connectionId !== 'string' || !isRecord(entry.files)) {
      throw new Error('The backup contains an unreadable web profile.');
    }
    if (seen.has(entry.connectionId)) throw new Error(`The backup contains two web profiles for the connection ${entry.connectionId}.`);
    seen.add(entry.connectionId);
    const files: Record<string, string> = {};
    let bytes = 0;
    const entries = Object.entries(entry.files);
    if (entries.length > maxFilesPerProfile) throw new Error('The backup\'s web profile holds too many files.');
    for (const [path, content] of entries) {
      if (typeof content !== 'string' || !allowedRelativePath(path)) {
        throw new Error('The backup\'s web profile names a file outside the profile directory.');
      }
      const size = Buffer.from(content, 'base64').length;
      bytes += size;
      if (bytes > maxProfileBytes) throw new Error('The backup\'s web profile is too large.');
      files[path] = content;
    }
    profiles.push({ providerId: entry.providerId, connectionId: entry.connectionId, files });
  }
  return { version: 1, profiles };
}

/** A path under a carried subtree, with no way to climb out of it and no absolute form. */
function allowedRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 512) return false;
  if (path.includes('..') || path.startsWith('/') || path.includes('\\')) return false;
  if (path.split(sep).length > 8) return false;
  return carriedPaths.some((carried) => path === carried || path.startsWith(`${carried}/`));
}

/**
 * Writes the section's profiles and forgets the ones the file does not carry.
 *
 * `connectionIds` is what the vault holds *after* the connections section was applied, which is why the
 * connections section is applied first: a profile for a connection that no longer exists is a signed-in
 * third-party session nobody can see, and the audit found one sitting on disk exactly that way. Replacing
 * the directory rather than merging into it is deliberate — a stale cookie left beside a restored one is a
 * session neither the user nor the gateway can name.
 */
export async function importWebProfiles(state: WebProfilesBackupState, connectionIds: readonly string[], providerOf: (connectionId: string) => string | undefined): Promise<void> {
  const parsed = parseWebProfilesState(state);
  const carried = new Set(parsed.profiles.map((profile) => profile.connectionId));
  for (const connectionId of connectionIds) {
    if (carried.has(connectionId)) continue;
    const providerId = providerOf(connectionId);
    if (!providerId) continue;
    const directory = profileDirFor(providerId, connectionId);
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
  for (const profile of parsed.profiles) {
    const providerId = providerOf(profile.connectionId);
    const directory = providerId ? profileDirFor(providerId, profile.connectionId) : undefined;
    if (!directory) continue;
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const [path, content] of Object.entries(profile.files)) {
      const target = join(directory, path);
      /* istanbul ignore next -- `parseWebProfilesState` has already refused every path outside the profile. */
      if (!target.startsWith(directory)) continue;
      await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
      await writeFile(target, Buffer.from(content, 'base64'), { mode: 0o600 });
    }
  }
}
