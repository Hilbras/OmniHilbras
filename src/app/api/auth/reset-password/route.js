import { NextResponse } from "next/server";
import { setInitialPassword } from "@/lib/auth/initialPassword";

// Reset the dashboard password.
//
// It used to clear the stored hash, which put the install back on the public
// default — a password that is in every screenshot of this project. It now
// gives the install a password that only the operator can read, and returns
// it so the CLI can show it once.
//
// Local-only (enforced by dashboardGuard): a remote session must not be able
// to reset the password and take the install over.
export async function POST() {
  try {
    const password = await setInitialPassword();
    return NextResponse.json({ success: true, password });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
