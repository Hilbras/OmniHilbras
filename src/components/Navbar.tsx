import { useEffect, useState } from 'react';
import { ArrowUpRight, Menu, Star, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { ThemeToggle } from './ThemeToggle';

const links = [
  { href: '/home', label: 'Home' },
  { href: '/home#product', label: 'Product' },
  { href: '/docs', label: 'Docs' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/about', label: 'About' },
] as const;

export function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const path = typeof window === 'undefined' ? '/home' : window.location.pathname.replace(/\/+$/, '') || '/home';
  const isActive = (href: string) => href === path || (href === '/home' && path === '/');

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
        <a href="/home" className="flex shrink-0 items-center gap-2.5 text-[15px] font-semibold tracking-tight">
          <img src="/favicon.svg" alt="" width={28} height={28} className="h-7 w-7 shrink-0" />
          <span>
            Omni<span className="muted font-normal">Hilbras</span>
          </span>
        </a>

        <div className="absolute top-1/2 left-1/2 hidden -translate-x-1/2 -translate-y-1/2 items-center gap-1 whitespace-nowrap lg:flex">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              aria-current={isActive(link.href) ? 'page' : undefined}
              className={`rounded-lg px-2.5 py-1.5 text-sm transition-colors hover:text-gold-text ${isActive(link.href) ? 'text-gold-text' : 'text-muted'}`}
            >
              {link.label}
            </a>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2.5">
          <a
            href="https://github.com/Hilbras/OmniHilbras"
            target="_blank"
            rel="noreferrer"
            aria-label="Star OmniHilbras on GitHub"
            className="btn-ghost hidden sm:inline-flex"
          >
            <Star className="h-4 w-4" aria-hidden="true" />
            <span className="hidden md:inline">Star</span>
          </a>
          <a href="/download" className="btn-gold hidden sm:inline-flex">
            Get started
            <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
          </a>
          <ThemeToggle />
          <button
            type="button"
            aria-label={mobileOpen ? 'Close navigation menu' : 'Open navigation menu'}
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen((open) => !open)}
            className="muted grid h-9 w-9 place-items-center rounded-lg transition-colors hover:bg-bg-soft hover:text-gold-text lg:hidden"
          >
            {mobileOpen ? <X className="h-5 w-5" aria-hidden="true" /> : <Menu className="h-5 w-5" aria-hidden="true" />}
          </button>
        </div>
      </nav>

      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              key="nav-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16 }}
              onClick={closeMenu}
              aria-hidden="true"
              className="fixed inset-x-0 top-16 bottom-0 z-40 bg-black/50 lg:hidden"
            />
            <motion.div
              key="nav-menu"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className="absolute inset-x-0 top-full z-50 max-h-[calc(100dvh-4rem)] overflow-y-auto border-b border-line bg-bg shadow-2xl lg:hidden"
            >
              <div className="mx-auto flex max-w-6xl flex-col px-5 py-3">
                {links.map((link) => (
                  <a
                    key={link.href}
                    href={link.href}
                    onClick={closeMenu}
                    aria-current={isActive(link.href) ? 'page' : undefined}
                    className={`rounded-lg px-2 py-2.5 text-sm transition-colors hover:bg-surface hover:text-gold-text ${isActive(link.href) ? 'text-gold-text' : 'text-muted'}`}
                  >
                    {link.label}
                  </a>
                ))}
                <a href="/download" onClick={closeMenu} className="btn-gold mt-3 w-full">
                  Get started
                  <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                </a>
                <a href="https://github.com/Hilbras/OmniHilbras" target="_blank" rel="noreferrer" onClick={closeMenu} className="btn-ghost mt-2 w-full">
                  <Star className="h-4 w-4" aria-hidden="true" />
                  Star on GitHub
                </a>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </header>
  );
}
