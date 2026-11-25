import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Root directory for local gateway state, honouring XDG on Linux. */
export function defaultStateDirectory(env: Readonly<Record<string, string | undefined>> = process.env) {
  const configHome = env.XDG_CONFIG_HOME?.trim();
  return join(configHome || join(homedir(), '.config'), 'omnihilbras');
}

/** Creates the owner-only directory that holds local gateway state. */
export async function ensureSecureDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Local credential directory is not a regular directory.');
  await chmod(directory, 0o700);
}

/** Writes a file through a temporary sibling so readers never observe a partial write. */
export async function atomicWrite(filePath: string, value: string) {
  await ensureSecureDirectory(dirname(filePath));
  const existing = await lstat(filePath).catch((error: unknown) => {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing?.isSymbolicLink()) throw new Error('Refusing to write through a symbolic link.');
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(value, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export async function readOptionalFile(filePath: string, maxBytes: number) {
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('Local credential file is not a regular file.');
  if (info.size > maxBytes) throw new Error('Local credential file is too large.');
  return readFile(filePath);
}

export async function readOptionalText(filePath: string, maxBytes: number) {
  const value = await readOptionalFile(filePath, maxBytes);
  return value?.toString('utf8');
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/**
 * One writer at a time, across processes.
 *
 * The desktop app and the CLI can both have a gateway open on the same vault. Each process keeps its
 * own in-memory maps, so two saves interleaved without a lock is a lost update: the second writer
 * persists its stale copy of every *other* connection along with the one it changed. The lock is a
 * file created with `wx`, which is atomic on every platform this runs on, and it carries the holder's
 * pid and a token so a release can never unlink a successor's lock.
 *
 * Same-process callers are serialized first, by path. Without that, two stores in one process would
 * each see the other's live pid, correctly conclude the lock is not stale, and wait for each other.
 */
const localLocks = new Map<string, Promise<unknown>>();

async function withProcessLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = localLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate, () => gate);
  localLocks.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (localLocks.get(key) === tail) localLocks.delete(key);
  }
}

/** How long a lock may exist before it is treated as abandoned, regardless of its pid. */
const LOCK_STALE_MS = 120_000;
/** How long a caller waits for another process to finish a vault write. */
const LOCK_TIMEOUT_MS = 15_000;

async function lockIsStale(lockPath: string): Promise<boolean> {
  const info = await lstat(lockPath).catch((error: unknown) => {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!info) return true;
  // A pid can outlive its process and be reused, so age is the backstop: a vault write holds this for
  // milliseconds, and two minutes is already far past anything a person would wait.
  if (Date.now() - info.mtimeMs > LOCK_STALE_MS) return true;
  const text = await readFile(lockPath, 'utf8').catch(() => '');
  const pid = Number(text.trim().split(/\s+/)[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM means the process exists and belongs to someone else; it is not ours to break.
    return !(isNodeError(error) && error.code === 'EPERM');
  }
}

export async function withFileLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
  return withProcessLock(lockPath, async () => {
    await ensureSecureDirectory(dirname(lockPath));
    const token = `${process.pid} ${randomBytes(8).toString('hex')}`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      let handle;
      try {
        handle = await open(lockPath, 'wx', 0o600);
        await handle.writeFile(`${token}\n`, 'utf8');
        await handle.sync();
      } catch (error) {
        await handle?.close().catch(() => undefined);
        handle = undefined;
        if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
        if (await lockIsStale(lockPath)) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error('The local credential vault is in use by another process. Try again.');
        }
        await new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 50)));
        continue;
      }
      try {
        return await operation();
      } finally {
        await handle?.close().catch(() => undefined);
        const held = await readFile(lockPath, 'utf8').catch(() => undefined);
        if (held?.trim() === token) await unlink(lockPath).catch(() => undefined);
      }
    }
  });
}

/** The identity of a file's current bytes, for deciding whether a cached copy is stale. */
export async function fileStamp(filePath: string): Promise<string> {
  const info = await lstat(filePath).catch((error: unknown) => {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  });
  return info ? `${info.ino}:${info.size}:${info.mtimeMs}` : 'missing';
}
