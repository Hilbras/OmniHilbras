const footerGroups = [
  {
    title: 'Explore',
    links: [
      ['#product', 'Product'],
      ['#how-it-works', 'How it works'],
      ['#docs', 'Documentation'],
    ],
  },
  {
    title: 'Build',
    links: [
      ['#start', 'Get started'],
      ['#docs', 'API reference'],
      ['#observability', 'Observability'],
    ],
  },
] as const;

export function Footer() {
  return (
    <footer className="relative border-t border-line">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-12 sm:grid-cols-2 lg:grid-cols-4">
        <div className="max-w-xs">
          <a href="#main" className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight">
            <span className="text-xl leading-none text-gold" aria-hidden="true">
              ◈
            </span>
            <span>
              Omni<span className="muted font-normal">Hilbras</span>
            </span>
          </a>
          <p className="muted mt-3 text-[13px] leading-relaxed">
            One intelligent route between your applications and every model provider.
          </p>
          <a href="#start" className="btn-gold mt-5 !px-3.5 !py-2 !text-[13px]">
            Start building
          </a>
        </div>

        {footerGroups.map((group) => (
          <div key={group.title}>
            <h2 className="mono-label">{group.title}</h2>
            <ul className="mt-4 space-y-2.5 text-sm">
              {group.links.map(([href, label]) => (
                <li key={href}>
                  <a href={href} className="footer-link">
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}

        <div>
          <h2 className="mono-label">Built for</h2>
          <p className="muted mt-4 max-w-[190px] text-sm leading-relaxed">
            Developers who want choice without operational chaos.
          </p>
          <div className="mt-4 flex items-center gap-2 text-gold-text">
            <span className="h-1.5 w-1.5 rounded-full bg-gold" aria-hidden="true" />
            <span className="font-mono text-[11px]">Local-first · BYOK</span>
          </div>
        </div>
      </div>

      <div className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-5 py-5 text-xs sm:flex-row">
          <span className="muted">© 2026 OmniHilbras</span>
          <span className="muted font-mono">One route. Every model.</span>
        </div>
      </div>
    </footer>
  );
}
