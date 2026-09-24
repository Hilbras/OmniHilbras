import { useState, type ReactNode } from 'react';
import {
  BarChart3,
  Boxes,
  ChevronRight,
  CircleHelp,
  Gauge,
  KeyRound,
  LayoutDashboard,
  Menu,
  Network,
  Route as RouteIcon,
  ScrollText,
  Settings2,
  X,
} from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';

type DashboardPage = 'overview' | 'providers' | 'routing';

type SidebarItem = {
  label: string;
  icon: typeof LayoutDashboard;
  href?: string;
  page?: DashboardPage;
  disabled?: boolean;
};

const primaryItems: SidebarItem[] = [
  { label: 'Overview', icon: LayoutDashboard, href: '#/overview', page: 'overview' },
  { label: 'Providers', icon: Network, href: '#/providers', page: 'providers' },
  { label: 'Routing', icon: RouteIcon, href: '#/routing', page: 'routing' },
  { label: 'API keys', icon: KeyRound, disabled: true },
];

const insightItems: SidebarItem[] = [
  { label: 'Usage', icon: BarChart3, disabled: true },
  { label: 'Request log', icon: ScrollText, disabled: true },
  { label: 'Settings', icon: Settings2, disabled: true },
];

function SidebarLink({ item, activePage, onNavigate }: { item: SidebarItem; activePage: DashboardPage; onNavigate: () => void }) {
  const Icon = item.icon;
  const isActive = item.page === activePage;
  const baseClass =
    'group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[13px] font-medium transition-colors';

  if (item.disabled) {
    return (
      <button
        type="button"
        disabled
        className={`${baseClass} cursor-not-allowed text-muted/55`}
        title="Coming in the next dashboard slice"
      >
        <Icon className="h-[17px] w-[17px] shrink-0" aria-hidden="true" />
        <span className="flex-1">{item.label}</span>
        <span className="rounded-full border border-line-strong px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide">
          Soon
        </span>
      </button>
    );
  }

  return (
    <a
      href={item.href}
      onClick={onNavigate}
      className={`${baseClass} ${isActive ? 'bg-gold-soft text-gold-text' : 'text-muted hover:bg-surface hover:text-text'}`}
      aria-current={isActive ? 'page' : undefined}
    >
      <Icon className="h-[17px] w-[17px] shrink-0" aria-hidden="true" />
      <span className="flex-1">{item.label}</span>
      {isActive && <ChevronRight className="h-3.5 w-3.5 opacity-60" aria-hidden="true" />}
    </a>
  );
}

function Sidebar({ onClose, activePage }: { onClose: () => void; activePage: DashboardPage }) {
  return (
    <aside className="dashboard-sidebar flex h-full w-[252px] shrink-0 flex-col border-r border-line bg-bg-soft/90 backdrop-blur-xl">
      <div className="flex items-center justify-between px-5 pb-4 pt-5">
        <a href="/" onClick={onClose} className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight">
          <span className="grid h-8 w-8 place-items-center rounded-[10px] border border-gold/25 bg-gold-soft text-lg text-gold-text" aria-hidden="true">
            ◈
          </span>
          <span>
            Omni<span className="muted font-normal">Hilbras</span>
          </span>
        </a>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close navigation"
          className="muted grid h-8 w-8 place-items-center rounded-lg hover:bg-surface hover:text-gold-text lg:hidden"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <div className="mx-4 mb-5 rounded-xl border border-success/20 bg-success/10 p-3">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
          </span>
          <span className="text-xs font-semibold text-success">Gateway online</span>
        </div>
        <p className="mt-1.5 pl-4 font-mono text-[10px] text-muted">localhost:8787 · local mode</p>
      </div>

      <nav className="dashboard-scroll flex-1 overflow-y-auto px-3" aria-label="Dashboard navigation">
        <p className="mono-label px-3 pb-2">Workspace</p>
        <div className="space-y-1">
          {primaryItems.map((item) => (
            <SidebarLink key={item.label} item={item} activePage={activePage} onNavigate={onClose} />
          ))}
        </div>

        <p className="mono-label px-3 pb-2 pt-7">Insights</p>
        <div className="space-y-1">
          {insightItems.map((item) => (
            <SidebarLink key={item.label} item={item} activePage={activePage} onNavigate={onClose} />
          ))}
        </div>

        <div className="mt-8 border-t border-line/70 pt-5">
          <a href="#/overview" onClick={onClose} className="group block rounded-xl border border-gold/25 bg-gold-soft/60 p-3.5 transition-colors hover:border-gold/50">
            <div className="flex items-center gap-2 text-xs font-semibold text-gold-text">
              <Boxes className="h-3.5 w-3.5" aria-hidden="true" />
              Connect a provider
            </div>
            <p className="muted mt-1.5 text-[11px] leading-relaxed">Bring your first route online in under a minute.</p>
            <span className="mt-2 inline-flex items-center gap-1 text-[10px] font-semibold text-gold-text">
              Quick setup <ChevronRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
            </span>
          </a>
        </div>
      </nav>

      <div className="border-t border-line/70 p-4">
        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-full border border-gold/30 bg-gold-soft text-[10px] font-bold text-gold-text">OH</span>
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold">Local workspace</p>
            <p className="muted truncate text-[10px]">No account required</p>
          </div>
          <CircleHelp className="ml-auto h-4 w-4 shrink-0 text-muted" aria-label="Local mode help" />
        </div>
      </div>
    </aside>
  );
}

export function DashboardShell({
  children,
  activePage = 'overview',
  pageTitle = 'Overview',
  pageDescription = 'Your gateway at a glance',
}: {
  children: ReactNode;
  activePage?: DashboardPage;
  pageTitle?: string;
  pageDescription?: string;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="dashboard-shell page-enter min-h-screen bg-bg text-text">
      {mobileOpen && (
        <button
          type="button"
          aria-label="Close dashboard navigation"
          onClick={() => setMobileOpen(false)}
          className="fixed inset-0 z-40 bg-black/45 backdrop-blur-[2px] lg:hidden"
        />
      )}

      <div className={`fixed inset-y-0 left-0 z-50 transition-transform duration-200 lg:translate-x-0 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <Sidebar onClose={() => setMobileOpen(false)} activePage={activePage} />
      </div>

      <div className="min-h-screen min-w-0 lg:pl-[252px]">
        <header className="dashboard-header sticky top-0 z-30 flex min-h-[72px] items-center justify-between gap-4 border-b border-line/80 bg-bg/80 px-4 backdrop-blur-xl sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              aria-label="Open dashboard navigation"
              className="muted grid h-9 w-9 shrink-0 place-items-center rounded-lg hover:bg-bg-soft hover:text-gold-text lg:hidden"
            >
              <Menu className="h-5 w-5" aria-hidden="true" />
            </button>
            <div className="min-w-0">
              <p className="mono-label hidden sm:block">Workspace / Local instance</p>
              <h1 className="truncate text-lg font-semibold tracking-tight sm:mt-0.5 sm:text-xl">{pageTitle}</h1>
              <p className="muted hidden truncate text-xs sm:block">{pageDescription}</p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <span className="hidden items-center gap-2 rounded-full border border-success/25 bg-success/10 px-2.5 py-1.5 text-[11px] font-medium text-success md:flex">
              <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
              All systems operational
            </span>
            <a href="#/overview" aria-label="Go to dashboard overview" className="muted hidden h-9 w-9 place-items-center rounded-lg hover:bg-bg-soft hover:text-gold-text sm:grid">
              <Gauge className="h-[17px] w-[17px]" aria-hidden="true" />
            </a>
            <ThemeToggle />
            <span className="grid h-8 w-8 place-items-center rounded-full border border-gold/30 bg-gold-soft text-[10px] font-bold text-gold-text" aria-label="Local workspace">
              OH
            </span>
          </div>
        </header>

        <main className="dashboard-grid-bg relative min-h-[calc(100vh-72px)] overflow-hidden">
          <div className="dashboard-content relative mx-auto max-w-[1440px] px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-9">{children}</div>
        </main>
      </div>
    </div>
  );
}
