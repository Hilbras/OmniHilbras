import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * The database export re-auth.
 *
 * `GET /api/settings/database` returns a full plaintext dump of the store —
 * every provider credential and every gateway API key. It sits behind the
 * dashboard session *and* a second factor (the dashboard password), so the
 * second factor has to mean something.
 *
 * Two holes are closed here:
 *
 *  1. The route treated a request as a trusted local CLI request when the
 *     `x-9r-cli-token` header was merely *present*. A valid dashboard session
 *     plus `x-9r-cli-token: x` was enough to download the dump without
 *     knowing the password. The token's value is now compared.
 *  2. The password re-auth accepted the built-in default (`123456`), which is
 *     published in the source — so the second factor was worth nothing.
 */

const settings = { password: null };

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => settings,
}));

const { verifyDashboardPassword } = await import("@/lib/auth/dashboardSession.js");
const { hasValidCliToken, getCliToken } = await import("@/lib/auth/cliToken.js");

describe("database export re-auth", () => {
  beforeEach(() => {
    settings.password = null;
    delete process.env.INITIAL_PASSWORD;
  });

  it("does not accept a CLI token header that merely exists", async () => {
    const request = new Request("http://localhost/api/settings/database", {
      headers: { "x-9r-cli-token": "anything-at-all" },
    });
    expect(await hasValidCliToken(request)).toBe(false);
  });

  it("accepts the real CLI token", async () => {
    const request = new Request("http://localhost/api/settings/database", {
      headers: { "x-9r-cli-token": await getCliToken() },
    });
    expect(await hasValidCliToken(request)).toBe(true);
  });

  it("does not accept the well-known default password as a re-auth", async () => {
    // No password has been set, and the built-in default is public knowledge.
    expect(await verifyDashboardPassword("123456")).toBe(false);
  });

  it("accepts a configured INITIAL_PASSWORD as a re-auth", async () => {
    // The operator chose this one, so it is a real second factor.
    process.env.INITIAL_PASSWORD = "operator-chose-this";
    expect(await verifyDashboardPassword("operator-chose-this")).toBe(true);
    expect(await verifyDashboardPassword("123456")).toBe(false);
  });

  it("still accepts the stored password when one is set", async () => {
    const bcrypt = await import("bcryptjs");
    settings.password = await bcrypt.hash("the-real-password", 10);
    expect(await verifyDashboardPassword("the-real-password")).toBe(true);
    expect(await verifyDashboardPassword("123456")).toBe(false);
  });
});
