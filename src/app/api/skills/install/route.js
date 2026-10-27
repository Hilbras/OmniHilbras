import { NextResponse } from "next/server";
import { installSkill, isValidSkillId } from "@/lib/skills/skillStore";

export const dynamic = "force-dynamic";

/**
 * POST /api/skills/install  { id }
 * Installs the catalog version, or updates an installed skill to it.
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isValidSkillId(body.id)) {
    return NextResponse.json({ error: "Invalid skill id" }, { status: 400 });
  }
  try {
    const skill = await installSkill(body.id);
    if (!skill) return NextResponse.json({ error: "Skill not found in catalog" }, { status: 404 });
    const { content, ...meta } = skill;
    return NextResponse.json({ skill: meta });
  } catch (error) {
    console.error("[API] Failed to install skill:", error);
    return NextResponse.json({ error: "Failed to install skill" }, { status: 500 });
  }
}
