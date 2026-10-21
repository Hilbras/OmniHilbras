// The theme toggle flips the theme that is on screen, not the stored one:
// on "system" the stored value says nothing about what the user sees, so a
// dark OS has to toggle to light.
import { describe, it, expect } from "vitest";
import { resolveEffectiveTheme, nextTheme } from "@/store/themeUtils.js";

describe("theme resolution", () => {
  it("resolves an explicit theme to itself", () => {
    expect(resolveEffectiveTheme("dark", false)).toBe("dark");
    expect(resolveEffectiveTheme("light", true)).toBe("light");
  });

  it("resolves 'system' against the OS preference", () => {
    expect(resolveEffectiveTheme("system", true)).toBe("dark");
    expect(resolveEffectiveTheme("system", false)).toBe("light");
  });

  it("toggles a dark OS on 'system' to light", () => {
    expect(nextTheme("system", true)).toBe("light");
  });

  it("toggles a light OS on 'system' to dark", () => {
    expect(nextTheme("system", false)).toBe("dark");
  });

  it("toggles an explicit theme as before", () => {
    expect(nextTheme("dark", false)).toBe("light");
    expect(nextTheme("light", true)).toBe("dark");
  });
});
