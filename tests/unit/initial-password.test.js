// The first login password.
//
// It used to be "123456" — a literal in the source, in the docs and in every
// screenshot of this project. Anyone who had read the README could log in.
//
// A fresh install now gets a password that only the operator can read: it is
// generated once, stored as a hash like any other password, and written next
// to the other secrets (0600) so it can be read once and changed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omnihilbras-initial-password-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
});

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("the initial password", () => {
  it("is random, readable and free of look-alike characters", async () => {
    const { generatePassword } = await import("@/lib/auth/initialPassword.js");
    const first = generatePassword();
    const second = generatePassword();

    expect(first).not.toBe(second);
    // Four groups of five, so it can be read off a terminal and typed back.
    expect(first.split("-")).toHaveLength(4);
    for (const group of first.split("-")) expect(group).toHaveLength(5);
    // No 0/O, 1/l/I, 5/S: they are what gets mistyped.
    expect(first).not.toMatch(/[0O1lI5S]/);
  });

  it("is created once, stored as a hash and written where the operator can read it", async () => {
    const { ensureInitialPassword, initialPasswordPath, readInitialPassword } = await import(
      "@/lib/auth/initialPassword.js"
    );
    const { getSettings } = await import("@/lib/localDb");
    const bcrypt = (await import("bcryptjs")).default;

    const first = await ensureInitialPassword();
    expect(first.created).toBe(true);
    expect(first.password).toBeTruthy();

    // Stored as a hash, never in the clear.
    const settings = await getSettings();
    expect(settings.password).toBeTruthy();
    expect(settings.password).not.toBe(first.password);
    expect(await bcrypt.compare(first.password, settings.password)).toBe(true);

    // Written next to the other secrets, readable by the owner only.
    expect(fs.existsSync(initialPasswordPath())).toBe(true);
    expect(readInitialPassword()).toBe(first.password);
    expect(fs.statSync(initialPasswordPath()).mode & 0o077).toBe(0);

    // A second call changes nothing: the operator's password wins.
    const second = await ensureInitialPassword();
    expect(second.created).toBe(false);
    expect(second.password).toBeNull();
  });

  it("replaces the password the CLI resets", async () => {
    const { setInitialPassword, readInitialPassword, initialPasswordPath } = await import(
      "@/lib/auth/initialPassword.js"
    );
    const { getSettings } = await import("@/lib/localDb");

    const password = await setInitialPassword();
    expect(password).toBeTruthy();
    expect(readInitialPassword()).toBe(password);
    expect(fs.statSync(initialPasswordPath()).mode & 0o077).toBe(0);

    const settings = await getSettings();
    expect(settings.password).toBeTruthy();
    expect(settings.password).not.toBe(password);
  });
});

describe("the public default is gone", () => {
  it("no password path in the source falls back to a guessable literal", () => {
    const files = [
      "src/app/api/auth/login/route.js",
      "src/app/api/settings/route.js",
      "src/app/api/auth/reset-password/route.js",
      "src/app/login/page.js",
      "src/app/(dashboard)/dashboard/profile/page.js",
      "cli/src/cli/menus/settings.js",
    ];
    for (const file of files) {
      const source = fs.readFileSync(path.resolve(import.meta.dirname, "../..", file), "utf8");
      expect(source, `${file} must not mention the old default`).not.toContain("123456");
    }
  });
});
