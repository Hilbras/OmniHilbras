import { NextResponse } from "next/server";
import { getSkill, uninstallSkill, isValidSkillId, readInstalledSkillText } from "@/lib/skills/skillStore";

export const dynamic = "force-dynamic";

/**
 * GET /api/skills/<id> — catalog entry with its SKILL.md. When installed, also
 * returns the installed text (it differs from the catalog when an update is pending).
 */
export async function GET(request, { params }) {
  const { id } = await params;
  if (!isValidSkillId(id)) return NextResponse.json({ error: "Invalid skill id" }, { status: 400 });
  try {
    const skill = await getSkill(id);
    if (!skill) return NextResponse.json({ error: "Skill not found" }, { status: 404 });
    return NextResponse.json({
      skill,
      installedContent: skill.installed ? readInstalledSkillText(id) : null,
    });
  } catch (error) {
    console.error("[API] Failed to get skill:", error);
    return NextResponse.json({ error: "Failed to get skill" }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  const { id } = await params;
  if (!isValidSkillId(id)) return NextResponse.json({ error: "Invalid skill id" }, { status: 400 });
  try {
    const removed = await uninstallSkill(id);
    if (!removed) return NextResponse.json({ error: "Skill is not installed" }, { status: 404 });
    return NextResponse.json({ uninstalled: id });
  } catch (error) {
    console.error("[API] Failed to uninstall skill:", error);
    return NextResponse.json({ error: "Failed to uninstall skill" }, { status: 500 });
  }
}
