import { NextResponse } from "next/server";
import { searchSkills } from "@/lib/skills/skillStore";
import { SKILL_CATEGORIES } from "@/shared/constants/skills";

export const dynamic = "force-dynamic";

/**
 * GET /api/skills?q=&category=
 * The catalog with each skill's install state.
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q") || "";
  const category = searchParams.get("category") || "";
  if (category && !SKILL_CATEGORIES.some((c) => c.id === category)) {
    return NextResponse.json({ error: "Unknown category" }, { status: 400 });
  }
  try {
    return NextResponse.json({ skills: await searchSkills(q, category), categories: SKILL_CATEGORIES });
  } catch (error) {
    console.error("[API] Failed to list skills:", error);
    return NextResponse.json({ error: "Failed to list skills" }, { status: 500 });
  }
}
