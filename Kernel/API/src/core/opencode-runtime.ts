import { createHash } from 'node:crypto';
import { access, chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { discoverOpencodeService, type OpencodeServiceEndpoint } from './opencode-service.js';
import { defaultLocalDataDir } from './runtime.js';

/**
 * The OpenCode server: where it is, how it gets here, and starting it.
 *
 * ## Why this file exists
 *
 * `opencode-console`'s free models are served **only** through the OpenCode client's own local service.
 * Measured, on this machine, in the same minute: the service answered a fresh free-model turn while the
 * same request — the account's own OAuth token, org header, endpoint, `x-opencode-*` client headers,
 * `ses_`-shaped session, tool-carrying body, even through the machine's own system proxy — came back
 * `429 FreeUsageLimitError` from Node, from Bun, and from curl. Whatever grants the free tier is inside
 * the client, so a device with no OpenCode cannot use those models at all.
 *
 * Two ways out were considered. Replicating the request was attempted and did not work with anything
 * that can be observed from outside the client. Shipping the client's **server** — the piece the app
 * itself spawns — does work, and that is what this file implements: find the binary, install it if it
 * is missing, start it, and hand the endpoint to the bridge.
 *
 * ## Boundaries
 *
 * - **Nothing is killed here.** A service this process started is left running: the desktop app starts
 *   the same one, and a gateway that stops it would break the app it borrowed it from.
 * - **No checksum is verified against upstream, because upstream publishes none.** The official
 *   installer checks only that the release asset exists. This module records the artifact's SHA-256
 *   beside it, and verifies the installed binary by running `--version` and keeping what it said —
 *   which is a real check of a different kind, and is not dressed up as a signature check.
 * - Everything happens under the gateway's own data directory; `PATH` and the user's `~/.opencode` are
 *   only ever read.
 */

export type OpencodeRuntimeOptions = {
  env?: Readonly<Record<string, string | undefined>>;
  /** Where the gateway keeps its state; the runtime is installed under `<dataDir>/runtime/opencode`. */
  dataDir?: string;
  /** Overridable so a test can name a platform it is not running on. */
  platform?: NodeJS.Platform;
  arch?: string;
};

export class OpencodeRuntimeError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = 'OpencodeRuntimeError';
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export function opencodeRuntimeDir(options: OpencodeRuntimeOptions = {}): string {
  return join(options.dataDir ?? defaultLocalDataDir(), 'runtime', 'opencode');
}

export function opencodeBinaryPath(options: OpencodeRuntimeOptions = {}): string {
  return join(opencodeRuntimeDir(options), 'bin', 'opencode');
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The binary this gateway will use, in order of who decided.
 *
 * An explicit `OMNIHILBRAS_OPENCODE_BINARY` first, because that is a person overriding a machine; then
 * the copy this gateway installed; then the one the official installer left in the user's home; then
 * whatever `PATH` resolves. Nothing here is spawned or written.
 */
export async function resolveOpencodeBinary(options: OpencodeRuntimeOptions = {}): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const explicit = env.OMNIHILBRAS_OPENCODE_BINARY?.trim();
  if (explicit && (await isExecutableFile(explicit))) return explicit;

  const installed = opencodeBinaryPath(options);
  if (await isExecutableFile(installed)) return installed;

  const userInstalled = join(env.HOME?.trim() || homedir(), '.opencode', 'bin', 'opencode');
  if (await isExecutableFile(userInstalled)) return userInstalled;

  const path = env.PATH ?? '';
  for (const entry of path.split(delimiter)) {
    if (!entry) continue;
    const candidate = join(entry, options.platform === 'win32' ? 'opencode.exe' : 'opencode');
    if (await isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

/** What the gateway knows about the runtime, for the dashboard and for the routes. */
export type OpencodeRuntimeStatus = {
  installed: boolean;
  path?: string;
  /** `service.json` says a service is registered; it does not prove the process answers. */
  serviceRunning: boolean;
  serviceUrl?: string;
  version?: string;
  /** Where a binary would be installed, so the dashboard can name the path before it exists. */
  installPath: string;
};

export async function opencodeRuntimeStatus(options: OpencodeRuntimeOptions = {}): Promise<OpencodeRuntimeStatus> {
  const binary = await resolveOpencodeBinary(options);
  const endpoint = await discoverOpencodeService(options.env ? { env: options.env } : {});
  return {
    installed: Boolean(binary),
    ...(binary ? { path: binary } : {}),
    serviceRunning: Boolean(endpoint),
    ...(endpoint ? { serviceUrl: endpoint.url } : {}),
    ...(endpoint?.version ? { version: endpoint.version } : {}),
    installPath: opencodeBinaryPath(options),
  };
}

export type EnsureServiceOptions = OpencodeRuntimeOptions & {
  /** Starts the service. Injected so a test can watch the command without starting anything. */
  start?: (binary: string) => void | Promise<void>;
  /** Waits for the service to register itself. Injected for the same reason. */
  waitForService?: (options: OpencodeRuntimeOptions) => Promise<OpencodeServiceEndpoint | undefined>;
  /** Downloads the runtime when there is none. Injected so a test never reaches the network. */
  install?: (options: OpencodeRuntimeOptions) => Promise<unknown>;
  timeoutMs?: number;
};

/**
 * The service endpoint, starting the client's server if this machine has the binary but no service.
 *
 * Returns `undefined` rather than throwing when there is nothing to start: "this device has no
 * OpenCode" is a state the caller reports, not an error it crashes on.
 */
export async function ensureOpencodeService(options: EnsureServiceOptions = {}): Promise<OpencodeServiceEndpoint | undefined> {
  const env = options.env ?? process.env;
  const discovered = await discoverOpencodeService(env === process.env ? {} : { env });
  if (discovered) return discovered;

  /**
   * `off` — never start anything. `auto` (the default) — start a binary that is already here.
   * `install` — download the runtime first when this machine has none, so a device that has never
   * seen OpenCode needs no manual step at all. `install` is opt-in because it is a ~200 MB download
   * triggered by a model request, which is not a decision to take on someone's behalf.
   */
  const mode = (env.OMNIHILBRAS_OPENCODE_SERVICE ?? 'auto').trim().toLowerCase();
  if (mode === 'off') return undefined;

  let binary = await resolveOpencodeBinary(options);
  if (!binary && mode === 'install') {
    const install = options.install ?? ((o: OpencodeRuntimeOptions) => installOpencodeRuntime(o));
    // A failed download is "there is no runtime here", not a broken turn: the caller reports the
    // Console's own refusal, which is the message a person can act on.
    await install(options).catch(() => undefined);
    binary = await resolveOpencodeBinary(options);
  }
  if (!binary) return undefined;

  const start = options.start ?? startOpencodeService;
  await start(binary);
  const wait = options.waitForService ?? waitForOpencodeService;
  return wait({ ...options, timeoutMs: options.timeoutMs });
}

/**
 * Starts `opencode serve --service`, detached.
 *
 * Detached and unreferenced on purpose: the desktop app talks to the same service, so it must outlive
 * the request that needed it. The gateway never kills it — see the boundary note at the top.
 */
export function startOpencodeService(binary: string): void {
  const logfile = join(tmpdir(), 'omnihilbras-opencode-service.log');
  const child = nodeSpawn(binary, ['serve', '--service'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, OMNIHILBRAS_OPENCODE_SERVICE_SPAWNED: '1' },
  });
  child.on('error', () => undefined);
  child.unref();
  void logfile;
}

async function waitForOpencodeService(options: OpencodeRuntimeOptions & { timeoutMs?: number } = {}): Promise<OpencodeServiceEndpoint | undefined> {
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    const endpoint = await discoverOpencodeService(options.env ? { env: options.env } : {});
    if (endpoint) return endpoint;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

/** The release the installer downloads from, and the two places a version can come from. */
const RELEASE_REPO = 'https://github.com/anomalyco/opencode/releases/download';
const VERSION_FEEDS = ['https://registry.npmjs.org/@opencode/cli/latest', 'https://registry.npmjs.org/opencode-ai/latest'];

export type OpencodeInstallOptions = OpencodeRuntimeOptions & {
  fetch?: typeof fetch;
  version?: string;
  /** Runs the installed binary to prove it starts. Injected so a test need not have a real one. */
  probe?: (binary: string) => Promise<string | undefined>;
};

/**
 * Installs the OpenCode server from the official release into the gateway's own runtime directory.
 *
 * The asset name is the one the official installer builds (`opencode-<os>-<arch>[-baseline][-musl]`),
 * so a device that has never seen OpenCode gets the same artifact the documented install gets. The
 * baseline and musl variants are chosen by the *installing* machine's ability to run the modern build,
 * which is not something this can quietly guess: a binary that fails to start is reported, not
 * retried with a different flavour behind the operator's back.
 */
export async function installOpencodeRuntime(options: OpencodeInstallOptions = {}): Promise<{ version: string; path: string; reportedVersion?: string; sha256: string }> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;

  const version = options.version?.trim() || env.OMNIHILBRAS_OPENCODE_VERSION?.trim() || await resolveOpencodeVersion(fetchImpl);
  if (!version) throw new OpencodeRuntimeError('Could not resolve an OpenCode release version to install. Set OMNIHILBRAS_OPENCODE_VERSION to name one.');

  const filename = opencodeAssetName(platform, arch);
  const url = `${RELEASE_REPO}/v${version.replace(/^v/, '')}/${filename}`;
  const runtimeDir = opencodeRuntimeDir(options);
  const downloadDir = join(runtimeDir, 'download');
  await mkdir(downloadDir, { recursive: true, mode: 0o700 });
  const archive = join(downloadDir, filename);

  let response: Response;
  try {
    response = await fetchImpl(url, { redirect: 'follow' });
  } catch (error) {
    throw new OpencodeRuntimeError(`Could not reach ${url}.`, { cause: error });
  }
  if (!response.ok) {
    throw new OpencodeRuntimeError(`The OpenCode release has no ${filename} for v${version} (HTTP ${response.status}). The asset names change with the platform and the release; check ${RELEASE_REPO}.`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(archive, bytes, { mode: 0o600 });
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const extracted = await extractBinary(archive, filename, runtimeDir);
  const binDir = join(runtimeDir, 'bin');
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  const target = opencodeBinaryPath(options);
  await rm(target, { force: true });
  await rename(extracted, target);
  await chmod(target, 0o755);

  const probe = options.probe ?? probeBinary;
  const reportedVersion = await probe(target);
  if (!reportedVersion) {
    throw new OpencodeRuntimeError(`The OpenCode binary at ${target} was installed but did not start. It was downloaded from ${url} (sha256 ${sha256}).`);
  }

  // Recorded, not verified against upstream: the official installer publishes no checksum, and saying
  // this file was verified would be a claim nothing supports.
  await writeFile(join(runtimeDir, 'install.json'), JSON.stringify({ version, url, sha256, filename, reportedVersion, installedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  await rm(archive, { force: true });

  return { version, path: target, ...(reportedVersion ? { reportedVersion } : {}), sha256 };
}

async function resolveOpencodeVersion(fetchImpl: typeof fetch): Promise<string | undefined> {
  for (const feed of VERSION_FEEDS) {
    try {
      const response = await fetchImpl(feed, { headers: { accept: 'application/json' } });
      if (!response.ok) continue;
      const body = (await response.json()) as { version?: unknown };
      if (typeof body.version === 'string' && /^\d+\.\d+\.\d+/.test(body.version)) return body.version;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** The asset name the official installer builds for a platform. */
export function opencodeAssetName(platform: NodeJS.Platform, arch: string): string {
  const os = platform === 'win32' ? 'windows' : platform;
  const extension = platform === 'win32' ? 'zip' : 'tar.gz';
  return `opencode-${os}-${arch}.${extension}`;
}

async function extractBinary(archive: string, filename: string, runtimeDir: string): Promise<string> {
  const out = join(runtimeDir, 'extract');
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true, mode: 0o700 });
  const args = filename.endsWith('.zip') ? ['-o', archive, '-d', out] : ['-xzf', archive, '-C', out];
  const command = filename.endsWith('.zip') ? 'unzip' : 'tar';
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new OpencodeRuntimeError(`Could not unpack ${filename} with ${command}: ${(result.stderr ?? '').trim() || `exit ${result.status}`}`);
  }
  const candidate = join(out, 'opencode');
  if ((await isExecutableFile(candidate)) || (await stat(candidate).then(() => true).catch(() => false))) return candidate;
  throw new OpencodeRuntimeError(`${filename} did not contain an "opencode" binary.`);
}

async function probeBinary(binary: string): Promise<string | undefined> {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 20_000 });
  if (result.status !== 0) return undefined;
  const text = (result.stdout || result.stderr || '').trim();
  const match = /(\d+\.\d+\.\d+[\w.-]*)/.exec(text);
  return match ? match[1] : (text || undefined);
}

/** Reads the record an install left behind, if there is one. */
export async function readOpencodeInstallRecord(options: OpencodeRuntimeOptions = {}): Promise<{ version?: string; reportedVersion?: string; installedAt?: string } | undefined> {
  try {
    const raw = await readFile(join(opencodeRuntimeDir(options), 'install.json'), 'utf8');
    return JSON.parse(raw) as { version?: string; reportedVersion?: string; installedAt?: string };
  } catch {
    return undefined;
  }
}
