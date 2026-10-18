"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

const links = [
  { href: "#product", label: "Product" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#docs", label: "Docs" },
  { href: "/dashboard", label: "Dashboard" },
];

export default function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, []);

  const closeMenu = () => setMobileOpen(false);

  return (
    <header className="nav-blur sticky top-0 z-50">
      <nav className="relative mx-auto flex h-16 max-w-6xl items-center gap-6 px-5" aria-label="Main navigation">
        <a href="#main" className="skip-link btn-gold">
          Skip to content
        </a>
        <Link href="/" className="flex shrink-0 items-center gap-2.5 text-[15px] font-semibold tracking-tight">
          <span className="text-xl leading-none text-gold" aria-hidden="true">
            ◈
          </span>
          <span>
            Omni<span className="muted font-normal">Hilbras</span>
          </span>
        </Link>

        <div className="absolute top-1/2 left-1/2 hidden -translate-x-1/2 -translate-y-1/2 items-center gap-1 whitespace-nowrap lg:flex">
          {links.map((link) =>
            link.href.startsWith("#") ? (
              <a
                key={link.href}
                href={link.href}
                className="rounded-lg px-2.5 py-1.5 text-sm text-muted transition-colors hover:text-gold-text"
              >
                {link.label}
              </a>
            ) : (
              <Link
                key={link.href}
                href={link.href}
                className="rounded-lg px-2.5 py-1.5 text-sm text-muted transition-colors hover:text-gold-text"
              >
                {link.label}
              </Link>
            )
          )}
        </div>

        <div className="ml-auto flex items-center gap-2.5">
          <Link href="/dashboard" className="btn-quiet hidden xl:inline-flex">
            Open dashboard
          </Link>
          <a href="#start" className="btn-gold hidden sm:inline-flex">
            Get started
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">arrow_outward</span>
          </a>
          <ThemeToggleLazy />
          <button
            type="button"
            aria-label={mobileOpen ? "Close navigation menu" : "Open navigation menu"}
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen((open) => !open)}
            className="muted grid h-9 w-9 place-items-center rounded-lg transition-colors hover:bg-bg-soft hover:text-gold-text lg:hidden"
          >
            <span className="material-symbols-outlined text-[22px]" aria-hidden="true">
              {mobileOpen ? "close" : "menu"}
            </span>
          </button>
        </div>
      </nav>

      {mobileOpen && (
        <div className="overflow-hidden border-t border-line bg-bg-soft lg:hidden page-enter">
          <div className="mx-auto flex max-w-6xl flex-col px-5 py-3">
            {links.map((link) =>
              link.href.startsWith("#") ? (
                <a
                  key={link.href}
                  href={link.href}
                  onClick={closeMenu}
                  className="rounded-lg px-2 py-2.5 text-sm text-muted transition-colors hover:bg-surface hover:text-gold-text"
                >
                  {link.label}
                </a>
              ) : (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={closeMenu}
                  className="rounded-lg px-2 py-2.5 text-sm text-muted transition-colors hover:bg-surface hover:text-gold-text"
                >
                  {link.label}
                </Link>
              )
            )}
            <a href="#start" onClick={closeMenu} className="btn-gold mt-3 w-full">
              Get started
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">arrow_outward</span>
            </a>
          </div>
        </div>
      )}
    </header>
  );
}

function ThemeToggleLazy() {
  const [Toggle, setToggle] = useState(null);

  useEffect(() => {
    let cancelled = false;
    import("@/shared/components/ThemeToggle").then((mod) => {
      if (!cancelled) setToggle(() => mod.default);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!Toggle) return <span className="grid h-9 w-9 place-items-center" aria-hidden="true" />;
  return <Toggle />;
}
