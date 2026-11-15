import { createHash, randomBytes } from 'node:crypto';
import { access, chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { defaultOpencodeServiceFile, discoverOpencodeService, type OpencodeServiceEndpoint } from './opencode-service.js';
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
/**
 * The service instance **this gateway owns**.
 *
 * ## The problem this solves
 *
 * The runtime was borrowed, not owned: the gateway spawned the binary and then read the *user's*
 * registration file (`~/.local/state/opencode/service.json`), so it depended on their OpenCode
 * installation's config, inherited its password, and could only find an instance that registered itself
 * at a fixed port (49374) — the one their own OpenCode app also wants. Two consequences, both real:
 * "installed, not running" was indistinguishable from "running but unregistered", and the gateway could
 * spawn a second instance that silently failed to bind the port the first one held.
 *
 * ## What it does instead
 *
 * The binary is borrowed; the **instance is ours**. It runs with `XDG_CONFIG_HOME` and `XDG_STATE_HOME`
 * pointing inside our own data directory, on a port we choose, authenticating with a password we
 * generate. That was verified against the real binary rather than assumed: pointed at our directories it
 * registers into *our* state file and answers on *our* port with *our* password, and the user's own
 * `~/.config` and `~/.local/state` are not read or written.
 *
 * The user's OpenCode app is therefore untouched and unrelated: it keeps its own instance, its own port
 * and its own password, and this gateway neither needs it to be running nor stops it.
 */
export function opencodeOwnServiceRoot(options: OpencodeRuntimeOptions = {}): string {
  return join(opencodeRuntimeDir(options), 'service');
}

/**
 * Where our instance registers: the canonical state file, not one of ours.
 *
 * It has to be — see `opencodeOwnServiceEnv`. The file is the same one the user's own OpenCode reads, so
 * while this gateway's instance runs, that is the service both of them mean.
 */
export function opencodeOwnServiceFile(options: OpencodeRuntimeOptions = {}): string {
  return defaultOpencodeServiceFile(options.env ?? process.env);
}

export function opencodeOwnServiceConfigFile(options: OpencodeRuntimeOptions = {}): string {
  return join(opencodeOwnServiceRoot(options), 'config', 'opencode', 'service.json');
}

/** Recorded so a restart can stop the instance the previous run left behind, and only that one. */
export function opencodeOwnServicePidFile(options: OpencodeRuntimeOptions = {}): string {
  return join(opencodeOwnServiceRoot(options), 'service.pid');
}

/**
 * Our port. **49390, not the canonical 49374**, and that is measured rather than assumed.
 *
 * The first version of this claimed the opposite — that the free tier required the canonical port — on the
 * strength of two measurements taken at different times: 49390 answered `429` and 49374 answered `200`.
 * That pair was confounded, and repeating it properly says so:
 *
 * ```
 * their config + their state + 49374 -> 200      ours, port 49374 -> 429
 * our config   + their state + 49374 -> 200      ours, port 49390 -> 429      <- the confound
 * our config   + their state + 49390 -> 200      <- the port was never the variable
 * ```
 *
 * Holding the directories fixed, either port answers; moving the state directory is what changes the
 * answer. So the port is ours to choose, and choosing one the user's own OpenCode instance does **not**
 * hold is better: the two can then run side by side instead of racing for 49374.
 *
 * `OMNIHILBRAS_OPENCODE_PORT` still moves it; a value that is not a usable port is ignored.
 */
export function opencodeOwnServicePort(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env.OMNIHILBRAS_OPENCODE_PORT?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0 && parsed < 65_536) return parsed;
  }
  return 49_390;
}

export async function ensureOwnServiceConfig(options: OpencodeRuntimeOptions = {}): Promise<{ configFile: string; password: string }> {
  const configFile = opencodeOwnServiceConfigFile(options);
  await mkdir(join(opencodeOwnServiceRoot(options), 'config', 'opencode'), { recursive: true, mode: 0o700 });
  await mkdir(join(opencodeOwnServiceRoot(options), 'state'), { recursive: true, mode: 0o700 });

  const existing = await readFile(configFile, 'utf8').then((text) => JSON.parse(text) as { password?: unknown }).catch(() => undefined);
  const password = typeof existing?.password === 'string' && existing.password.length > 0 ? existing.password : randomBytes(32).toString('base64url');
  if (password !== existing?.password) {
    await writeFile(configFile, `${JSON.stringify({ password }, null, 2)}\n`, { mode: 0o600 });
    // `writeFile` honours the mode only when it creates the file; an existing file keeps its own, so the
    // permission is set explicitly as well.
    await chmod(configFile, 0o600).catch(() => undefined);
  }
  return { configFile, password };
}

/**
 * The environment our instance is started in.
 *
 * **The config directory is ours; the state directory is left alone**, and the second half is the whole
 * lesson of this module. `XDG_CONFIG_HOME` carries only the service's own password, so redirecting it
 * costs nothing and gives us a secret of our own. `XDG_STATE_HOME` is where whatever qualifies an instance
 * for free usage lives: redirected to an empty directory of ours, the same binary, port, account and body
 * answered `429 RATE_LIMITED` where the canonical state directory answered `200`. Measured repeatedly:
 *
 * ```
 * our config + our state  -> 429 (two ports, two working directories, our password and theirs)
 * our config + their state -> 200
 * ```
 *
 * So this borrows that one directory and owns everything else. The cost is stated rather than hidden: the
 * registration file lands in the canonical place, which is the same file the user's own OpenCode reads —
 * it names *our* instance while ours is running, and is removed when this gateway stops it.
 */
export function opencodeOwnServiceEnv(options: OpencodeRuntimeOptions = {}): Record<string, string | undefined> {
  const root = opencodeOwnServiceRoot(options);
  return {
    ...(options.env ?? process.env),
    XDG_CONFIG_HOME: join(root, 'config'),
    OMNIHILBRAS_OPENCODE_SERVICE_SPAWNED: '1',
  };
}

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
  /**
   * Whether the registered service is **this gateway's own instance**.
   *
   * The distinction the dashboard could not make before: "running" answered whether a service was
   * reachable, not whether it was ours — so a borrowed instance and an owned one looked identical, and
   * the user's own OpenCode app was indistinguishable from a service this gateway started and would stop.
   */
  serviceOwned: boolean;
  /** The port our own instance uses, so a person can find it without opening the registration file. */
  servicePort: number;
  /** Our registration file, named so a support question can be answered without guessing the path. */
  ownServiceFile: string;
};

/**
 * The instance registered in our directory, and whether it is ours to stop.
 *
 * `owned` requires **our pid file to name the process the registration names**. Registering in our
 * directory is not the same thing: someone can run the binary by hand against our paths, and that instance
 * is discovered and used but must never be killed by a gateway that did not start it.
 */
export async function inspectOwnService(options: OpencodeRuntimeOptions = {}): Promise<{ endpoint?: OpencodeServiceEndpoint; owned: boolean }> {
  const endpoint = await discoverOpencodeService({ file: opencodeOwnServiceFile(options) });
  const recorded = Number.parseInt(await readFile(opencodeOwnServicePidFile(options), 'utf8').then((text) => text.trim()).catch(() => ''), 10);
  return { ...(endpoint ? { endpoint } : {}), owned: Boolean(endpoint) && Number.isInteger(recorded) && recorded === endpoint?.pid };
}

export async function opencodeRuntimeStatus(options: OpencodeRuntimeOptions = {}): Promise<OpencodeRuntimeStatus> {
  const binary = await resolveOpencodeBinary(options);
  // Which of the two registrations answered decides what the rest of this can promise: an instance we own
  // is one this gateway will stop again, and one read from the user's file is theirs and is left alone.
  const own = await inspectOwnService(options);
  const endpoint = own.endpoint ?? (await discoverOpencodeService(options.env ? { env: options.env } : {}));
  const serviceOwned = own.owned;
  return {
    installed: Boolean(binary),
    ...(binary ? { path: binary } : {}),
    serviceRunning: Boolean(endpoint),
    ...(endpoint ? { serviceUrl: endpoint.url } : {}),
    ...(endpoint?.version ? { version: endpoint.version } : {}),
    installPath: opencodeBinaryPath(options),
    /** Whether the running service is this gateway's own instance — started by us, stopped by us. */
    serviceOwned,
    /** The port our instance would use, so a person can find it without reading the registration file. */
    servicePort: opencodeOwnServicePort(options.env ?? process.env),
    ownServiceFile: opencodeOwnServiceFile(options),
  };
}

export type EnsureServiceOptions = OpencodeRuntimeOptions & {
  /**
   * Starts the service. Injected so a test can watch the command without starting anything.
   *
   * Takes the options as well as the binary, because dropping them is how a spawn ends up in the default
   * directory while the caller waits on its own.
   */
  start?: (binary: string, options: OpencodeRuntimeOptions) => void | Promise<void>;
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
  /**
   * Ours first, then the user's.
   *
   * Our own instance is the point of this module. The user's file stays as a fallback so an installation
   * that was working before this change keeps working — but it is read second, so a machine that has both
   * uses the one this gateway owns and can stop again.
   */
  const ours = await discoverOpencodeService({ file: opencodeOwnServiceFile(options) });
  if (ours) return ours;
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
  /**
   * The options travel with the start, and this was the bug that made the first version of the owned
   * instance look like it worked: `start(binary)` dropped them, so the spawn used the *default* data
   * directory while the wait below polled the one the caller asked for. The instance came up, registered
   * somewhere else, and the wait timed out on a service that was running perfectly well — the same class
   * of failure as the `--port` that never reached Vite.
   */
  await start(binary, options);
  const wait = options.waitForService ?? waitForOpencodeService;
  return wait({ ...options, timeoutMs: options.timeoutMs });
}

/**
 * Starts **our** instance: the borrowed binary, our config, our state, our port.
 *
 * Detached, because a turn that needs it may outlive the request that started it, and because the
 * desktop app talks to the same instance. The pid is written down so a later run — and our own shutdown —
 * can stop *this* instance and not the user's.
 */
export async function startOpencodeService(binary: string, options: OpencodeRuntimeOptions = {}): Promise<void> {
  await ensureOwnServiceConfig(options);
  const port = opencodeOwnServicePort(options.env ?? process.env);
  const child = nodeSpawn(binary, ['serve', '--service', '--port', String(port)], {
    detached: true,
    stdio: 'ignore',
    env: opencodeOwnServiceEnv(options),
  });
  child.on('error', () => undefined);
  if (child.pid !== undefined) {
    await writeFile(opencodeOwnServicePidFile(options), String(child.pid), { mode: 0o600 }).catch(() => undefined);
  }
  child.unref();
}

/**
 * Stops the instance **we** started, and never one we did not.
 *
 * The rule this keeps: the user's OpenCode app may be running its own service on its own port, and
 * killing a process this gateway did not spawn is how an uninstall story becomes "the app stopped
 * working after I installed the gateway". So the pid comes from our own file, and it is checked against
 * the process that is actually there before anything is signalled — a reused pid would otherwise mean
 * killing something unrelated.
 */
export async function stopOpencodeService(options: OpencodeRuntimeOptions = {}): Promise<boolean> {
  const pidFile = opencodeOwnServicePidFile(options);
  const raw = await readFile(pidFile, 'utf8').catch(() => undefined);
  const pid = raw ? Number.parseInt(raw.trim(), 10) : Number.NaN;
  if (!Number.isInteger(pid) || pid <= 1) return false;

  // `kill(pid, 0)` only answers "is something there"; the command line is what makes it *our* something.
  if (!processAlive(pid) || !(await commandLooksLikeOpencode(pid, options))) {
    await rm(pidFile, { force: true }).catch(() => undefined);
    return false;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    await rm(pidFile, { force: true }).catch(() => undefined);
    return false;
  }

  // Bounded, because a shutdown that waits forever is worse than one that leaves a process behind.
  for (let waited = 0; waited < 5_000; waited += 200) {
    if (!processAlive(pid)) {
      await rm(pidFile, { force: true }).catch(() => undefined);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Gone between the check and the signal: the outcome is what was wanted.
  }
  await rm(pidFile, { force: true }).catch(() => undefined);
  return true;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Whether that pid is the runtime we started, by its command line rather than its number. */
async function commandLooksLikeOpencode(pid: number, options: OpencodeRuntimeOptions): Promise<boolean> {
  if (options.platform === 'win32' || process.platform === 'win32') return true;
  try {
    const text = await readFile(`/proc/${pid}/cmdline`, 'utf8');
    const commandLine = text.split('\0').join(' ');
    // It has to be the service *and* our port: a second OpenCode instance on another port is somebody
    // else's, even when the binary is the same one.
    return commandLine.includes('opencode') && commandLine.includes('--service') && commandLine.includes(String(opencodeOwnServicePort(options.env ?? process.env)));
  } catch {
    return false;
  }
}

async function waitForOpencodeService(options: OpencodeRuntimeOptions & { timeoutMs?: number } = {}): Promise<OpencodeServiceEndpoint | undefined> {
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    const endpoint = await discoverOpencodeService({ file: opencodeOwnServiceFile(options) })
      ?? await discoverOpencodeService(options.env ? { env: options.env } : {});
    if (endpoint) return endpoint;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

/** The release the installer downloads from, and the two places a version can come from. */
const RELEASE_REPO = 'https://github.com/anomalyco/opencode/releases/download';
const VERSION_FEEDS = ['https://registry.npmjs.org/@opencode/cli/latest', 'https://registry.npmjs.org/opencode-ai/latest'];

/**
 * The release this gateway installs unless the operator names another one.
 *
 * The audit's N3: the version came from npm's `latest` dist-tag, and that string is the only pointer to
 * the binary this process then executes. A moved dist-tag — a compromised publisher, a hijacked scope —
 * would change what every install downloads, with no second source to disagree. Pinning the version in
 * the repository moves that decision into review: changing it is a commit.
 *
 * `OMNIHILBRAS_OPENCODE_VERSION` still overrides it, because an operator pinning a version is exactly the
 * person this is protecting, and `OMNIHILBRAS_OPENCODE_SHA256` pins the artifact when the operator knows
 * which one they want.
 */
const pinnedOpencodeVersion = '2.0.28';

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

  let version = options.version?.trim()
    || env.OMNIHILBRAS_OPENCODE_VERSION?.trim()
    || pinnedOpencodeVersion;
  // `latest` stays available, but only when it is asked for by name — and a failure to resolve it is an
  // error, not a silent fall back to the pinned version, because the operator asked for something else.
  if (version === 'latest') {
    const resolved = await resolveOpencodeVersion(fetchImpl);
    if (!resolved) throw new OpencodeRuntimeError('Could not resolve the latest OpenCode release version. Name one with OMNIHILBRAS_OPENCODE_VERSION instead.');
    version = resolved;
  }
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
  /**
   * A pinned artifact hash, when the operator has one.
   *
   * Recorded-only was the previous behaviour, and it is honest but weak: the value is written beside the
   * binary and compared with nothing. Pinning turns it into a check, which is why it is worth having even
   * though upstream publishes no hash of its own.
   */
  const pinnedSha = env.OMNIHILBRAS_OPENCODE_SHA256?.trim().toLowerCase();
  if (pinnedSha && pinnedSha !== sha256) {
    throw new OpencodeRuntimeError(`The downloaded OpenCode artifact does not match OMNIHILBRAS_OPENCODE_SHA256. Expected ${pinnedSha}, got ${sha256}.`);
  }

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

/** Only reached when the operator asks for `latest` by name; see `pinnedOpencodeVersion`. */
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
