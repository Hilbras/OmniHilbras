import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { DashboardShell } from './components/DashboardShell';
import { getProviderById } from './data/providers';
import { ApiKeysContent } from './pages/ApiKeysPage';
import { DashboardOverviewContent } from './pages/DashboardOverview';
import { ProviderDetailContent, fallbackProvider } from './pages/ProviderDetailPage';
import { ProvidersContent } from './pages/ProvidersPage';
import { RoutingContent } from './pages/RoutingPage';

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
} as const;

const pageDescriptions = {
  overview: 'Your gateway at a glance',
  providers: 'Connect and manage the routes behind your gateway',
  routing: 'Policies, fallbacks, and request flow',
  keys: 'Keys that authorize access to your local gateway',
} as const;

function DashboardRoutes() {
  const location = useLocation();
  const isProviderDetail = location.pathname.startsWith('/providers/');
  const activePage = location.pathname.startsWith('/providers') ? 'providers' : location.pathname.startsWith('/routing') ? 'routing' : location.pathname.startsWith('/keys') ? 'keys' : 'overview';
  const provider = isProviderDetail ? getProviderById(location.pathname.split('/').filter(Boolean).at(-1)) : undefined;
  const pageTitle = provider?.name ?? activePageTitles[activePage];
  const pageDescription = provider ? 'Provider connection details' : pageDescriptions[activePage];

  return (
    <DashboardShell activePage={activePage} pageTitle={pageTitle} pageDescription={pageDescription}>
      <div key={location.pathname} className="page-enter">
        <Routes>
          <Route path="/" element={<Navigate to="/overview" replace />} />
          <Route path="/overview" element={<DashboardOverviewContent />} />
          <Route path="/providers" element={<ProvidersContent />} />
          <Route path="/providers/:providerId" element={<ProviderRoute />} />
          <Route path="/routing" element={<RoutingContent />} />
          <Route path="/keys" element={<ApiKeysContent />} />
          <Route path="*" element={<Navigate to="/overview" replace />} />
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
