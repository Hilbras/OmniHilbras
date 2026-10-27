// Bundles skills/<id>/SKILL.md into skills/SKILLS_INDEX.json.
//
// The standalone build does not ship the skills/ folder, so the skill store
// imports this JSON instead of reading the folder at runtime. Runs before every
// build (prebuild); tests/unit/skills-index.test.js fails if it is stale.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const out = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

export function buildSkillsIndex(skillsDir) {
  const skills = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(file)) continue;
    const content = readFileSync(file, "utf8");
    const meta = parseFrontmatter(content);
    skills.push({
      id: entry.name,
      name: meta.name || entry.name,
      description: meta.description || "",
      sha256: createHash("sha256").update(content).digest("hex"),
      content,
    });
  }
  skills.sort((a, b) => a.id.localeCompare(b.id));
  return { skills };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "skills");
  const index = buildSkillsIndex(skillsDir);
  writeFileSync(join(skillsDir, "SKILLS_INDEX.json"), JSON.stringify(index, null, 2) + "\n");
  console.log(`[skills-index] ${index.skills.length} skills → skills/SKILLS_INDEX.json`);
}
