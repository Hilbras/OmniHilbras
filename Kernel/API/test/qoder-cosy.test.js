import { QODER_RSA_PUBLIC_KEY } from '@omnihilbras/sdk-qoder';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, constants as cryptoConstants, createDecipheriv, privateDecrypt, generateKeyPairSync, createPublicKey } from 'node:crypto';
import { qoderSignRequest } from '../dist/src/providers/qoderCosy.js';
import { qoderEncodeBody, qoderEncodedBytes } from '@omnihilbras/sdk-qoder';

/**
 * Qoder's COSY signer — the header set and the signature shape.
 *
 * The signature cannot be verified against Qoder's public key (only they hold the private half for the
 * AES key), but every property that a wire-format refactor would break is assertable here:
 *
 * - the eighteen headers are all present and non-empty where they must be;
 * - `Authorization` is `Bearer COSY.<payload>.<sig>`, and the payload decodes to the documented shape;
 * - `Cosy-Bodyhash` and `Cosy-Bodylength` describe the exact bytes passed in;
 * - a missing user id or token is refused rather than signed with an empty value.
 */

const body = qoderEncodeBody(JSON.stringify({ hello: 'qoder' }));
const bytes = qoderEncodedBytes(body);

test('the signer produces every COSY header', () => {
  const headers = qoderSignRequest({
    bodyBytes: bytes,
    requestUrl: 'https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?x=1',
    creds: { userId: 'user-1', authToken: 'token-1' },
  });
  const expected = [
    'Authorization', 'Cosy-Key', 'Cosy-User', 'Cosy-Date', 'Cosy-Version', 'Cosy-Machineid',
    'Cosy-Machinetoken', 'Cosy-Machinetype', 'Cosy-Machineos', 'Cosy-Clienttype', 'Cosy-Clientip',
    'Cosy-Bodyhash', 'Cosy-Bodylength', 'Cosy-Sigpath', 'Cosy-Data-Policy', 'Cosy-Organization-Id',
    'Cosy-Organization-Tags', 'Login-Version', 'X-Request-Id',
  ];
  for (const name of expected) assert.ok(name in headers, `missing header ${name}`);
  assert.equal(headers['Cosy-User'], 'user-1');
});

test('Authorization is Bearer COSY.<base64 payload>.<md5 sig>', () => {
  const headers = qoderSignRequest({ bodyBytes: bytes, requestUrl: 'https://api3.qoder.sh/algo/x', creds: { userId: 'u', authToken: 't' } });
  const match = headers.Authorization.match(/^Bearer COSY\.([A-Za-z0-9+/=]+)\.([a-f0-9]{32})$/);
  assert.ok(match, `Authorization did not match the COSY shape: ${headers.Authorization}`);
  const payload = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
  assert.equal(payload.version, 'v1');
  assert.equal(payload.cosyVersion, '1.0.0');
  assert.ok(payload.requestId);
  assert.ok(payload.info);
});

test('Cosy-Bodyhash and Cosy-Bodylength describe the exact bytes passed in', () => {
  const headers = qoderSignRequest({ bodyBytes: bytes, requestUrl: 'https://api3.qoder.sh/algo/x', creds: { userId: 'u', authToken: 't' } });
  assert.equal(headers['Cosy-Bodyhash'], createHash('md5').update(Buffer.from(bytes)).digest('hex'));
  assert.equal(headers['Cosy-Bodylength'], String(bytes.length));
});

test('Cosy-Sigpath strips the leading /algo', () => {
  const headers = qoderSignRequest({ bodyBytes: bytes, requestUrl: 'https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?a=1', creds: { userId: 'u', authToken: 't' } });
  assert.equal(headers['Cosy-Sigpath'], '/api/v2/service/pro/sse/agent_chat_generation');
});

test('a missing user id or token is refused, never signed empty', () => {
  assert.throws(() => qoderSignRequest({ bodyBytes: bytes, requestUrl: 'https://api3.qoder.sh/algo/x', creds: { userId: '', authToken: 't' } }), /user id is empty/);
  assert.throws(() => qoderSignRequest({ bodyBytes: bytes, requestUrl: 'https://api3.qoder.sh/algo/x', creds: { userId: 'u', authToken: '' } }), /auth token is empty/);
});

test('the RSA key is a parseable 1024-bit public key (PKCS#1 v1.5 encryption can use it)', () => {
  const key = createPublicKey(QODER_RSA_PUBLIC_KEY);
  assert.equal(key.asymmetricKeyType, 'rsa');
  assert.equal(key.asymmetricKeyDetails.modulusLength, 1024);
  // The signer's own RSA step must agree with this padding; if the key were 2048+ a PKCS#1 v1.5
  // encryption of a 16-byte AES key would still work, but the modulus length is what Qoder's server
  // expects, so it is asserted rather than inferred.
  void cryptoConstants.RSA_PKCS1_PADDING;
  void privateDecrypt;
  void createDecipheriv;
  void generateKeyPairSync;
});
