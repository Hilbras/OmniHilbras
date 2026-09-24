import { useEffect, useState } from 'react';
import { ArrowUpRight, Menu, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { ThemeToggle } from './ThemeToggle';

const links = [
  { href: '#product', label: 'Product' },
  { href: '#how-it-works', label: 'How it works' },
  { href: '#docs', label: 'Docs' },
] as const;

export function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, []);

  const closeMenu = () => setMobileOpen(false);

  return (
    <header className="nav-blur sticky top-0 z-50 border-b border-line/70">
      <nav className="relative mx-auto flex h-16 max-w-6xl items-center gap-6 px-5" aria-label="Main navigation">
        <a href="#main" className="skip-link btn-gold">
          Skip to content
        </a>
        <a href="#main" className="flex shrink-0 items-center gap-2.5 text-[15px] font-semibold tracking-tight">
          <span className="text-xl leading-none text-gold" aria-hidden="true">
            ◈
          </span>
          <span>
            Omni<span className="muted font-normal">Hilbras</span>
          </span>
        </a>

        <div className="absolute top-1/2 left-1/2 hidden -translate-x-1/2 -translate-y-1/2 items-center gap-1 whitespace-nowrap md:flex">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="rounded-lg px-2.5 py-1.5 text-sm text-muted transition-colors hover:text-gold-text"
            >
              {link.label}
            </a>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2.5">
          <a href="#docs" className="btn-quiet hidden sm:inline-flex">
            Read the docs
          </a>
          <a href="#start" className="btn-gold hidden sm:inline-flex">
            Get started
            <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
          </a>
          <ThemeToggle />
          <button
            type="button"
            aria-label={mobileOpen ? 'Close navigation menu' : 'Open navigation menu'}
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen((open) => !open)}
            className="muted grid h-9 w-9 place-items-center rounded-lg transition-colors hover:bg-bg-soft hover:text-gold-text md:hidden"
          >
            {mobileOpen ? <X className="h-5 w-5" aria-hidden="true" /> : <Menu className="h-5 w-5" aria-hidden="true" />}
          </button>
        </div>
      </nav>

      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="overflow-hidden border-t border-line bg-bg-soft/95 md:hidden"
          >
            <div className="mx-auto flex max-w-6xl flex-col px-5 py-3">
              {links.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  onClick={closeMenu}
                  className="rounded-lg px-2 py-2.5 text-sm text-muted transition-colors hover:bg-surface hover:text-gold-text"
                >
                  {link.label}
                </a>
              ))}
              <a href="#start" onClick={closeMenu} className="btn-gold mt-3 w-full">
                Get started
                <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              </a>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
