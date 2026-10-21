// The per-install pepper for gateway API keys.
//
// The database stores sha256(pepper || key) for every key and never the key
// itself, so a stolen database — or an export of it — cannot be turned into a
// working credential. The pepper is the other half of that: it lives in its
// own 0600 file next to the install, never in the database and never in the
// repository, so a leaked dump cannot be replayed against the stored hashes.
//
// The file is part of the install: lose it and every stored hash stops
// matching, so the affected keys have to be reissued.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";
import { ensureSecureDir, ensureSecureFile } from "@/lib/secureFs.js";

const PEPPER_PATH = path.join(DATA_DIR, "auth", "key-pepper");
const PEPPER_BYTES = 32;
// A shorter file is not a pepper we wrote; using it would silently weaken the
// hash, so refuse instead.
const MIN_PEPPER_BYTES = 16;

let cachedPepper = null;

function readPepper() {
  let raw;
  try {
    raw = fs.readFileSync(PEPPER_PATH);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  if (raw.length < MIN_PEPPER_BYTES) {
    throw new Error(`[auth] key pepper at ${PEPPER_PATH} is too short — refusing to use it`);
  }
  return raw;
}

function createPepper() {
  ensureSecureDir(path.dirname(PEPPER_PATH));
  const pepper = crypto.randomBytes(PEPPER_BYTES);
  try {
    // "wx" fails when the file appeared in the meantime (two servers starting
    // at once): the winner's pepper is the install's pepper, ours is dropped —
    // a second pepper would invalidate every stored hash.
    fs.writeFileSync(PEPPER_PATH, pepper, { mode: 0o600, flag: "wx" });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const existing = readPepper();
    if (existing) return existing;
    throw e;
  }
  ensureSecureFile(PEPPER_PATH, 0o600);
  return pepper;
}

export function getKeyPepper() {
  if (!cachedPepper) cachedPepper = readPepper() || createPepper();
  return cachedPepper;
}

/**
 * sha256(pepper || key) — the value stored in apiKeys.keyHash.
 * @param {string} key - the plaintext key
 * @returns {string} hex digest
 */
export function hashApiKey(key) {
  return crypto
    .createHash("sha256")
    .update(getKeyPepper())
    .update(String(key ?? ""))
    .digest("hex");
}
