import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

type Theme = 'light' | 'dark';

function getTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
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

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(getTheme);
  const reduceMotion = useReducedMotion();
  const animationTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('omnihilbras-theme', theme);
    } catch {
      // The theme still applies for this session when storage is unavailable.
    }
  }, [theme]);

  useEffect(() => () => window.clearTimeout(animationTimer.current), []);

  const nextTheme = theme === 'dark' ? 'light' : 'dark';
  const icon = theme === 'light' ? <MoonSparkle /> : <SunSparkle />;

  function toggleTheme() {
    if (!reduceMotion) {
      document.documentElement.classList.add('theme-anim');
      window.clearTimeout(animationTimer.current);
      animationTimer.current = window.setTimeout(() => {
        document.documentElement.classList.remove('theme-anim');
      }, 450);
    }
    setTheme(nextTheme);
  }

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={`Switch to ${nextTheme} theme`}
      title={`Switch to ${nextTheme} theme`}
      className="theme-toggle relative grid h-9 w-9 place-items-center rounded-full"
    >
      {reduceMotion ? (
        icon
      ) : (
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={theme}
            className="grid place-items-center"
            initial={{ opacity: 0, scale: 0.4, rotate: -120 }}
            animate={{ opacity: 1, scale: 1, rotate: 0, transition: { duration: 0.3, ease: [0.34, 1.56, 0.64, 1] } }}
            exit={{ opacity: 0, scale: 0.4, rotate: 120, transition: { duration: 0.15, ease: 'easeIn' } }}
          >
            {icon}
          </motion.span>
        </AnimatePresence>
      )}
    </button>
  );
}
