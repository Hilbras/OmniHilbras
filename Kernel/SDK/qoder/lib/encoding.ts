/**
 * Qoder's body encoding — pure string/byte arithmetic, safe in a browser.
 *
 * The algorithm (measured against the reference implementation):
 *  1. Base64-encode the plaintext using the standard alphabet.
 *  2. Split into thirds: `a = floor(n/3)`, rearrange as `[tail][mid][head]`.
 *  3. Substitute each character through the standard→custom alphabet table (`=` becomes `$`).
 *  4. Return the result as a latin1 (byte-per-code-point) string.
 *
 * This module deliberately avoids `Buffer`: the SDK barrel is imported by the dashboard, and a
 * module-scope `Buffer` there is a blank page. Base64 is done by hand, and bytes are produced as
 * `Uint8Array`.
 */

const QODER_STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const QODER_CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';

const BYTE_TO_BASE64: number[] = new Array(256).fill(-1);
for (let i = 0; i < 64; i++) BYTE_TO_BASE64[QODER_STD_ALPHABET.charCodeAt(i)] = i;

/** UTF-8 encode a string to bytes, without `TextEncoder`'s assumptions about the caller. */
function utf8Bytes(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return Uint8Array.from(bytes);
}

function base64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += QODER_STD_ALPHABET[(triple >> 18) & 0x3f];
    out += QODER_STD_ALPHABET[(triple >> 12) & 0x3f];
    out += i + 1 < bytes.length ? QODER_STD_ALPHABET[(triple >> 6) & 0x3f] : '=';
    out += i + 2 < bytes.length ? QODER_STD_ALPHABET[triple & 0x3f] : '=';
  }
  return out;
}

const QODER_S2C: number[] = (() => {
  const table = new Array(128).fill(-1);
  for (let i = 0; i < 64; i++) table[QODER_STD_ALPHABET.charCodeAt(i)] = QODER_CUSTOM_ALPHABET.charCodeAt(i);
  table['='.charCodeAt(0)] = '$'.charCodeAt(0);
  return table;
})();

/**
 * Encodes a JSON body for a Qoder request. Returns a latin1 string whose character codes are the
 * exact bytes to sign and send.
 */
export function qoderEncodeBody(body: string): string {
  const std = base64(utf8Bytes(body));
  const n = std.length;
  const a = Math.floor(n / 3);
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);

  let out = '';
  for (let i = 0; i < n; i++) {
    const c = rearranged.charCodeAt(i);
    const mapped = c < 128 ? QODER_S2C[c] : -1;
    out += String.fromCharCode(mapped !== undefined && mapped >= 0 ? mapped : c);
  }
  return out;
}

/** The raw bytes of an encoded latin1 string, for the gateway's signer. */
export function qoderEncodedBytes(encoded: string): Uint8Array {
  const bytes = new Uint8Array(encoded.length);
  for (let i = 0; i < encoded.length; i++) bytes[i] = encoded.charCodeAt(i) & 0xff;
  return bytes;
}
