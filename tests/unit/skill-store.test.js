// Skill Marketplace service behind /api/skills.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let store;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omnihilbras-skills-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  store = await import("@/lib/skills/skillStore.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("skill store", () => {
  it("catalog lists every bundled skill, entry skill first, none installed", async () => {
    const all = await store.fetchManifest();
    expect(all.length).toBeGreaterThanOrEqual(9);
    expect(all[0].id).toBe("omnihilbras");
    expect(all.every((s) => !s.installed)).toBe(true);
  });

  it("search matches text and filters by category", async () => {
    expect((await store.searchSkills("transcribe")).map((s) => s.id)).toContain("omnihilbras-stt");
    const web = await store.searchSkills("", "web");
    expect(web.map((s) => s.id).sort()).toEqual(["omnihilbras-web-fetch", "omnihilbras-web-search"]);
    expect(await store.searchSkills("no-such-skill-xyz")).toEqual([]);
  });

  it("install writes SKILL.md under DATA_DIR and records it", async () => {
    const skill = await store.installSkill("omnihilbras-chat");
    const file = path.join(tempDir, "skills", "omnihilbras-chat", "SKILL.md");
    expect(skill.installed).toBe(true);
    expect(skill.path).toBe(file);
    expect(fs.readFileSync(file, "utf8")).toBe(store.getSkillText("omnihilbras-chat"));
    expect((await store.listInstalledSkills()).map((s) => s.id)).toEqual(["omnihilbras-chat"]);
  });

  it("flags an update when the installed version differs, and update clears it", async () => {
    const row = await db.getInstalledSkill("omnihilbras-chat");
    await db.saveInstalledSkill("omnihilbras-chat", { ...row, sha256: "old" });
    expect((await store.getSkill("omnihilbras-chat")).updateAvailable).toBe(true);
    const updated = await store.installSkill("omnihilbras-chat");
    expect(updated.updateAvailable).toBe(false);
    expect(updated.installedAt).toBe(row.installedAt);
  });

  it("a row whose file was deleted by hand reads as not installed", async () => {
    await store.installSkill("omnihilbras-tts");
    fs.rmSync(path.join(tempDir, "skills", "omnihilbras-tts"), { recursive: true });
    expect((await store.getSkill("omnihilbras-tts")).installed).toBe(false);
    expect((await store.listInstalledSkills()).map((s) => s.id)).not.toContain("omnihilbras-tts");
  });

  it("uninstall removes the file and the row", async () => {
    expect(await store.uninstallSkill("omnihilbras-chat")).toBe(true);
    expect(fs.existsSync(path.join(tempDir, "skills", "omnihilbras-chat"))).toBe(false);
    expect(await db.getInstalledSkill("omnihilbras-chat")).toBeNull();
    expect(await store.uninstallSkill("omnihilbras-chat")).toBe(false);
  });

  it("rejects ids that are not catalog keys or could escape the install dir", async () => {
    expect(await store.installSkill("not-in-catalog")).toBeNull();
    for (const id of ["../etc", "a/b", "", "UPPER", ".hidden"]) {
      expect(store.isValidSkillId(id)).toBe(false);
      expect(await store.uninstallSkill(id)).toBe(false);
    }
  });
});
