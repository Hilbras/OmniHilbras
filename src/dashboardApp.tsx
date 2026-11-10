import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { useEffect, useRef, type ReactNode } from 'react';
import { DashboardShell } from './components/DashboardShell';
import { getProviderById } from './data/providers';
import { ApiKeysContent } from './pages/ApiKeysPage';
import { AboutContent } from './pages/AboutPage';
import { TokenSaverContent } from './pages/TokenSaverPage';
import { AppHomeContent } from './pages/AppHomePage';
import { ProviderDetailContent, fallbackProvider } from './pages/ProviderDetailPage';
import { ProvidersContent } from './pages/ProvidersPage';
import { RoutingContent } from './pages/RoutingPage';
import { UsageContent } from './pages/UsagePage';
import { LogsContent } from './pages/LogsPage';
import { SettingsContent } from './pages/SettingsPage';

/** Public path the dashboard is served under. Every route hangs off it. */
const dashboardBase = '/dashboard';

function ProviderRoute() {
  const { providerId } = useParams();
  const location = useLocation();
  const provider = getProviderById(providerId) ?? fallbackProvider;
  // One component serves both paths, so the header and tab strip cannot drift between the two tabs. The tab is
  // read from the pathname rather than passed in, so a reload lands on the same tab.
  const tab = location.pathname.endsWith('/usage') ? 'usage' : 'overview';
  return <ProviderDetailContent key={provider.id} provider={provider} tab={tab} />;
}

const activePageTitles = {
  home: 'Servers',
  overview: 'Overview',
  providers: 'Providers',
  routing: 'Routing',
  keys: 'API keys',
  // Added in 1.64.0 with the page itself. `overview` remains only as the fallback for an unrouted path,
  // which the catch-all `<Route path="*">` redirects to Providers — so it is a title nothing can reach.
  usage: 'Usage',
  logs: 'Request log',
  settings: 'Settings',
  about: 'About',
  'token-saver': 'Token Saver',
} as const;

const pageDescriptions = {
  home: 'Gateway lifecycle and live logs',
  overview: 'Your gateway at a glance',
  providers: 'Connect and manage the routes behind your gateway',
  routing: 'Per-connection eligibility, health, and last attempt',
  keys: 'Keys that authorize access to your local gateway',
  // Worded to avoid the phrase the marketing guard forbids across all of `src/`. The guard is a
  // substring match, and the claim is now *true* — but "what it cost" with no published price is
  // exactly the overstatement the guard exists to catch, so the description says what the page
  // actually shows instead.
  usage: 'Requests your gateway actually served, and their measured cost',
  logs: 'Requests as the gateway records them, newest first',
  settings: 'The configuration this gateway loaded at startup',
  about: 'Version, platform, backup and recovery',
  'token-saver': 'Measured savings from context compression',
} as const;

function PageTransition({ children }: { children: ReactNode }) {
  const location = useLocation();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // Replay the entrance animation without remounting the page. The old `key={pathname}` did replay
    // it, and it also tore down every page on each navigation; removing the key fixed the teardown but
    // left the animation on the first mount only. Restarting the animation class is the narrow fix.
    node.classList.remove('page-enter');
    void node.offsetWidth;
    node.classList.add('page-enter');
  }, [location.pathname]);

  return <div ref={ref} className="page-enter">{children}</div>;
}

function DashboardRoutes() {
  const location = useLocation();
  const isProviderDetail = location.pathname.startsWith('/providers/');
  const activePage = location.pathname === '/' || location.pathname === ''
    ? 'home'
    : location.pathname.startsWith('/providers')
    ? 'providers'
    : location.pathname.startsWith('/routing')
      ? 'routing'
      : location.pathname.startsWith('/keys')
        ? 'keys'
        : location.pathname.startsWith('/usage')
          ? 'usage'
          : location.pathname.startsWith('/logs')
            ? 'logs'
            : location.pathname.startsWith('/settings')
            ? 'settings'
            : location.pathname.startsWith('/about')
              ? 'about'
              : location.pathname.startsWith('/token-saver')
                ? 'token-saver'
                : 'overview';
  const provider = isProviderDetail ? getProviderById(location.pathname.split('/').filter(Boolean).at(-1)) : undefined;
  const pageTitle = provider?.name ?? activePageTitles[activePage];
  const pageDescription = provider ? 'Provider connection details' : pageDescriptions[activePage];

  return (
    <DashboardShell activePage={activePage} pageTitle={pageTitle} pageDescription={pageDescription}>
      {/*
        * **No pathname `key` on the wrapper.** It used to force a full unmount/remount on
        * every navigation — DOM torn down, page effects re-run. `PageTransition` instead restarts the
        * `.page-enter` animation on the same wrapper when the path changes, so the transition plays and
        * the page keeps its state.
        */}
      <PageTransition>
        <Routes>
          <Route path="/" element={<AppHomeContent />} />
          <Route path="/providers" element={<ProvidersContent />} />
          <Route path="/providers/:providerId" element={<ProviderRoute />} />
          {/* The provider page's own usage tab, a real route so it can be linked to and reloaded. */}
          <Route path="/providers/:providerId/usage" element={<ProviderRoute />} />
          <Route path="/routing" element={<RoutingContent />} />
          <Route path="/keys" element={<ApiKeysContent />} />
          <Route path="/usage" element={<UsageContent />} />
          <Route path="/logs" element={<LogsContent />} />
          <Route path="/settings" element={<SettingsContent />} />
          <Route path="/about" element={<AboutContent />} />
          <Route path="/token-saver" element={<TokenSaverContent />} />
          <Route path="*" element={<Navigate to="/providers" replace />} />
        </Routes>
      </PageTransition>
    </DashboardShell>
  );
}

export default function DashboardApp() {
  // The SPA is mounted at /dashboard, so the router is baselined there and
  // every route is a real path: /dashboard/providers/openrouter.
  return (
    <BrowserRouter basename={dashboardBase}>
      <DashboardRoutes />
    </BrowserRouter>
  );
}
