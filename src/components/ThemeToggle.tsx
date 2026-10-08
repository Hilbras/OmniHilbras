import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';

/**
 * The theme toggle, and the one place the dashboard touches an animation library.
 *
 * ## Why `motion` is loaded lazily
 *
 * This component is the **only** user of `motion/react` on the dashboard, for a single icon flip.
 * Because `DashboardShell` imports it, a static import put the whole library in the shared chunk
 * `dashboard.html` loads — **284 KB rendered**, about 90 KB gzipped, on every dashboard page load
 * for an animation nobody sees unless they press the button. `scripts/analyze-bundle.mjs` measures
 * it and `--check` fails if it comes back; `tests/bundle-budget.test.js` asserts the source side.
 *
 * So the animated icon lives in `ThemeAnimatedIcon.tsx` and is pulled in on **intent** — a pointer
 * or a keyboard focus on the toggle, which is the moment before it can be pressed. The toggle is
 * usable throughout: before the chunk arrives, and forever under reduced motion, it renders the
 * plain icon, which is what it looked like before the animation existed. Someone who never touches
 * the theme toggle never downloads the library at all.
 *
 * `prefers-reduced-motion` is honoured *before* the import, so a user who asked for less motion
 * never downloads the library either.
 */

type AnimatedIcon = ComponentType<{ theme: 'light' | 'dark'; children: ReactNode }>;

let cached: AnimatedIcon | null = null;
let inflight: Promise<AnimatedIcon> | null = null;

/** Imports the animated icon once, however many callers ask. */
function loadAnimatedIcon(): Promise<AnimatedIcon> {
  if (cached) return Promise.resolve(cached);
  inflight ??= import('./ThemeAnimatedIcon').then((mod) => (cached = mod.ThemeAnimatedIcon));
  return inflight;
}

/** `requestIdleCallback` where it exists, a timeout otherwise (Safari shipped it late). */
function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function MoonSparkle({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
      <path d="m20 2 1.1 1.9L23 5l-1.9 1.1L20 8l-1.1-1.9L17 5l1.9-1.1L20 2Z" />
    </svg>
  );
}

function SunSparkle({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="12" r="3.6" />
      <path d="m12 1.6 1.6 3L12 7.6l-1.6-3 1.6-3Z" />
      <path d="m12 16.4 1.6 3-1.6 3-1.6-3 1.6-3Z" />
      <path d="m1.6 12 3-1.6 3 1.6-3 1.6-3-1.6Z" />
      <path d="m16.4 12 3-1.6 3 1.6-3 1.6-3-1.6Z" />
    </svg>
  );
}

type Theme = 'light' | 'dark';

function getTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(getTheme);
  // `null` until the animation library has arrived. Nothing depends on it, so the toggle is
  // interactive from the first render either way.
  const [Animated, setAnimated] = useState<AnimatedIcon | null>(cached);
  const animationTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('omnihilbras-theme', theme);
    } catch {
      // The theme still applies for this session when storage is unavailable.
    }
  }, [theme]);

  /** Fetches the animated icon, unless it is not wanted or already here. */
  const warm = useCallback(() => {
    if (prefersReducedMotion()) return;
    void loadAnimatedIcon().then((component) => setAnimated(() => component));
  }, []);

  useEffect(() => () => window.clearTimeout(animationTimer.current), []);

  const nextTheme = theme === 'dark' ? 'light' : 'dark';
  const icon = theme === 'light' ? <MoonSparkle /> : <SunSparkle />;

  const animateThemeClass = useCallback(() => {
    if (prefersReducedMotion()) return;
    document.documentElement.classList.add('theme-anim');
    window.clearTimeout(animationTimer.current);
    animationTimer.current = window.setTimeout(() => {
      document.documentElement.classList.remove('theme-anim');
    }, 450);
  }, []);

  function toggleTheme() {
    animateThemeClass();
    setTheme(nextTheme);
  }

  return (
    <button
      type="button"
      onClick={toggleTheme}
      // Intent is a better signal than the idle timer: a pointer or a keyboard focus on the toggle
      // means the animation is about to be wanted, so start the fetch then rather than later.
      onPointerEnter={warm}
      onFocus={warm}
      aria-label={`Switch to ${nextTheme} theme`}
      title={`Switch to ${nextTheme} theme`}
      className="theme-toggle relative grid h-9 w-9 place-items-center rounded-full"
    >
      {Animated ? <Animated theme={theme}>{icon}</Animated> : icon}
    </button>
  );
}