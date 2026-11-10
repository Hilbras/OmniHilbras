import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * The encrypted backup envelope.
 *
 * The payload holds provider credentials, so it is never written or returned in clear. AES-256-GCM
 * gives confidentiality and tamper detection; scrypt makes a human passphrase expensive to guess. The
 * KDF parameters travel with the envelope so an old backup stays readable if the defaults change.
 */

export const BACKUP_FORMAT = 'omnihilbras-backup';
export const BACKUP_VERSION = 1;
const MIN_PASSPHRASE = 8;
const MAX_ENVELOPE_CHARS = 20 * 1024 * 1024;
const KDF = { N: 16_384, r: 8, p: 1 };

export type BackupEnvelope = {
  format: typeof BACKUP_FORMAT;
  version: number;
  createdAt: string;
  cipher: 'aes-256-gcm';
  kdf: { name: 'scrypt'; salt: string; N: number; r: number; p: number };
  iv: string;
  tag: string;
  data: string;
};

export function assertPassphrase(passphrase: unknown): string {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) {
    throw new Error(`The backup passphrase must be at least ${MIN_PASSPHRASE} characters.`);
  }
  return passphrase;
}

export function encryptBackup(payload: unknown, passphrase: string): BackupEnvelope {
  const secret = assertPassphrase(passphrase);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(secret, salt, 32, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 64 * 1024 * 1024 });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    cipher: 'aes-256-gcm',
    kdf: { name: 'scrypt', salt: salt.toString('base64'), ...KDF },
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

export function decryptBackup(envelope: unknown, passphrase: string): unknown {
  const secret = assertPassphrase(passphrase);
  if (!envelope || typeof envelope !== 'object') throw new Error('The backup file is not an envelope.');
  const value = envelope as Partial<BackupEnvelope>;
  if (value.format !== BACKUP_FORMAT || value.version !== BACKUP_VERSION) throw new Error('The file is not an OmniHilbras backup.');
  if (value.cipher !== 'aes-256-gcm' || value.kdf?.name !== 'scrypt') throw new Error('The backup uses an unsupported cipher.');
  if (typeof value.data !== 'string' || value.data.length > MAX_ENVELOPE_CHARS) throw new Error('The backup payload is too large.');
  if (typeof value.iv !== 'string' || typeof value.tag !== 'string' || typeof value.kdf.salt !== 'string') throw new Error('The backup is missing its encryption parameters.');
  const key = scryptSync(secret, Buffer.from(value.kdf.salt, 'base64'), 32, {
    N: value.kdf.N ?? KDF.N,
    r: value.kdf.r ?? KDF.r,
    p: value.kdf.p ?? KDF.p,
    maxmem: 64 * 1024 * 1024,
  });
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8')) as unknown;
  } catch {
    throw new Error('The backup could not be decrypted. Check the passphrase and the file.');
  }
}
