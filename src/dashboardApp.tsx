import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { Suspense, useEffect, useRef, type ReactNode } from 'react';
import { DashboardShell } from './components/DashboardShell';
import { getProviderById } from './data/providers';
import { fallbackProvider } from './data/providerFallback';
import {
  AboutContent,
  ApiKeysContent,
  AppHomeContent,
  LogsContent,
  ModelsContent,
  ProviderDetailContent,
  ProvidersContent,
  RoutingContent,
  SettingsContent,
  TokenSaverContent,
  UsageContent,
} from './lib/pageChunks';

/** Public path the dashboard is served under. Android bundles it at the app root. */
const dashboardBase = import.meta.env.VITE_ANDROID === '1' ? '' : '/dashboard';

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
  models: 'Models',
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
  models: 'One oh/ id routed across saved provider accounts',
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

/**
 * What the page area shows while a route's module downloads.
 *
 * A spinner would be wrong here: the shell, the header and the nav are already painted, and the only thing missing
 * is the page body — so the honest placeholder is the body's shape. Three muted blocks reserve roughly the layout
 * the content will occupy, which keeps the header from jumping when it arrives. `aria-busy` says the region is
 * filling in rather than empty; without it a screen reader is told the page has no content.
 */
function PageSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite" className="space-y-3">
      <div className="h-6 w-40 animate-pulse rounded-md bg-surface" />
      <div className="h-24 animate-pulse rounded-xl border border-line bg-bg-soft/40" />
      <div className="h-24 animate-pulse rounded-xl border border-line bg-bg-soft/40" />
    </div>
  );
}

function DashboardRoutes() {
  const location = useLocation();
  const isProviderDetail = location.pathname.startsWith('/providers/');
  const activePage = location.pathname === '/' || location.pathname === ''
    ? 'home'
    : location.pathname.startsWith('/providers')
    ? 'providers'
    : location.pathname.startsWith('/models')
      ? 'models'
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
        {/* Every page is a separate chunk (`lib/pageChunks.ts`), so the boundary has to exist — and it sits
            inside `PageTransition`, not outside it, so the entrance animation and the skeleton share one
            wrapper and the transition is not restarted by the load. */}
        <Suspense fallback={<PageSkeleton />}>
          <Routes>
          <Route path="/" element={<AppHomeContent />} />
          <Route path="/providers" element={<ProvidersContent />} />
          <Route path="/providers/:providerId" element={<ProviderRoute />} />
          {/* The provider page's own usage tab, a real route so it can be linked to and reloaded. */}
          <Route path="/providers/:providerId/usage" element={<ProviderRoute />} />
          <Route path="/models" element={<ModelsContent />} />
          <Route path="/routing" element={<RoutingContent />} />
          <Route path="/keys" element={<ApiKeysContent />} />
          <Route path="/usage" element={<UsageContent />} />
          <Route path="/logs" element={<LogsContent />} />
          <Route path="/settings" element={<SettingsContent />} />
          <Route path="/about" element={<AboutContent />} />
          <Route path="/token-saver" element={<TokenSaverContent />} />
          <Route path="*" element={<Navigate to="/providers" replace />} />
          </Routes>
        </Suspense>
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
