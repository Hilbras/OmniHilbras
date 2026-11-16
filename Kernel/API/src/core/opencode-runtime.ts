import { createHash, randomBytes } from 'node:crypto';
import { access, chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { discoverOpencodeService, opencodeEndpointListening, type OpencodeServiceEndpoint } from './opencode-service.js';
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
 *   the same one, and a gateway that stops it would break the app it borrowed it from. Adoption follows the
 *   same rule from the other end — a process the gateway cannot identify as its own is reported as a
 *   conflict and never signalled, and one it *can* identify is recorded and used, not reaped.
 * - **No checksum is verified against upstream, because upstream publishes none.** The official
 *   installer checks only that the release asset exists. This module records the artifact's SHA-256
 *   beside it, and verifies the installed binary by running `--version` and keeping what it said —
 *   which is a real check of a different kind, and is not dressed up as a signature check.
 * - Everything happens under the gateway's own data directory; `PATH` and the user's `~/.opencode` are
 *   only ever read. `/proc` is read for one purpose — identifying a service this gateway itself started,
 *   when both of its own records are gone — and a process whose table says it is not ours is left alone.
 */

export type OpencodeRuntimeOptions = {
  env?: Readonly<Record<string, string | undefined>>;
  /** Where the gateway keeps its state; the runtime is installed under `<dataDir>/runtime/opencode`. */
  dataDir?: string;
  /** Overridable so a test can name a platform it is not running on. */
  platform?: NodeJS.Platform;
  arch?: string;
  /**
   * Where the process table is read from, default `/proc`.
   *
   * Injectable so a test can hand this a directory it built — a pid-shaped folder holding a `cmdline`
   * and an `environ` — instead of depending on which processes happen to be running on the machine the
   * suite is executed on. A root that is not there is "this platform has no process table", which is
   * the honest answer on macOS and Windows, where `/proc` does not exist.
   */
  procRoot?: string;
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
 * Where our instance registers: inside our own state directory, not the canonical file.
 *
 * This is the difference between our instance surviving and being killed. OpenCode reaps the occupant of the
 * *canonical* registration when it starts — measured: ours was dead within seconds of the app opening, with
 * the canonical file rewritten to the app's own url and pid. Registered in our own directory, no OpenCode
 * process ever learns our pid. The canonical file is still read as a *fallback* (see `ensureOpencodeService`),
 * so a gateway whose own instance is down uses the app's service rather than nothing.
 */
export function opencodeOwnServiceFile(options: OpencodeRuntimeOptions = {}): string {
  return join(opencodeOwnServiceRoot(options), 'state', 'opencode', 'service.json');
}

export function opencodeOwnServiceConfigFile(options: OpencodeRuntimeOptions = {}): string {
  return join(opencodeOwnServiceRoot(options), 'config', 'opencode', 'service.json');
}

/** Recorded so a restart can stop the instance the previous run left behind, and only that one. */
export function opencodeOwnServicePidFile(options: OpencodeRuntimeOptions = {}): string {
  return join(opencodeOwnServiceRoot(options), 'service.pid');
}

/**
 * Our port: **49390**, not the canonical 49374.
 *
 * Chosen so this instance and the user's own can run side by side instead of racing for one port. An earlier
 * version of this comment claimed the port decided the free tier, on the strength of `49390 -> 429` against
 * `49374 -> 200`; that pair was taken minutes apart against a rate-limited resource and did not survive being
 * repeated. Holding everything else still, both ports answer `200` with either state directory — the port was
 * never the variable.
 *
 * `OMNIHILBRAS_OPENCODE_PORT` moves it; a value that is not a usable port is ignored.
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
 * The environment our instance is started in: **both directories are ours**.
 *
 * ## The claim this replaces, and why it was wrong
 *
 * This once redirected only `XDG_CONFIG_HOME`, on the strength of measurements saying our own state directory
 * cost the free tier — `49390 -> 429`, `49374 -> 200`, then `our config + our state -> 429`,
 * `our config + their state -> 200`. It was pinned by a test. **Both pairs were confounded**: the free tier is
 * rate-limited, and the readings were taken minutes apart while the same account was being exercised. Holding
 * everything else still and interleaving the two in one sitting, every run answered `200`:
 *
 * ```
 * canonical state -> OK        our own state -> OK
 * canonical state -> OK        our own state -> OK
 * ```
 *
 * The binary agrees, and says so independently: the state directory holds a registration, some locks and the
 * TUI's preferences — no credential, no channel, no entitlement — and no path is ever compared against a
 * default. Static analysis of `/home/gin/.opencode/bin/opencode` 2.0.28 found the free tier decided by
 * `opencode.ai`, from credentials in the **data** directory, relayed back as a refusal sentence.
 *
 * ## What that buys
 *
 * Sharing the state directory meant sharing the registration file, and OpenCode reaps that file's occupant on
 * start: our instance died whenever the app was opened. With our own directory, no OpenCode process learns our
 * pid at all — measured: the app opening no longer touches ours.
 *
 * `XDG_DATA_HOME` is deliberately **not** redirected: the account credentials the free tier is derived from
 * live there, and a machine with no OpenCode data has no free tier. That is the one dependency that remains,
 * and it is a read.
 */
export function opencodeOwnServiceEnv(options: OpencodeRuntimeOptions = {}): Record<string, string | undefined> {
  const root = opencodeOwnServiceRoot(options);
  return {
    ...(options.env ?? process.env),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_STATE_HOME: join(root, 'state'),
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
   * Whether the running service is **this gateway's own instance**.
   *
   * The distinction the dashboard could not make before: "running" answered whether a service was
   * reachable, not whether it was ours — so a borrowed instance and an owned one looked identical, and
   * the user's own OpenCode app was indistinguishable from a service this gateway started and would stop.
   *
   * Two things make a service ours: our pid file naming the process our registration names, or an orphan
   * identified from `/proc` and adopted (both records gone, the process still ours — `inspectOwnService`).
   */
  serviceOwned: boolean;
  /** The port our own instance uses, so a person can find it without opening the registration file. */
  servicePort: number;
  /** Our registration file, named so a support question can be answered without guessing the path. */
  ownServiceFile: string;
  /**
   * Something answers on our port that this gateway **cannot identify as its own**, so starting one cannot
   * succeed. An adopted orphan never sets this: that instance is used, not reported as a conflict.
   */
  portOccupied?: boolean;
  /** Why nothing can start, when that is the case. Never a guess: read from a probe. */
  message?: string;
};

/**
 * The instance registered in our directory, and whether it is ours to stop.
 *
 * `owned` requires **our pid file to name the process the registration names**. Registering in our
 * directory is not the same thing: someone can run the binary by hand against our paths, and that instance
 * is discovered and used but must never be killed by a gateway that did not start it.
 *
 * ## The third way an instance becomes ours: an orphan we adopt
 *
 * Both of our records can be gone while the process we started is still answering — three times in one day
 * on this machine, and each time the OpenCode-backed providers stayed down until a person killed it by pid:
 *
 * ```
 * an `opencode serve --service --port 49390` process is alive,
 *   its environment carries OUR XDG_CONFIG_HOME / XDG_STATE_HOME (so we spawned it),
 *   our pid file is gone, and its registration file in our state dir is gone too
 *
 * status: running false | owned false | portOccupied true
 * ...most recent orphan: alive 42 minutes, 38 of them before the current gateway started
 * ```
 *
 * Refusing that instance was correct while it could not be identified — but it can be, from `/proc`, and
 * "nothing is registered" then means "no *record*", not "not ours". So a holder that both looks like our
 * service and carries our own state directory is adopted: the pid is written to our pid file, which is what
 * makes it stop-able, and an endpoint is built from the port and password we already have. Adoption never
 * signals anything; it is the opposite of the conflict report.
 */
export async function inspectOwnService(options: OpencodeRuntimeOptions = {}): Promise<{ endpoint?: OpencodeServiceEndpoint; owned: boolean }> {
  const endpoint = await discoverOpencodeService({ file: opencodeOwnServiceFile(options) });
  const recorded = await readOwnServicePid(options);
  if (endpoint && Number.isInteger(recorded) && recorded === endpoint.pid && endpointAlive(endpoint)) {
    return { endpoint, owned: true };
  }
  /**
   * A registration that names a live process we have no pid record for stays **not ours** — the test at
   * `ownership is claimed only when our own pid file names the registered process` pins that, and it is the
   * case a person creates by running the binary by hand against our paths. Adoption is only for the case
   * where nothing is registered at all: a record that exists and disagrees with us is not an orphan.
   */
  if (!endpoint) {
    const adopted = await adoptOrphanedOwnService(options);
    if (adopted) return { endpoint: adopted, owned: true };
  }
  return { ...(endpoint ? { endpoint } : {}), owned: false };
}

async function readOwnServicePid(options: OpencodeRuntimeOptions): Promise<number> {
  const text = await readFile(opencodeOwnServicePidFile(options), 'utf8').catch(() => '');
  return Number.parseInt(text.trim(), 10);
}

/** Writing the pid is what makes an instance stoppable later, so it is one function, used twice. */
async function recordOwnServicePid(pid: number, options: OpencodeRuntimeOptions): Promise<void> {
  await writeFile(opencodeOwnServicePidFile(options), String(pid), { mode: 0o600 }).catch(() => undefined);
}

/**
 * Adopts the process holding our port when it is identifiably ours, and never before that.
 *
 * The order matters and each step is a refusal: **something has to answer** on our port (a process that is
 * there but silent is the `502` a stale registration used to cause, and adopting it would be the same
 * mistake), and the holder has to be ours by the rule in `findOwnServiceProcess`. Nothing is killed here:
 * an instance that answers is an instance we can use, and the gateway gets it back under its own records so
 * the ordinary shutdown path can stop it later.
 *
 * `ensureOwnServiceConfig` is what supplies the password, and it is the same file our spawn wrote before
 * starting the instance — so an endpoint built here is the one this instance actually authenticates. On a
 * machine where that config file is gone too, the instance keeps the password it read at startup and this
 * returns a fresh one; that is unproven, and the honest failure is the provider's own `401`, not a silent
 * second instance fighting this one for the port.
 */
async function adoptOrphanedOwnService(options: OpencodeRuntimeOptions = {}): Promise<OpencodeServiceEndpoint | undefined> {
  const port = opencodeOwnServicePort(options.env ?? process.env);
  if (!(await opencodeEndpointListening(`http://127.0.0.1:${port}`))) return undefined;
  const pid = await findOwnServiceProcess(options);
  if (pid === undefined) return undefined;
  const config = await ensureOwnServiceConfig(options).catch(() => undefined);
  if (!config) return undefined;
  await recordOwnServicePid(pid, options);
  return { url: `http://127.0.0.1:${port}`, password: config.password, pid };
}

/**
 * The pid of a process that is **identifiably this gateway's own service**, or nothing.
 *
 * ## The rule, and why it has two halves
 *
 * A process is ours only when **both** hold:
 *
 * 1. its `/proc/<pid>/cmdline` carries the service's own markers — the binary, `serve`, `--service`, and
 *    **our** port; and
 * 2. its `/proc/<pid>/environ` carries **our** `XDG_STATE_HOME` — the state directory
 *    `opencodeOwnServiceEnv` gave the instance we spawned.
 *
 * Neither half is enough on its own, and both failure modes are the user's own OpenCode app, which runs the
 * same binary and must never be touched: it serves on the canonical 49374 rather than our 49390, so the
 * command line alone would be a way to mistake it for ours, and a machine where the ports happened to
 * coincide would still be separated by the environment. This codebase's rule — never signal a process the
 * gateway did not start — is only kept if the identification is something the process cannot share by
 * accident.
 *
 * The `OMNIHILBRAS_OPENCODE_SERVICE_SPAWNED` marker our spawn also sets is deliberately **not** required:
 * an orphan left by a gateway that predates that marker is exactly the machine this fix exists for, and the
 * two halves above are already the pair nothing else produces by chance.
 *
 * Off Linux there is no `/proc`; a process table that cannot be listed is not evidence of anything, so both
 * reach the same answer — nothing found — and the caller keeps today's conflict report rather than guessing.
 * That is also what a `procRoot` pointed at a directory that is not there reports, which is how the test for
 * it is written.
 *
 * **The command line is read first, and the environment only for a process that got that far.** This runs on
 * every supervisor tick that finds a port answering with nothing of ours on it, so the cheap filter has to
 * come before the expensive read: `environ` is a second open per process — and on a machine with an instance
 * on the port from another data directory, none of them pass the first filter at all.
 *
 * **What this does not prove, stated rather than assumed:** that the matched process is the one *holding* the
 * port. Two processes cannot both bind it, and the spawn gate in `startOpencodeService` is what keeps a loser
 * from being spawned, so a machine with two matches should not exist — but if one did, this returns the first
 * the table lists and the pid file would name a process that is not the listener. Matching a pid to a
 * listening socket would need `/proc/net/tcp` inode parsing, which is not written here because the ambiguity
 * is not reachable today; a person reading this file after seeing a stop that did not stop anything should
 * look here first.
 */
async function findOwnServiceProcess(options: OpencodeRuntimeOptions = {}): Promise<number | undefined> {
  const procRoot = options.procRoot ?? '/proc';
  const entries = await readdir(procRoot, { withFileTypes: true }).catch(() => undefined);
  if (!entries) return undefined;
  const stateHome = ownServiceStateHome(options);
  for (const entry of entries) {
    if (!/^\d+$/.test(entry.name)) continue;
    const dir = join(procRoot, entry.name);
    const cmdline = await readFile(join(dir, 'cmdline'), 'utf8').catch(() => undefined);
    if (cmdline === undefined) continue;
    if (!commandLineIsOwnService(cmdline.split('\0').join(' '), options)) continue;
    // A process whose environment is not readable to this user (another account's, or one that has exited
    // between the listing and the read) is skipped: "cannot prove it is ours" and "is not ours" have to reach
    // the same answer here, which is that nothing is adopted.
    const environ = await readFile(join(dir, 'environ'), 'utf8').catch(() => undefined);
    if (environ === undefined) continue;
    if (!environmentNamesOwnStateHome(environ, stateHome)) continue;
    return Number.parseInt(entry.name, 10);
  }
  return undefined;
}

/** The state directory our spawn hands the instance; the scan compares against exactly this. */
function ownServiceStateHome(options: OpencodeRuntimeOptions): string {
  return String(opencodeOwnServiceEnv(options).XDG_STATE_HOME ?? '');
}

/** `environ` is NUL-separated `KEY=value`, so the value is compared where the key is, not by substring. */
function environmentNamesOwnStateHome(environ: string, stateHome: string): boolean {
  const expected = stateHome.replace(/\/+$/, '');
  if (!expected) return false;
  return environ.split('\0').some((entry) => {
    if (!entry.startsWith('XDG_STATE_HOME=')) return false;
    return entry.slice('XDG_STATE_HOME='.length).trim().replace(/\/+$/, '') === expected;
  });
}

/**
 * The markers a command line has to carry, shared by the scan and by the stop path.
 *
 * One function, so the pid file and the process table cannot hold two opinions about what our service looks
 * like. The command the gateway spawns is `opencode serve --service --port <our port>`, and all four of those
 * are required: a second OpenCode instance on another port is somebody else's even when the binary is the
 * same one, and the `serve` subcommand is what this gateway starts.
 */
function commandLineIsOwnService(commandLine: string, options: OpencodeRuntimeOptions): boolean {
  return commandLine.includes('opencode')
    && commandLine.includes('serve')
    && commandLine.includes('--service')
    && commandLine.includes(String(opencodeOwnServicePort(options.env ?? process.env)));
}

/**
 * The service that is actually running, and whether it is the gateway's own.
 *
 * The two questions a registration file cannot answer on its own: is the process there, and is it ours. Ours
 * comes first, because it is the one this gateway started and will stop; a live registration filed by
 * somebody else — the user's own OpenCode app — is used and left alone.
 *
 * "Ours" includes an orphan adopted from `/proc`, so a machine whose records were lost reports a running,
 * owned service while the instance is still answering — which is the state the supervisor and the dashboard
 * both read as "nothing to do here" instead of fighting the instance for its port.
 */
export async function liveOpencodeService(options: OpencodeRuntimeOptions = {}): Promise<{ endpoint: OpencodeServiceEndpoint; owned: boolean } | undefined> {
  const own = await inspectOwnService(options);
  if (own.endpoint && own.owned) return { endpoint: own.endpoint, owned: true };
  const borrowed = await discoverOpencodeService(options.env ? { env: options.env } : {});
  if (borrowed && endpointAlive(borrowed)) return { endpoint: borrowed, owned: false };
  return undefined;
}

/**
 * Keeps an instance running without anyone having to ask.
 *
 * ## Why this exists
 *
 * Opening OpenCode **kills our instance**: its service reaps whatever the canonical registration names when it
 * starts, and registering there is not optional — the free tier keys on the canonical state directory, and an
 * instance with its own directory answers `429` even when that directory is an exact copy. Measured on this
 * machine:
 *
 * ```
 * ours running on 49390, registration names ours
 * the app starts -> registration rewritten to 49374, ours KILLED (before the app was even closed)
 * the app closes  -> registration removed, nothing listening at all
 * ```
 *
 * So the two of them cannot hold the port at once, and only one of them should try. The rule here is the
 * quiet half of that: **start ours only when nothing is running**, so the app always wins when it is open
 * (the provider then uses the app's service, which is the same service) and ours comes back when it closes.
 * The gateway never reaps the app's instance, in either direction.
 *
 * Recovery used to be a person's job: closing the app left the gateway pointing at a dead port until it was
 * restarted. This is that job, done every `intervalMs`, and it is a no-op whenever a service is live.
 *
 * "A service is live" now includes an orphan of ours, because the tick's check goes through
 * `liveOpencodeService`: a machine whose pid file and registration were both lost gets its instance adopted
 * and recorded here, and the tick then does nothing — which is the right answer, since the instance is up.
 */
export function startOpencodeSupervisor(options: OpencodeRuntimeOptions & {
  intervalMs?: number;
  ensure?: (options: OpencodeRuntimeOptions) => Promise<OpencodeServiceEndpoint | undefined>;
  log?: (message: string) => void;
} = {}): () => void {
  const env = options.env ?? process.env;
  const intervalMs = options.intervalMs ?? 10_000;
  const ensure = options.ensure ?? ((o: OpencodeRuntimeOptions) => ensureOpencodeService(o));
  const log = options.log ?? ((message: string) => console.error(message));
  let stopped = false;
  let inFlight = false;

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      if (opencodeServiceMode(env) === 'off') return;
      if (await liveOpencodeService(options)) return;
      /**
       * Asked again after the awaits above, because they are not instant and a supervisor that was stopped
       * while one was in flight must not start anything: `stop()` is what a shutdown calls, and a start that
       * lands after it outlives the gateway that owns it. Measured by the test this file already had — "the
       * supervisor starts an instance when nothing is running, and stops when told" — once the live check
       * began reading `/proc`, a tick in flight when `stop()` ran still reached `ensure`, and the count of
       * starts went up after the stop.
       */
      if (stopped) return;
      if (!(await resolveOpencodeBinary(options))) return;
      /**
       * And asked a third time, **immediately before the one side effect this function has**.
       *
       * The check above is separated from `ensure` by another await, and a `stop()` landing in that gap still
       * started an instance: a tick that had passed the previous guard, awaited the binary lookup, and then
       * found itself stopped, started the gateway's service anyway — outliving the gateway that owned it.
       * The supervisor test caught it as `6 !== 5` (one more start than the snapshot taken at `stop()`),
       * which is why the guard moved here rather than staying two awaits earlier.
       *
       * Nothing may sit between this check and the call: no `await`, no callback, nothing that yields.
       */
      if (stopped) return;
      log("OmniHilbras gateway: no OpenCode service is running; starting the gateway's own instance.");
      await ensure(options);
    } catch (error) {
      // A runtime that will not start is the provider's problem, reported when it is used: the gateway must
      // not die, or spam, because a service refused to come up.
      log(`OmniHilbras gateway: the OpenCode runtime did not start. ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export async function opencodeRuntimeStatus(options: OpencodeRuntimeOptions = {}): Promise<OpencodeRuntimeStatus> {
  const binary = await resolveOpencodeBinary(options);
  // Which of the two registrations answered decides what the rest of this can promise: an instance we own
  // is one this gateway will stop again, and one read from the user's file is theirs and is left alone.
  // `serviceRunning` answers whether a service is there, not whether a file says so: a stale registration
  // used to read as running while the port was empty, which is the state a person then had no way to see.
  // Which of the two it is decides what the rest of this can promise: ours is stopped again by this gateway,
  // one read from the user's file is theirs and is left alone.
  const live = await liveOpencodeService(options);
  const endpoint = live?.endpoint;
  const serviceOwned = live?.owned ?? false;
  const port = opencodeOwnServicePort(options.env ?? process.env);
  /**
   * Nothing is registered **and nothing about it is ours**, but something answers where our instance would be.
   *
   * That is a fact about the machine, and without it the panel says "installed, not running" for a port that is
   * busy — which reads as a button that does nothing when it is clicked, because starting a second instance
   * there cannot succeed. It is reached only when the holder is not ours: an orphan this gateway can identify
   * arrives here as `endpoint` and `serviceOwned: true` instead, which is the whole point of the adoption in
   * `inspectOwnService`.
   */
  const portOccupied = endpoint === undefined && await opencodeEndpointListening(`http://127.0.0.1:${port}`);
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
    servicePort: port,
    ...(portOccupied
      ? {
          portOccupied: true,
          message: `127.0.0.1:${port} is already answering and its pid is not recorded as this gateway's, so no second instance can start there. Stop whatever holds that port, or set OMNIHILBRAS_OPENCODE_PORT to a free one.`,
        }
      : {}),
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
  // A registration whose process is gone is not an answer: it is the file a service left behind, and
  // adopting it is how a working machine ends up answering `502` with nothing listening on the port.
  const ours = await discoverOpencodeService({ file: opencodeOwnServiceFile(options) });
  if (ours && endpointAlive(ours)) return ours;
  /**
   * Then the instance we started whose records are both gone but which is still answering our port.
   *
   * The port guard below used to be the whole answer here — a conflict report and no service — which left the
   * OpenCode-backed providers down until a person found the pid by hand. An instance that answers is an
   * instance we can use, and `/proc` is what turns "not recorded" into "identifiably ours"; see
   * `adoptOrphanedOwnService`. It is tried before the user's registration for the same reason our own
   * registration is: a machine that has both must use the one this gateway will stop again.
   */
  const adopted = await adoptOrphanedOwnService(options);
  if (adopted) return adopted;
  const discovered = await discoverOpencodeService(env === process.env ? {} : { env });
  if (discovered && endpointAlive(discovered)) return discovered;

  const mode = opencodeServiceMode(env);
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

  /**
   * A port that already answers ends this here, rather than in a twenty-second wait for a registration that
   * cannot happen.
   *
   * This is what "Start service does nothing" was: the route spawned a second instance into an occupied port,
   * the child died, the wait polled for twenty seconds, and the answer was the same status the badge was
   * already showing.
   *
   * An orphan of ours no longer reaches this line — `adoptOrphanedOwnService` above has already taken it, so
   * whatever holds the port here is something the gateway cannot identify and must not start a second
   * instance against.
   */
  if (await opencodeEndpointListening(`http://127.0.0.1:${opencodeOwnServicePort(env)}`)) return undefined;

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
/**
 * The start in flight, if any.
 *
 * The route (`POST /v1/runtime/opencode/start`) and the supervisor both call `ensureOpencodeService` when
 * nothing is live, so two spawns could race for one port. The loser cannot bind and exits — and **its pid is
 * what ends up in the pid file, because it wrote last**. Measured after clicking Start service on a machine
 * whose port was already held:
 *
 * ```
 * our pid file -> 2188042      the process actually listening -> 2188013
 * ```
 *
 * An instance nobody recorded is worse than no instance: `serviceOwned` is false, so the gateway will not stop
 * it, the status says "not running", and the next Start races again. Concurrent callers share one attempt.
 */
let startingOwnService: Promise<void> | undefined;

export async function startOpencodeService(binary: string, options: OpencodeRuntimeOptions = {}): Promise<void> {
  if (startingOwnService) return startingOwnService;
  startingOwnService = (async () => {
    await ensureOwnServiceConfig(options);
    const port = opencodeOwnServicePort(options.env ?? process.env);
    /**
     * Nothing is spawned into a port that already answers.
     *
     * Whatever is there is not ours to duplicate: a second bind fails, and the only evidence is a pid file
     * naming a process that no longer exists. The status reports the conflict instead (see
     * `opencodeRuntimeStatus`), which is the difference between "not running" and "cannot start". An orphan
     * of ours is adopted rather than duplicated — `ensureOpencodeService` does that before it ever gets here,
     * and `adoptOrphanedOwnService` is what this repeats for a caller that starts a service directly.
     */
    if (await opencodeEndpointListening(`http://127.0.0.1:${port}`)) {
      await adoptOrphanedOwnService(options);
      return;
    }
    const child = nodeSpawn(binary, ['serve', '--service', '--port', String(port)], {
      detached: true,
      stdio: 'ignore',
      env: opencodeOwnServiceEnv(options),
    });
    child.on('error', () => undefined);
    if (child.pid !== undefined) await recordOwnServicePid(child.pid, options);
    child.unref();
  })().finally(() => { startingOwnService = undefined; });
  return startingOwnService;
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

/**
 * Whether a registration names a process that is actually there.
 *
 * A registration file outlives the process that wrote it — the gateway is killed with SIGKILL, the machine
 * loses power, a container is replaced — and the file then describes a service nobody is serving. Reading it
 * as "running" is what made the first boot after this feature shipped report `serviceRunning: true` for an
 * empty port and answer the first turn with `502`: the stale registration was adopted, so the gateway never
 * started its own instance.
 *
 * A registration with no pid is treated as live, because nothing better is known about it, and the request
 * that follows is the honest test.
 */
/**
 * How far the gateway may go to have a service: `off` never starts one, `auto` (the default) starts a binary
 * that is already here, `install` downloads the runtime first on a machine that has none. `install` is opt-in
 * because it is a ~200 MB download triggered by a model request.
 */
export function opencodeServiceMode(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return (env.OMNIHILBRAS_OPENCODE_SERVICE ?? 'auto').trim().toLowerCase();
}

function endpointAlive(endpoint: OpencodeServiceEndpoint): boolean {
  if (endpoint.pid === undefined) return true;
  return processAlive(endpoint.pid);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether that pid is the runtime we started, by its command line rather than its number.
 *
 * The same markers the adoption scan uses, from the same function: a pid file and a process table have to
 * agree about what our service looks like, or one of them is a promise the other does not keep.
 */
async function commandLooksLikeOpencode(pid: number, options: OpencodeRuntimeOptions): Promise<boolean> {
  if (options.platform === 'win32' || process.platform === 'win32') return true;
  try {
    const text = await readFile(`${options.procRoot ?? '/proc'}/${pid}/cmdline`, 'utf8');
    return commandLineIsOwnService(text.split('\0').join(' '), options);
  } catch {
    return false;
  }
}

async function waitForOpencodeService(options: OpencodeRuntimeOptions & { timeoutMs?: number } = {}): Promise<OpencodeServiceEndpoint | undefined> {
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    const endpoint = await discoverOpencodeService({ file: opencodeOwnServiceFile(options) })
      ?? await discoverOpencodeService(options.env ? { env: options.env } : {});
    // The stale file this replaced is exactly what a *fresh* spawn has to overwrite, so waiting on a dead
    // registration would return the previous service's corpse instead of the one just started.
    if (endpoint && endpointAlive(endpoint)) return endpoint;
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
