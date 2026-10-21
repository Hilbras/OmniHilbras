/**
 * Theme resolution helpers.
 *
 * The store keeps the user's choice ("light" | "dark" | "system"); what the
 * page shows is the *effective* theme, which for "system" follows the OS
 * preference. The helpers are pure so the rules can be unit tested.
 */

/** The theme that is actually on screen. */
export function resolveEffectiveTheme(theme, systemPrefersDark) {
  if (theme === "system") return systemPrefersDark ? "dark" : "light";
  return theme;
}

/**
 * The theme the toggle switches to. It flips what the user sees, so it starts
 * from the effective theme: on "system" with a dark OS it switches to light
 * instead of to dark again.
 */
export function nextTheme(theme, systemPrefersDark) {
  return resolveEffectiveTheme(theme, systemPrefersDark) === "dark" ? "light" : "dark";
}
