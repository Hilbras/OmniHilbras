import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  BarChart3,
  Boxes,
  ChevronRight,
  CircleHelp,
  Gauge,
  Info,
  KeyRound,
  LayoutDashboard,
  Menu,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Route as RouteIcon,
  Search,
  Server,
  Settings2,
  Terminal,
  X,
} from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';
import { CommandPalette } from './CommandPalette';
import { UpdateIndicator } from './UpdateIndicator';
import { WindowControls } from './WindowControls';
import { FailureNotifications } from './FailureNotifications';
import { dashboardRoutes } from '../lib/routes';
import { prefetchRoute } from '../lib/pageChunks';
import { useGatewayStatus } from '../lib/useGatewayStatus';
import { desktopBridge } from '../lib/electronBridge';
import { PAGE_VERSION } from '../lib/pageVersion';
import { compareVersions } from '../lib/versionCompare.mjs';

/**
 * Which sidebar entry is active.
 *
 * `'overview'` is no longer a route — that page was a mockup with no data source and was deleted. It stays in
 * the union only as the fallback title for an unrouted path; no sidebar item claims it.
 *
 * `'usage'` arrived in 1.64.0 and `'settings'` in 1.65.0, each with the page and the gateway route behind
 * it. `tests/marketing-claims.test.js` pins which entries are still disabled, so this comment going stale
 * fails a test rather than misleading the next reader quietly.
 */
type DashboardPage = 'home' | 'overview' | 'providers' | 'models' | 'routing' | 'keys' | 'usage' | 'logs' | 'settings' | 'about' | 'token-saver' | 'mitm' | 'proxy-pools' | 'tunnels' | 'skills' | 'translators' | 'cli-tools';

type SidebarItem = {
  label: string;
  icon: typeof LayoutDashboard;
  to: string;
  page: DashboardPage;
  /** A route that does not exist yet renders as a disabled "soon" entry. */
  pending?: boolean;
};

// No Overview entry: that page was a mockup with no data source, and it is gone. `/` now lands on
// Providers, so the sidebar starts there rather than offering a link to nowhere.
const primaryItems: SidebarItem[] = [
  // The desktop app's main page. In a browser it says the gateway is managed by `pnpm dev:gateway`
  // rather than pretending to control a process this window does not own.
  { label: 'Servers', icon: Server, to: '/', page: 'home' },
  { label: 'Providers', icon: Network, to: dashboardRoutes.providers, page: 'providers' },
  { label: 'Models', icon: Boxes, to: dashboardRoutes.models, page: 'models' },
  { label: 'Routing', icon: RouteIcon, to: dashboardRoutes.routing, page: 'routing' },
  { label: 'API keys', icon: KeyRound, to: dashboardRoutes.keys, page: 'keys' },
];

const insightItems: SidebarItem[] = [
  // Was `pending: true` behind a link to nowhere. Real since 1.64.0, when the page and the
  // gateway's usage store both landed — the nav had been saying so honestly for longer than the
  // data existed.
  { label: 'Usage', icon: BarChart3, to: '/usage', page: 'usage' },
  { label: 'Token Saver', icon: Gauge, to: '/token-saver', page: 'token-saver' },
  { label: 'Logs', icon: BarChart3, to: '/logs', page: 'logs' },
  // Real since 1.65.0, when `GET /v1/settings` and the page landed. The last disabled entry:
  // every setting had been an environment variable, so there was nothing to show but a copy of
  // `.env.example`.
  { label: 'Settings', icon: Settings2, to: '/settings', page: 'settings' },
  { label: 'About', icon: Info, to: '/about', page: 'about' },
  // Four operator stores the gateway really serves. Each page reads its own list route; none of
  // them carries a "soon" flag because there is a measured response behind every row.
  { label: 'MITM', icon: Network, to: dashboardRoutes.mitm, page: 'mitm' },
  { label: 'Proxy pools', icon: Network, to: dashboardRoutes.proxyPools, page: 'proxy-pools' },
  { label: 'Tunnels', icon: Network, to: dashboardRoutes.tunnels, page: 'tunnels' },
  { label: 'Skills', icon: Boxes, to: dashboardRoutes.skills, page: 'skills' },
  // A real read-only capability inventory, not a configurator: the gateway serves no write route
  // behind it, so this entry cannot promise anything the page does not do.
  { label: 'Translators', icon: Boxes, to: dashboardRoutes.translators, page: 'translators' },
  // A real page that reads `GET /v1/settings` and `GET /v1/keys`; it is reachable here so the
  // route is not a URL-only orphan.
  { label: 'CLI tools', icon: Terminal, to: dashboardRoutes.cliTools, page: 'cli-tools' },
];

const sidebarStorageKey = 'omnihilbras-sidebar-collapsed';

function getInitialCollapsed() {
  try {
    return localStorage.getItem(sidebarStorageKey) === 'true';
  } catch {
    return false;
  }
}

function SidebarLink({ item, activePage, collapsed, onNavigate }: { item: SidebarItem; activePage: DashboardPage; collapsed: boolean; onNavigate: () => void }) {
  const Icon = item.icon;
  const isActive = item.page === activePage;
  const baseClass = collapsed
    ? 'group flex w-full items-center justify-center rounded-lg px-2 py-2.5 text-left transition-colors'
    : 'group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[13px] font-medium transition-colors';

  if (item.pending) {
    return (
      <button
        type="button"
        disabled
        className={`${baseClass} cursor-not-allowed text-muted/55`}
        title={collapsed ? `${item.label} · coming soon` : 'Coming in the next dashboard slice'}
        aria-label={`${item.label}, coming soon`}
      >
        <Icon className="h-[17px] w-[17px] shrink-0" aria-hidden="true" />
        {!collapsed && <span className="flex-1 text-left">{item.label}</span>}
        {!collapsed && <span className="rounded-full border border-line-strong px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide">Soon</span>}
      </button>
    );
  }

  return (
    <Link
      to={item.to}
      onClick={onNavigate}
      // The page is its own chunk, so the download can start before the click lands. Pointer first because that
      // is what a mouse does; focus covers the keyboard, where the link is reached by Tab and the download would
      // otherwise only start on Enter — after the user has already committed to waiting.
      onMouseEnter={() => prefetchRoute(item.to)}
      onFocus={() => prefetchRoute(item.to)}
      className={`${baseClass} ${isActive ? 'bg-gold-soft text-gold-text' : 'text-muted hover:bg-surface hover:text-text'}`}
      aria-current={isActive ? 'page' : undefined}
      aria-label={collapsed ? item.label : undefined}
      title={collapsed ? item.label : undefined}
    >
      <Icon className="h-[17px] w-[17px] shrink-0" aria-hidden="true" />
      {!collapsed && <span className="flex-1">{item.label}</span>}
      {!collapsed && isActive && <ChevronRight className="h-3.5 w-3.5 opacity-60" aria-hidden="true" />}
    </Link>
  );
}

function Sidebar({ onClose, onOpenSearch, activePage, collapsed, onToggleCollapse, status }: { onClose: () => void; onOpenSearch: () => void; activePage: DashboardPage; collapsed: boolean; onToggleCollapse: () => void; status: ReturnType<typeof useGatewayStatus> }) {
  /**
   * The badge is driven by a real probe, polled every few seconds.
   *
   * Polling is what makes recovery work: a page whose only request already failed makes no
   * further requests, so nothing would ever notice the gateway coming back and the offline
   * message would be the last thing the tab ever said. `/v1/connections` answers in about
   * five milliseconds, so the poll costs nothing.
   */
  const { reachable, problem, buildVersion } = status;
  const gatewayUp = reachable !== false;
  /**
   * A gateway that is answering a different build from the page asking it.
   *
   * `unknown` on either side means no drift is claimed: a gateway older than this field reports
   * nothing, and guessing "they match" from silence would be the same mistake as reporting no
   * version at all.
   */
  const staleBuild =
    typeof buildVersion === 'string' && buildVersion !== 'unknown' && buildVersion !== PAGE_VERSION;
  /**
   * Which side is behind, not merely that they differ.
   *
   * The hint read "restart the gateway" for every mismatch, which is only half the cases — and the wrong half
   * is the common one in development: `pnpm dev` reads `package.json` once when it starts, so after a version
   * bump the page keeps reporting the old number while the gateway is current. Telling someone to restart the
   * process that is already right is how they end up restarting it twice and still seeing the banner.
   * Measured today: gateway 3.56.0, page 3.54.0, gateway already current — restarting `pnpm dev` cleared it.
   */
  const pageBehind = staleBuild && compareVersions(PAGE_VERSION, buildVersion as string) < 0;
  /**
   * A refusal is not an outage, and the wording has to say which one it is.
   *
   * The gateway answers 403 when this browser's origin is not on its allowlist — it is
   * running, and declining. Reporting that as "offline" points the user at restarting a
   * server that is already correct, which is what happened four times over while a stray
   * `vite preview` on another port was the actual cause.
   */
  const gatewayLabel =
    reachable === undefined
      ? 'Checking gateway'
      : reachable
        ? 'Gateway online'
        : problem === 'refused'
          ? 'Gateway refused this page'
          : problem === 'unauthorized'
            ? 'Gateway needs sign-in'
            : 'Gateway offline';
  const gatewayHint =
    staleBuild
      ? pageBehind
        ? `this page is ${PAGE_VERSION}, the gateway is ${buildVersion} · restart \`pnpm dev\``
        : `the gateway is ${buildVersion}, this page is ${PAGE_VERSION} · restart the gateway`
      : reachable === false
        ? problem === 'refused'
          ? 'this page’s origin is not allowed'
          : problem === 'unauthorized'
            ? 'gateway is up · dashboard token not accepted, reload the dashboard'
            : desktopBridge() ? 'open Servers to start it' : 'not answering · pnpm dev:gateway'
        // The dashboard runs on a different, configurable port and is a desktop app in packaged builds; naming
        // 20138 here told people to look at a port this instance may not use. Say what is known instead.
        : `local gateway · build ${buildVersion ?? 'unknown'}`;
  return (
    <aside className={`dashboard-sidebar flex h-full w-[252px] shrink-0 flex-col border-r border-line bg-bg-soft transition-[width] duration-200 ${collapsed ? 'lg:w-[76px]' : 'lg:w-[252px]'}`}>
      <div className={`flex items-center gap-1 pb-4 pt-5 ${collapsed ? 'justify-center px-2' : 'justify-between px-5'}`}>
        <button
          type="button"
          onClick={() => { onClose(); onToggleCollapse(); }}
          className={`group flex items-center gap-2.5 rounded-lg p-1 text-[15px] font-semibold tracking-tight ${collapsed ? 'justify-center' : 'flex-1 justify-between'}`}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <span className="relative grid h-8 w-8 shrink-0 place-items-center rounded-[10px] border border-gold/25 bg-gold-soft text-lg text-gold-text" aria-hidden="true">
            <img src="/favicon.svg" alt="" className="h-5 w-5" />
            {collapsed && <PanelLeftOpen className="absolute h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100" />}
          </span>
          {!collapsed && <span>Omni<span className="muted font-normal">Hilbras</span></span>}
          {!collapsed && <PanelLeftClose className="ml-auto h-4 w-4 shrink-0 text-muted" aria-hidden="true" />}
        </button>
        <button type="button" onClick={onClose} aria-label="Close navigation" className="muted grid h-8 w-8 place-items-center rounded-lg hover:bg-surface hover:text-gold-text lg:hidden">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {/*
        The badge asks the gateway rather than asserting it. It used to be the literal string
        "Gateway online", which meant the dashboard reported the one thing that was false for
        exactly as long as the outage lasted — and looked fine afterwards, so nobody trusted
        it before this either.
      */}
      <div
        className={`mx-4 mb-5 rounded-xl border ${gatewayUp ? 'border-success/20 bg-success/10' : 'border-danger/30 bg-danger/10'} ${collapsed ? 'flex justify-center p-2.5' : 'p-3'}`}
        title={collapsed ? gatewayLabel : undefined}
        aria-label={gatewayLabel}
      >
        <div className={`flex items-center ${collapsed ? 'justify-center' : 'gap-2'}`}>
          <span className="relative flex h-2 w-2">
            {gatewayUp && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />}
            <span className={`relative inline-flex h-2 w-2 rounded-full ${gatewayUp ? 'bg-success' : 'bg-danger'}`} />
          </span>
          {!collapsed && <span className={`text-xs font-semibold ${gatewayUp ? 'text-success' : 'text-danger'}`}>{gatewayLabel}</span>}
        </div>
        {!collapsed && (
          <p className="mt-1.5 pl-4 font-mono text-[10px] text-muted" title={gatewayHint}>
            {gatewayHint}
          </p>
        )}
      </div>

      {/* Update, directly under the gateway badge: both are statements about this installation. */}
      <UpdateIndicator collapsed={collapsed} />

      <button
        type="button"
        onClick={onOpenSearch}
        aria-label="Search dashboard"
        title={collapsed ? 'Search dashboard (Cmd/Ctrl+K)' : undefined}
        className={`mx-3 mb-2 flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-[12px] text-muted hover:border-gold/30 hover:bg-surface hover:text-text ${collapsed ? 'justify-center px-2' : ''}`}
      >
        <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
        {!collapsed && <><span className="flex-1 text-left">Search</span><kbd className="rounded border border-line-strong px-1 py-0.5 font-mono text-[9px]">⌘K</kbd></>}
      </button>

      <nav className={`dashboard-scroll flex-1 overflow-y-auto ${collapsed ? 'px-2' : 'px-3'}`} aria-label="Dashboard navigation">
        {!collapsed && <p className="mono-label px-3 pb-2">Workspace</p>}
        {collapsed && <div className="h-5" aria-hidden="true" />}
        <div className="space-y-1">
          {primaryItems.map((item) => <SidebarLink key={item.label} item={item} activePage={activePage} collapsed={collapsed} onNavigate={onClose} />)}
        </div>

        {!collapsed && <p className="mono-label px-3 pb-2 pt-7">Insights</p>}
        {collapsed && <div className="h-6" aria-hidden="true" />}
        <div className="space-y-1">
          {insightItems.map((item) => <SidebarLink key={item.label} item={item} activePage={activePage} collapsed={collapsed} onNavigate={onClose} />)}
        </div>

        <div className={`mt-8 border-t border-line/70 pt-5 ${collapsed ? 'px-1' : ''}`}>
          <Link to={dashboardRoutes.providers} onClick={onClose} className={`group block rounded-xl border border-gold/25 bg-gold-soft/60 transition-colors hover:border-gold/50 ${collapsed ? 'flex justify-center p-3' : 'p-3.5'}`} title={collapsed ? 'Connect a provider' : undefined} aria-label={collapsed ? 'Connect a provider' : undefined}>
            <div className={`items-center gap-2 text-xs font-semibold text-gold-text ${collapsed ? 'flex justify-center' : 'flex'}`}>
              <Boxes className="h-3.5 w-3.5" aria-hidden="true" />
              {!collapsed && 'Connect a provider'}
            </div>
            {!collapsed && <p className="muted mt-1.5 text-[11px] leading-relaxed">Bring your first route online in under a minute.</p>}
            {!collapsed && <span className="mt-2 inline-flex items-center gap-1 text-[10px] font-semibold text-gold-text">Quick setup <ChevronRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" aria-hidden="true" /></span>}
          </Link>
        </div>
      </nav>

      <div className={`border-t border-line/70 ${collapsed ? 'p-3' : 'p-4'}`}>
        <div className={`flex items-center ${collapsed ? 'justify-center' : 'gap-2.5'}`} title={collapsed ? 'Local workspace · no account required' : undefined}>
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-gold/30 bg-gold-soft text-[10px] font-bold text-gold-text">OH</span>
          {!collapsed && <div className="min-w-0"><p className="truncate text-xs font-semibold">Local workspace</p><p className="muted truncate text-[10px]">No account required</p></div>}
          {!collapsed && <CircleHelp className="ml-auto h-4 w-4 shrink-0 text-muted" aria-label="Local mode help" />}
        </div>
      </div>
    </aside>
  );
}

export function DashboardShell({
  children,
  activePage = 'providers',
  pageTitle = 'Overview',
  pageDescription = 'Your gateway at a glance',
}: {
  children: ReactNode;
  activePage?: DashboardPage;
  pageTitle?: string;
  pageDescription?: string;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(getInitialCollapsed);
  const mobileNavRef = useRef<HTMLDivElement>(null);
  const mobileOpenerRef = useRef<HTMLButtonElement>(null);

  /*
    The same hook the sidebar badge uses, so the header badge and the sidebar cannot disagree — they were
    two independent renderings of the same fact, one of which was a hardcoded string. It is called here
    rather than threaded down as a prop because a shared hook is one source of truth; passing `reachable`
    from Sidebar up to DashboardShell would be a second place the value could be read.

    This is inside the component body on purpose. My first attempt appended it after the closing brace,
    which typechecked — `gatewayUp` was in scope file-wide — and rendered a blank page, because a hook
    called at module scope has no React dispatcher. `tsc` cannot see that; the browser can.
  */
  const gatewayStatus = useGatewayStatus();
  const { reachable } = gatewayStatus;
  const gatewayUp = reachable !== false;


  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(sidebarStorageKey, String(collapsed));
    } catch {
      // The preference still applies for this session when storage is unavailable.
    }
  }, [collapsed]);

  // The mobile drawer is a modal surface. Without this it remained in the tab order behind the
  // overlay and Escape did nothing, so keyboard users could not leave it predictably.
  useEffect(() => {
    if (!mobileOpen) return;
    const panel = mobileNavRef.current;
    const opener = mobileOpenerRef.current;
    const focusable = () => [...(panel?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])];
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMobileOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      opener?.focus();
    };
  }, [mobileOpen]);

  return (
    <div className="dashboard-shell min-h-screen bg-bg text-text">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2 focus:text-xs focus:text-text">Skip to content</a>
      {/* App-wide announcement of failed requests; renders nothing itself. */}
      <FailureNotifications />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        items={[...primaryItems, ...insightItems].map((item) => ({ label: item.label, to: item.to, hint: item.page }))}
      />
      {mobileOpen && <button type="button" aria-label="Close dashboard navigation" onClick={() => setMobileOpen(false)} className="fixed inset-0 z-40 bg-black/45 backdrop-blur-[2px] lg:hidden" />}

      <div id="dashboard-mobile-nav" ref={mobileNavRef} className={`fixed inset-y-0 left-0 z-50 transition-transform duration-200 lg:translate-x-0 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`} aria-hidden={!mobileOpen && undefined}>
        <Sidebar onClose={() => setMobileOpen(false)} onOpenSearch={() => setPaletteOpen(true)} activePage={activePage} collapsed={collapsed} onToggleCollapse={() => setCollapsed((value) => !value)} status={gatewayStatus} />
      </div>

      {/*
        * The sticky header is **opaque on purpose**, and it is a performance decision rather than a
        * style one.
        *
        * It was `bg-bg/80 backdrop-blur-xl`, with the sidebar carrying the same filter beside it. A
        * backdrop filter behind a `position: sticky` element has to re-sample and re-blur everything
        * scrolling underneath it *every frame*, and this header spans the full content width. Both
        * halves matter: the filter is only paid for when something shows through the background.
        * Measured on `/dashboard/usage` by swapping this file for the one in `HEAD`, scrolling, and
        * swapping back — two interleaved rounds, median of 5 reps: **37 and 39 fps before, 61 and 62
        * after**. Nothing about a dashboard needs to show the page through its chrome, so the blur
        * bought a scroll that visibly stutters.
        *
        * `tests/ui-performance.test.js` fails if a `backdrop-blur` comes back on a `sticky` element,
        * whether it is written as a Tailwind utility here or as a class defined in `src/index.css`.
        */}
      <div className={`min-h-screen min-w-0 transition-[padding] duration-200 ${collapsed ? 'lg:pl-[76px]' : 'lg:pl-[252px]'}`}>
        <header className="dashboard-header window-drag sticky top-0 z-30 flex min-h-[72px] items-center justify-between gap-4 border-b border-line/80 bg-bg px-4 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <button ref={mobileOpenerRef} type="button" onClick={() => setMobileOpen(true)} aria-label="Open dashboard navigation" aria-expanded={mobileOpen} aria-controls="dashboard-mobile-nav" className="window-no-drag muted grid h-9 w-9 shrink-0 place-items-center rounded-lg hover:bg-bg-soft hover:text-gold-text lg:hidden"><Menu className="h-5 w-5" aria-hidden="true" /></button>
            <div className="min-w-0"><p className="mono-label hidden sm:block">Workspace / Local instance</p><h1 className="truncate text-lg font-semibold tracking-tight sm:mt-0.5 sm:text-xl">{pageTitle}</h1><p className="muted hidden truncate text-xs sm:block">{pageDescription}</p></div>
          </div>

          <div className="window-no-drag flex shrink-0 items-center gap-2 sm:gap-3">
            {/*
              This used to read "All systems operational", unconditionally, in the header of every page.
              The sidebar badge 120 lines below this one was carefully built to ask the gateway rather
              than assert it — its own comment records that a hardcoded "Gateway online" reported the one
              thing that was false for exactly as long as the outage lasted. This badge was the fabricated
              twin: green, always, saying something the component had already measured and was ignoring.

              It now reports the same `gatewayUp` the sidebar uses. "All systems operational" was also a
              claim about *more* than the gateway — a check that every configured provider answers — and
              nothing here polls that, so the wording claims only what is known.
            */}
            <span
              className={`hidden items-center gap-2 rounded-full border px-2.5 py-1.5 text-[11px] font-medium md:flex ${gatewayUp ? 'border-success/25 bg-success/10 text-success' : 'border-danger/30 bg-danger/10 text-danger'}`}
              aria-label={gatewayUp ? 'Gateway reachable' : 'Gateway unreachable'}
            ><span className={`h-1.5 w-1.5 rounded-full ${gatewayUp ? 'bg-success' : 'bg-danger'}`} aria-hidden="true" />{gatewayUp ? 'Gateway reachable' : 'Gateway unreachable'}</span>
            <Link to={dashboardRoutes.providers} aria-label="Go to providers" className="muted hidden h-9 w-9 place-items-center rounded-lg hover:bg-bg-soft hover:text-gold-text sm:grid"><Gauge className="h-[17px] w-[17px]" aria-hidden="true" /></Link>
            <ThemeToggle />
            <span className="grid h-8 w-8 place-items-center rounded-full border border-gold/30 bg-gold-soft text-[10px] font-bold text-gold-text" aria-label="Local workspace">OH</span>
            <WindowControls />
          </div>
        </header>

        <main id="main" tabIndex={-1} className="dashboard-grid-bg relative min-h-[calc(100vh-72px)] overflow-hidden"><div className="dashboard-content relative mx-auto max-w-[1440px] px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-9">{children}</div></main>
      </div>
    </div>
  );
}

