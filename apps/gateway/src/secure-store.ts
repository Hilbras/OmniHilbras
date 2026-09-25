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
