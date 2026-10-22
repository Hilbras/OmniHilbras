// The password a fresh install starts with.
//
// It used to be "123456" — a literal in the source, in the docs and in every
// screenshot of this project. Anyone who had ever read the README could log
// in: the remote path refused it, but the local path did not, and the CLI's
// "reset to default" put you straight back on it.
//
// A fresh install now gets a password nobody else knows. It is generated
// once, stored as a hash like any other password, and written next to the
// other secrets (0600) so the operator can read it once — from the terminal
// or from the file — and then change it.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { getSettings, updateSettings } from "@/lib/localDb";
import { DATA_DIR } from "@/lib/dataDir";

// No look-alike characters (0/O, 1/l/I, 5/S): the password is read off a
// terminal and typed back, so it has to survive that.
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const GROUPS = 4;
const GROUP_LENGTH = 5;

const PASSWORD_FILE = path.join(DATA_DIR, "initial-password");

/** A readable random password, e.g. "ktwp-mqzn-4vhc-xdrb". */
export function generatePassword() {
  const groups = [];
  for (let g = 0; g < GROUPS; g++) {
    let group = "";
    for (let i = 0; i < GROUP_LENGTH; i++) {
      group += ALPHABET[crypto.randomInt(ALPHABET.length)];
    }
    groups.push(group);
  }
  return groups.join("-");
}

/** Where the initial password is written for the operator to read. */
export function initialPasswordPath() {
  return PASSWORD_FILE;
}

/** The initial password, if the file is still there. */
export function readInitialPassword() {
  try {
    return fs.readFileSync(PASSWORD_FILE, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Forget the initial password — the operator has set their own by now. */
export function clearInitialPasswordFile() {
  try {
    fs.rmSync(PASSWORD_FILE, { force: true });
  } catch {
    /* best effort */
  }
}

function writeInitialPasswordFile(password) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(PASSWORD_FILE, `${password}\n`, { mode: 0o600 });
  // The file holds a working credential: it must not be readable by anyone
  // else, even on a machine that umask is generous on.
  try {
    fs.chmodSync(PASSWORD_FILE, 0o600);
  } catch {
    /* best effort */
  }
}

/**
 * The password this install starts with, and whether it was just created.
 *
 * - a password already stored wins — the operator has set their own;
 * - `INITIAL_PASSWORD` is the operator's explicit choice and is used as it is
 *   (it stays in the environment, which is theirs to manage);
 * - otherwise one is generated: there is no public default to guess.
 *
 * @returns {Promise<{password: string|null, created: boolean}>} the password
 *   when it was just generated, so the caller can print it once.
 */
export async function ensureInitialPassword() {
  const settings = await getSettings();
  if (settings.password) return { password: null, created: false };
  if (process.env.INITIAL_PASSWORD) {
    return { password: process.env.INITIAL_PASSWORD, created: false };
  }

  const password = generatePassword();
  const salt = await bcrypt.genSalt(10);
  const hash = await bcrypt.hash(password, salt);
  await updateSettings({ password: hash });
  writeInitialPasswordFile(password);
  return { password, created: true };
}

/**
 * Set a new password, and tell the operator what it is.
 *
 * Used by the CLI's "reset password": the old flow cleared the stored hash,
 * which put the install back on the public default. This one gives it a
 * password that only the operator knows.
 */
export async function setInitialPassword() {
  const password = generatePassword();
  const salt = await bcrypt.genSalt(10);
  const hash = await bcrypt.hash(password, salt);
  await updateSettings({ password: hash });
  writeInitialPasswordFile(password);
  return password;
}
