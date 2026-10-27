// Skill Marketplace service.
//
// Catalog: skills/SKILLS_INDEX.json, bundled at build time (the standalone
// build does not ship the skills/ folder), merged with the dashboard metadata
// in src/shared/constants/skills.js. Installing a skill writes its SKILL.md to
// DATA_DIR/skills/<id>/SKILL.md, where local agents can read it, and records
// the installed version in the database.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir";
import {
  getInstalledSkills, getInstalledSkill, saveInstalledSkill, deleteInstalledSkill,
} from "@/lib/db/index.js";
import { SKILLS, getSkillRawUrl } from "@/shared/constants/skills";
import skillsIndex from "../../../skills/SKILLS_INDEX.json";

export const SKILLS_INSTALL_DIR = path.join(DATA_DIR, "skills");

// Also guards the install path: an id is only ever a catalog key.
const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const metaById = Object.fromEntries(SKILLS.map((s) => [s.id, s]));

function toCatalogEntry(indexed) {
  const meta = metaById[indexed.id] || {};
  return {
    id: indexed.id,
    name: meta.name || indexed.name,
    description: meta.description || indexed.description,
    longDescription: indexed.description,
    category: meta.category || "other",
    icon: meta.icon || "extension",
    endpoint: meta.endpoint || null,
    isEntry: !!meta.isEntry,
    rawUrl: getSkillRawUrl(indexed.id),
    sha256: indexed.sha256,
  };
}

// Entry skill first, then the dashboard's order, then anything new by id.
const ORDER = new Map(SKILLS.map((s, i) => [s.id, i]));
const CATALOG = (skillsIndex.skills || [])
  .filter((s) => SKILL_ID_PATTERN.test(s.id))
  .map((s) => ({ entry: toCatalogEntry(s), content: s.content }))
  .sort((a, b) => (ORDER.get(a.entry.id) ?? 999) - (ORDER.get(b.entry.id) ?? 999) || a.entry.id.localeCompare(b.entry.id));
const CATALOG_BY_ID = new Map(CATALOG.map((c) => [c.entry.id, c]));

export function isValidSkillId(id) {
  return typeof id === "string" && SKILL_ID_PATTERN.test(id);
}

function installedFile(id) {
  return path.join(SKILLS_INSTALL_DIR, id, "SKILL.md");
}

// installed: the DB row, or null. A row whose file was deleted by hand counts
// as not installed, so the UI offers a reinstall instead of a broken entry.
function withInstallState(entry, installed) {
  const present = installed && fs.existsSync(installedFile(entry.id));
  return {
    ...entry,
    installed: !!present,
    installedAt: present ? installed.installedAt : null,
    updateAvailable: !!present && installed.sha256 !== entry.sha256,
    path: present ? installedFile(entry.id) : null,
  };
}

export async function fetchManifest() {
  const installed = new Map((await getInstalledSkills()).map((r) => [r.id, r]));
  return CATALOG.map(({ entry }) => withInstallState(entry, installed.get(entry.id)));
}

export async function searchSkills(query = "", category = "") {
  const q = query.trim().toLowerCase();
  const all = await fetchManifest();
  return all.filter((s) => {
    if (category && s.category !== category) return false;
    if (!q) return true;
    return [s.id, s.name, s.description, s.longDescription, s.endpoint || ""]
      .some((field) => field.toLowerCase().includes(q));
  });
}

export async function getSkill(id) {
  const item = CATALOG_BY_ID.get(id);
  if (!item) return null;
  return { ...withInstallState(item.entry, await getInstalledSkill(id)), content: item.content };
}

export function getSkillText(id) {
  return CATALOG_BY_ID.get(id)?.content ?? null;
}

// Install and update are the same operation: write the bundled version.
export async function installSkill(id) {
  const item = CATALOG_BY_ID.get(id);
  if (!item) return null;
  const file = installedFile(id);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, item.content, { mode: 0o600 });
  const previous = await getInstalledSkill(id);
  const now = new Date().toISOString();
  await saveInstalledSkill(id, {
    sha256: item.entry.sha256,
    installedAt: previous?.installedAt || now,
    updatedAt: now,
  });
  return getSkill(id);
}

export async function uninstallSkill(id) {
  if (!isValidSkillId(id)) return false;
  const hadRow = await deleteInstalledSkill(id);
  const dir = path.join(SKILLS_INSTALL_DIR, id);
  const hadFile = fs.existsSync(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return hadRow || hadFile;
}

// Installed skills, including ones no longer in the catalog (kept so the user
// can still see and remove them).
export async function listInstalledSkills() {
  const rows = await getInstalledSkills();
  return rows.map((row) => {
    const item = CATALOG_BY_ID.get(row.id);
    if (item) return withInstallState(item.entry, row);
    const file = installedFile(row.id);
    return {
      id: row.id, name: row.id, description: "No longer in the catalog", category: "other",
      icon: "extension", endpoint: null, isEntry: false, rawUrl: null, sha256: row.sha256,
      installed: fs.existsSync(file), installedAt: row.installedAt, updateAvailable: false,
      path: fs.existsSync(file) ? file : null, orphaned: true,
    };
  }).filter((s) => s.installed);
}

export function readInstalledSkillText(id) {
  if (!isValidSkillId(id)) return null;
  try {
    return fs.readFileSync(installedFile(id), "utf8");
  } catch {
    return null;
  }
}
