import { createHash, publicEncrypt, randomUUID, createCipheriv, constants as cryptoConstants } from 'node:crypto';
import { QoderRequestSigner } from '@omnihilbras/sdk-qoder';
import { QODER_IDE_VERSION, QODER_CLIENT_TYPE, QODER_DATA_POLICY, QODER_LOGIN_VERSION, QODER_MACHINE_OS, QODER_MACHINE_TYPE, QODER_RSA_PUBLIC_KEY } from '@omnihilbras/sdk-qoder';

/**
 * Qoder's COSY request signer.
 *
 * Lives in the gateway, not the SDK, because it needs AES-128-CBC, RSA PKCS#1 v1.5 encryption, and MD5 —
 * none of which the Web Crypto API provides, and all of which need `node:crypto`. The SDK barrel is
 * imported by the dashboard, so a `node:crypto` import reachable from it renders a blank page; the adapter
 * takes this function as an injected `signRequest` instead.
 *
 * ## What a COSY-signed request needs
 *
 * 1. The request body is encoded (see the SDK's `qoderEncodeBody`) — the signer receives its bytes.
 * 2. The user's credentials are serialised and AES-128-CBC encrypted under a per-request random key.
 * 3. That AES key is RSA-encrypted under Qoder's public key.
 * 4. A payload `{version, requestId, info, cosyVersion, ideVersion}` is base64-encoded.
 * 5. The signature is MD5 of five newline-joined lines: payload, key, timestamp, body (latin1), sig-path.
 * 6. The result is `Authorization: Bearer COSY.<payload>.<sig>` plus seventeen `Cosy-*` headers.
 */

function generateAesKey(): string {
  return randomUUID().slice(0, 16);
}

function pkcs7Pad(data: Buffer, blockSize: number): Buffer {
  const padLen = blockSize - (data.length % blockSize);
  return Buffer.concat([data, Buffer.alloc(padLen, padLen)]);
}

function aesEncryptCbcBase64(plaintext: string, keyStr: string): string {
  const key = Buffer.from(keyStr, 'utf8');
  const iv = key.subarray(0, 16);
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(false);
  const padded = pkcs7Pad(Buffer.from(plaintext, 'utf8'), 16);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
}

function rsaEncryptBase64(data: string): string {
  return publicEncrypt({ key: QODER_RSA_PUBLIC_KEY, padding: cryptoConstants.RSA_PKCS1_PADDING }, Buffer.from(data, 'utf8')).toString('base64');
}

function md5Hex(input: Buffer | string): string {
  return createHash('md5').update(input).digest('hex');
}

function computeSigPath(requestUrl: string): string {
  try {
    return new URL(requestUrl).pathname.replace(/^\/algo/, '');
  } catch {
    return '';
  }
}

/** The COSY signer, injected into the SDK's Qoder adapter. */
export const qoderSignRequest: QoderRequestSigner = ({ bodyBytes, requestUrl, creds }) => {
  if (!creds.userId) throw new Error('cosy: user id is empty');
  if (!creds.authToken) throw new Error('cosy: auth token is empty');

  const bodyBuf = Buffer.from(bodyBytes);

  const aesKey = generateAesKey();
  const info = aesEncryptCbcBase64(
    JSON.stringify({ uid: creds.userId, security_oauth_token: creds.authToken, name: creds.name ?? '', aid: '', email: creds.email ?? '' }),
    aesKey,
  );
  const cosyKey = rsaEncryptBase64(aesKey);

  const timestamp = String(Math.floor(Date.now() / 1000));
  const payloadB64 = Buffer.from(
    JSON.stringify({ version: 'v1', requestId: randomUUID(), info, cosyVersion: QODER_IDE_VERSION, ideVersion: '' }),
    'utf8',
  ).toString('base64');

  const sigPath = computeSigPath(requestUrl);
  const sigInput = `${payloadB64}\n${cosyKey}\n${timestamp}\n${bodyBuf.toString('latin1')}\n${sigPath}`;
  const sig = md5Hex(Buffer.from(sigInput, 'latin1'));

  const machineId = creds.machineId || randomUUID();
  const bodyHash = md5Hex(bodyBuf);

  return {
    Authorization: `Bearer COSY.${payloadB64}.${sig}`,
    'Cosy-Key': cosyKey,
    'Cosy-User': creds.userId,
    'Cosy-Date': timestamp,
    'Cosy-Version': QODER_IDE_VERSION,
    'Cosy-Machineid': machineId,
    'Cosy-Machinetoken': machineId,
    'Cosy-Machinetype': QODER_MACHINE_TYPE,
    'Cosy-Machineos': QODER_MACHINE_OS,
    'Cosy-Clienttype': QODER_CLIENT_TYPE,
    'Cosy-Clientip': '127.0.0.1',
    'Cosy-Bodyhash': bodyHash,
    'Cosy-Bodylength': String(bodyBuf.length),
    'Cosy-Sigpath': sigPath,
    'Cosy-Data-Policy': QODER_DATA_POLICY,
    'Cosy-Organization-Id': '',
    'Cosy-Organization-Tags': '',
    'Login-Version': QODER_LOGIN_VERSION,
    'X-Request-Id': randomUUID(),
  };
};

export { QODER_RSA_PUBLIC_KEY };
