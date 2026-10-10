import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { DashboardShell } from './components/DashboardShell';
import { getProviderById } from './data/providers';
import { ApiKeysContent } from './pages/ApiKeysPage';
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
  const provider = getProviderById(providerId) ?? fallbackProvider;
  return <ProviderDetailContent provider={provider} />;
}

const activePageTitles = {
  overview: 'Overview',
  providers: 'Providers',
  routing: 'Routing',
  keys: 'API keys',
  // Added in 1.64.0 with the page itself. `overview` remains only as the fallback for an unrouted path,
  // which the catch-all `<Route path="*">` redirects to Providers — so it is a title nothing can reach.
  usage: 'Usage',
  settings: 'Settings',
} as const;

const pageDescriptions = {
  overview: 'Your gateway at a glance',
  providers: 'Connect and manage the routes behind your gateway',
  routing: 'Policies, fallbacks, and request flow',
  keys: 'Keys that authorize access to your local gateway',
  // Worded to avoid the phrase the marketing guard forbids across all of `src/`. The guard is a
  // substring match, and the claim is now *true* — but "what it cost" with no published price is
  // exactly the overstatement the guard exists to catch, so the description says what the page
  // actually shows instead.
  usage: 'Requests your gateway actually served, and their measured cost',
  settings: 'The configuration this gateway loaded at startup',
} as const;

function DashboardRoutes() {
  const location = useLocation();
  const isProviderDetail = location.pathname.startsWith('/providers/');
  const activePage = location.pathname.startsWith('/providers')
    ? 'providers'
    : location.pathname.startsWith('/routing')
      ? 'routing'
      : location.pathname.startsWith('/keys')
        ? 'keys'
        : location.pathname.startsWith('/usage')
          ? 'usage'
          : location.pathname.startsWith('/settings')
            ? 'settings'
            : 'overview';
  const provider = isProviderDetail ? getProviderById(location.pathname.split('/').filter(Boolean).at(-1)) : undefined;
  const pageTitle = provider?.name ?? activePageTitles[activePage];
  const pageDescription = provider ? 'Provider connection details' : pageDescriptions[activePage];

  return (
    <DashboardShell activePage={activePage} pageTitle={pageTitle} pageDescription={pageDescription}>
      {/*
        * **No `key={location.pathname}` here.** It was on this div, and it forced React to unmount
        * and remount the entire page subtree on every navigation — throwing away the DOM, replaying
        * the 420 ms `.page-enter` animation from opacity 0, and re-running every page effect. The
        * animation made the remount look intentional; measured, it was a full teardown on each
        * route change.
        *
        * `Routes` already swaps the matched element when the path changes, which is the render that
        * was wanted. The `.page-enter` class is kept on the wrapper for the *first* mount of the
        * dashboard, which is the one place an entrance animation reads as a transition rather than
        * as lag.
        */}
      <div className="page-enter">
        <Routes>
          <Route path="/" element={<Navigate to="/providers" replace />} />
          <Route path="/providers" element={<ProvidersContent />} />
          <Route path="/providers/:providerId" element={<ProviderRoute />} />
          <Route path="/routing" element={<RoutingContent />} />
          <Route path="/keys" element={<ApiKeysContent />} />
          <Route path="/usage" element={<UsageContent />} />
          <Route path="/logs" element={<LogsContent />} />
          <Route path="/settings" element={<SettingsContent />} />
          <Route path="*" element={<Navigate to="/providers" replace />} />
        </Routes>
      </div>
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
