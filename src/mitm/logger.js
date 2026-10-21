const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { DATA_DIR } = require("./paths");
const { LOG_BLACKLIST_URL_PARTS } = require("./config");

function time() {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

const log = (msg) => console.log(`[${time()}] [MITM] ${msg}`);
const err = (msg) => console.error(`[${time()}] ❌ [MITM] ${msg}`);

const DUMP_DIR = path.join(DATA_DIR, "logs", "mitm");
if (!fs.existsSync(DUMP_DIR)) fs.mkdirSync(DUMP_DIR, { recursive: true, mode: 0o700 });
// 0700: the dumps carry intercepted provider traffic (credentials included),
// so only the owner may list this directory — even one created earlier with a
// looser mode gets tightened here.
try { fs.chmodSync(DUMP_DIR, 0o700); } catch { /* best effort */ }
// The directory above it is tightened as well: it lists the dump folders, and
// a directory that another process created earlier keeps its old mode.
try { fs.chmodSync(path.join(DATA_DIR, "logs"), 0o700); } catch { /* best effort */ }

// Header names whose values carry a credential. A credential written to disk in
// plaintext is a credential stolen by anyone who can read the dump directory,
// so the value never reaches the file — only the header name survives.
const SENSITIVE_HEADER_KEYS = [
  "authorization",
  "api-key",
  "apikey",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-auth",
  "secret",
  "token",
  "session",
  "password",
  "credential",
];

// Placeholder written instead of a credential. Not even a short prefix of the
// secret is kept: a prefix narrows a brute-force space and fingerprints the
// key for anyone holding the dump directory.
const REDACTED = "***redacted***";

/**
 * Mask credential-bearing header values.
 * Authorization keeps only its auth scheme ("Bearer ***redacted***") so the
 * request stays readable without leaking the token; every other sensitive
 * header is replaced wholesale.
 * @param {Record<string, unknown>} headers - Header map (plain object)
 * @returns {Record<string, unknown>} Copy with credential values redacted
 */
function maskSensitiveHeaders(headers) {
  if (!headers) return {};

  const masked = { ...headers };
  const sensitiveKeys = SENSITIVE_HEADER_KEYS;

  for (const key of Object.keys(masked)) {
    const lowerKey = key.toLowerCase();
    if (!sensitiveKeys.some(sk => lowerKey.includes(sk))) continue;

    const value = masked[key];
    if (value === null || value === undefined) continue;
    // Set-Cookie arrives as an array — keep the shape, drop the values.
    if (Array.isArray(value)) {
      masked[key] = value.map(() => REDACTED);
      continue;
    }
    if (typeof value !== "string") {
      masked[key] = REDACTED;
      continue;
    }
    // The auth scheme is not part of the secret; the token after it is.
    const trimmed = value.trim();
    const scheme = trimmed.split(/\s+/)[0];
    const keepScheme = lowerKey.includes("authorization")
      && scheme !== trimmed
      && /^[A-Za-z][A-Za-z0-9-]*$/.test(scheme);
    masked[key] = keepScheme ? `${scheme} ${REDACTED}` : REDACTED;
  }
  return masked;
}

// Clear all files inside DUMP_DIR (called on MITM server start to avoid unbounded growth)
function clearDumpDir() {
  try {
    if (!fs.existsSync(DUMP_DIR)) return;
    for (const f of fs.readdirSync(DUMP_DIR)) {
      try { fs.rmSync(path.join(DUMP_DIR, f), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

const EMPTY_BODY_RE = /^\s*(\{\s*\}|\[\s*\]|null)?\s*$/;

function slugify(s, max = 80) {
  return String(s).replace(/[^a-zA-Z0-9]/g, "_").substring(0, max);
}

function isBlacklisted(url) {
  if (!url) return false;
  return LOG_BLACKLIST_URL_PARTS.some(part => url.includes(part));
}

// Decode body buffer based on content-encoding header
function decodeBody(buf, encoding) {
  if (!buf || buf.length === 0) return buf;
  try {
    const enc = (encoding || "").toLowerCase();
    if (enc.includes("gzip")) return zlib.gunzipSync(buf);
    if (enc.includes("br")) return zlib.brotliDecompressSync(buf);
    if (enc.includes("deflate")) return zlib.inflateSync(buf);
  } catch { /* return raw on failure */ }
  return buf;
}

// Save raw request: method + url + headers + body
function dumpRequest(req, bodyBuffer, tag = "raw") {
  if (isBlacklisted(req.url)) return null;
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const slug = slugify((req.headers.host || "") + req.url);
    const file = path.join(DUMP_DIR, `${ts}_${tag}_${slug}.req.json`);
    let parsed = null;
    try { parsed = JSON.parse(bodyBuffer.toString()); } catch { /* not JSON */ }
    fs.writeFileSync(file, JSON.stringify({
      method: req.method,
      url: req.url,
      host: req.headers.host,
      headers: maskSensitiveHeaders(req.headers),
      body: parsed ?? bodyBuffer.toString("utf8")
    }, null, 2), { mode: 0o600 });
    // 0600: the dump carries provider credentials — owner-only, always.
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
    return file;
  } catch { return null; }
}

// Buffer-based response dumper — collects chunks then decodes + writes once on end()
// Trade-off: holds response in RAM, but enables gzip/br decoding for readable output.
function createResponseDumper(req, tag = "raw") {
  if (isBlacklisted(req.url)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = slugify((req.headers.host || "") + req.url);
  const file = path.join(DUMP_DIR, `${ts}_${tag}_${slug}.res.txt`);
  let status = 0;
  let headers = {};
  const chunks = [];
  return {
    writeHeader: (s, h) => { status = s; headers = h || {}; },
    writeChunk: (chunk) => {
      if (chunk == null) return;
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
    end: () => {
      try {
        const raw = Buffer.concat(chunks);
        const enc = headers["content-encoding"] || headers["Content-Encoding"];
        const decoded = decodeBody(raw, enc);
        const text = decoded.toString("utf8");
        // Skip empty / trivially-empty bodies
        if (EMPTY_BODY_RE.test(text)) return;
        // Strip content-encoding since body is now decoded
        const cleanHeaders = { ...headers };
        delete cleanHeaders["content-encoding"];
        delete cleanHeaders["Content-Encoding"];
        const out = `STATUS: ${status}\nHEADERS: ${JSON.stringify(maskSensitiveHeaders(cleanHeaders), null, 2)}\n---BODY---\n${text}`;
        fs.writeFileSync(file, out, { mode: 0o600 });
        try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
      } catch { /* ignore */ }
    },
    file
  };
}

module.exports = { log, err, dumpRequest, createResponseDumper, clearDumpDir, maskSensitiveHeaders };
