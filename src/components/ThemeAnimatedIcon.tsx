import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';

/**
 * The animated half of the theme toggle, split into its own module so `motion` is not part of the
 * dashboard's initial download.
 *
 * ## Why this is a separate file
 *
 * The toggle was the *only* thing on the dashboard that used `motion`, and it uses it for one
 * icon flip. But `DashboardShell` imports `ThemeToggle`, so `motion/react` sat in the shared
 * chunk that `dashboard.html` loads — **284 KB rendered** (`analyze-bundle.mjs`), roughly 90 KB of
 * its gzipped CSS+JS, for an animation a user sees only if they press a button.
 *
 * A static import cannot be tree-shaken away here: the module is reached from the dashboard's own
 * entry through two imports, so Rollup is right to include it. The fix is to make the dependency
 * **dynamic**, which is what `ThemeToggle` does — it imports this file after the page is idle.
 * The library still ships, and still animates, but it is off the critical path and out of the
 * chunk a first paint needs.
 *
 * `motion` lives here and nowhere else the dashboard can reach, so the lazy boundary is one file
 * rather than a rule someone has to remember.
 */
export function ThemeAnimatedIcon({ theme, children }: { theme: 'light' | 'dark'; children: ReactNode }) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span
        key={theme}
        className="grid place-items-center"
        initial={{ opacity: 0, scale: 0.4, rotate: -120 }}
        animate={{ opacity: 1, scale: 1, rotate: 0, transition: { duration: 0.3, ease: [0.34, 1.56, 0.64, 1] } }}
        exit={{ opacity: 0, scale: 0.4, rotate: 120, transition: { duration: 0.15, ease: 'easeIn' } }}
      >
        {children}
      </motion.span>
    </AnimatePresence>
  );
}