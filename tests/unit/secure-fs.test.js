import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureSecureDir, ensureSecureFile } from "@/lib/secureFs.js";

/**
 * The secret store's permissions.
 *
 * The database holds every provider credential in plaintext, so the directory
 * around it and the file itself must not be readable by other local users.
 * The small secret files (`jwt-secret`, `auth/cli-secret`) were always 0600 —
 * the big one was not, and the smaller secret had the stronger protection.
 */
describe("secure filesystem helpers", () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omnihilbras-securefs-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("creates a directory that only the owner can enter", () => {
    const dir = path.join(tmp, "db");
    ensureSecureDir(dir);
    // 0700: rwx for the owner, nothing for anyone else.
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("tightens the mode of a directory that already existed", () => {
    // mkdir's mode only applies to directories it actually creates, so an
    // existing one keeps its old mode — the explicit chmod is what closes it.
    const dir = path.join(tmp, "existing");
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    expect(fs.statSync(dir).mode & 0o777).toBe(0o755);

    ensureSecureDir(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("makes a file owner-only, and leaves a missing file alone", () => {
    const file = path.join(tmp, "data.sqlite");
    fs.writeFileSync(file, "x", { mode: 0o644 });
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);

    expect(ensureSecureFile(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    // A file that does not exist yet is not an error — the caller creates it.
    expect(ensureSecureFile(path.join(tmp, "nope.sqlite"))).toBe(false);
  });

  it("never throws when the mode cannot be changed", () => {
    // A volume this process does not own, or a filesystem without modes, must
    // not stop the gateway from starting.
    const dir = path.join(tmp, "unwritable");
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o500); // r-x for the owner: cannot chmod inside
    expect(() => ensureSecureDir(path.join(dir, "child"))).not.toThrow();
    expect(() => ensureSecureFile(path.join(dir, "child", "file"))).not.toThrow();
    fs.chmodSync(dir, 0o700);
  });

  it("leaves a world-readable database unreadable by anyone else", () => {
    // The end-to-end property, stated as a test: a database created by an
    // older build is tightened the next time the gateway opens it.
    const file = path.join(tmp, "data.sqlite");
    fs.writeFileSync(file, "x", { mode: 0o644 });
    ensureSecureFile(file);
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode & 0o077).toBe(0); // no group or other access at all
  });
});
