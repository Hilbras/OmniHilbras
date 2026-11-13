import { createDecipheriv, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir, platform, userInfo } from 'node:os';
import { join } from 'node:path';

/**
 * Reads the credential the ZCode desktop app already stores on this machine.
 *
 * ## Why this exists
 *
 * ZCode is not an API key. A Start Plan (or coding-plan) account is reached with the JWT the desktop
 * app keeps in `~/.zcode/v2/credentials.json`, and that value is encrypted with a key derived from
 * the machine — so the gateway can read it without the user pasting anything, exactly as the app
 * does. Asking the user to paste an "API key" was the wrong shape for this provider.
 *
 * ## The format, as the shipped app writes it
 *
 * - File: `~/.zcode/v2/credentials.json`, a flat JSON object of key → string.
 * - Value: `enc:v1:<base64url(iv)>.<base64url(tag)>.<base64url(ciphertext)>`.
 * - Cipher: AES-256-GCM, 12-byte IV, 16-byte tag, **no AAD**.
 * - Key: `SHA-256(secret)`, where `secret` is `ZCODE_CREDENTIAL_SECRET` when set, else
 *   `zcode-credential-fallback:<platform>:<homedir>:<username>`.
 *
 * Derived from `/opt/ZCode/resources/app.asar` (`out/main/chunk-B7KMLVFU.js` @32585) and confirmed
 * against a real store on this machine. Read-only: nothing here writes to the app's directory.
 */

export type ZcodeLocalCredential = {
  /** The Start Plan JWT. Never log or return this to a browser. */
  token: string;
  /** `zai` or `bigmodel`, the account family the app last used. */
  activeProvider: string;
  /** The account id from `oauth:<provider>:user_info`, when the store has one. */
  accountUuid?: string;
  /** The telemetry device id the app reports as `X-Device-Mid`. */
  deviceMid?: string;
};

const ENVELOPE = 'enc:v1:';

export function credentialSecret(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const fromEnv = env.ZCODE_CREDENTIAL_SECRET?.trim();
  if (fromEnv) return fromEnv;
  let username = 'unknown';
  try {
    username = userInfo().username || 'unknown';
  } catch {
    // `userInfo` throws when the uid has no passwd entry; the app falls back to "unknown" too.
  }
  return `zcode-credential-fallback:${platform()}:${homedir()}:${username}`;
}

export function decryptZcodeValue(value: string, secret: string): string {
  if (!value.startsWith(ENVELOPE)) return value;
  const parts = value.slice(ENVELOPE.length).split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || parts[2] === undefined) {
    throw new Error('The ZCode credential envelope is malformed (expected enc:v1:<iv>.<tag>.<ciphertext>).');
  }
  const key = createHash('sha256').update(secret).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0], 'base64url'));
  decipher.setAuthTag(Buffer.from(parts[1], 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64url')), decipher.final()]).toString('utf8');
}

function readUserId(userInfoJson: string | undefined): string | undefined {
  if (!userInfoJson) return undefined;
  try {
    const info = JSON.parse(userInfoJson) as { id?: unknown; user_id?: unknown };
    // The app's own `readTelemetryOAuthUserId` prefers `id`, then `user_id`.
    const id = typeof info.id === 'string' ? info.id : typeof info.user_id === 'string' ? info.user_id : '';
    return id.trim() || undefined;
  } catch {
    return undefined;
  }
}

export type ReadZcodeLocalOptions = {
  /** Defaults to `homedir()`. Tests pass a temp directory. */
  homeDir?: string;
  env?: Readonly<Record<string, string | undefined>>;
};

/**
 * Reads and decrypts the local ZCode credential.
 *
 * Throws a message a user can act on when the app is not signed in on this machine, rather than
 * surfacing a decryption error that looks like corruption.
 */
export async function readZcodeLocalCredential(options: ReadZcodeLocalOptions = {}): Promise<ZcodeLocalCredential> {
  const home = options.homeDir ?? homedir();
  const env = options.env ?? process.env;
  const file = join(home, '.zcode', 'v2', 'credentials.json');

  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') {
      throw new Error(`No ZCode desktop credential found at ${file}. Sign in to the ZCode app on this machine, or paste the token instead.`);
    }
    throw new Error(`Unable to read the ZCode desktop credential at ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let store: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    store = parsed as Record<string, unknown>;
  } catch {
    throw new Error(`The ZCode credential store at ${file} is not valid JSON.`);
  }

  const encrypted = store.zcodejwttoken;
  if (typeof encrypted !== 'string' || !encrypted.trim()) {
    throw new Error('The ZCode credential store has no `zcodejwttoken`. Sign in to the ZCode app again.');
  }

  const secret = credentialSecret(env);
  let token: string;
  try {
    token = decryptZcodeValue(encrypted, secret).trim();
  } catch {
    throw new Error('The ZCode token could not be decrypted on this machine. Set ZCODE_CREDENTIAL_SECRET to the secret the app used, or paste the token instead.');
  }
  if (!/^[\x21-\x7e]+$/.test(token)) throw new Error('The ZCode token decrypted to an unexpected value.');

  let activeProvider = 'zai';
  try {
    const decrypted = store['oauth:active_provider'];
    const value = typeof decrypted === 'string' ? decryptZcodeValue(decrypted, secret).trim() : '';
    if (value === 'zai' || value === 'bigmodel') activeProvider = value;
  } catch {
    // Keep the default: an unreadable active-provider hint must not block the token.
  }

  let accountUuid: string | undefined;
  try {
    const info = store[`oauth:${activeProvider}:user_info`];
    accountUuid = readUserId(typeof info === 'string' ? decryptZcodeValue(info, secret) : undefined);
  } catch {
    // Optional: only used for request attribution, never for authentication.
  }

  let deviceMid: string | undefined;
  try {
    const telemetry = JSON.parse(await readFile(join(home, '.zcode', 'v2', 'telemetry-state.json'), 'utf8')) as { deviceMid?: unknown };
    if (typeof telemetry.deviceMid === 'string' && telemetry.deviceMid.trim()) deviceMid = telemetry.deviceMid.trim();
  } catch {
    // Optional: the app generates one on first run; a missing file is not an error.
  }

  return {
    token,
    activeProvider,
    ...(accountUuid ? { accountUuid } : {}),
    ...(deviceMid ? { deviceMid } : {}),
  };
}