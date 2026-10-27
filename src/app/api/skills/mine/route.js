import { NextResponse } from "next/server";
import { listInstalledSkills } from "@/lib/skills/skillStore";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ skills: await listInstalledSkills() });
  } catch (error) {
    console.error("[API] Failed to list installed skills:", error);
    return NextResponse.json({ error: "Failed to list installed skills" }, { status: 500 });
  }
}
