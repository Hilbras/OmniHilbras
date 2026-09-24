import { HashRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { DashboardShell } from './components/DashboardShell';
import { getProviderById } from './data/providers';
import { DashboardOverviewContent } from './pages/DashboardOverview';
import { ProviderDetailContent, fallbackProvider } from './pages/ProviderDetailPage';
import { ProvidersContent } from './pages/ProvidersPage';
import { RoutingContent } from './pages/RoutingPage';

function initialRoute() {
  const { pathname, search } = window.location;
  if (pathname.endsWith('/providers.html')) return '/providers';
  if (pathname.endsWith('/provider.html')) {
    const providerId = new URLSearchParams(search).get('provider') || 'custom';
    return `/providers/${encodeURIComponent(providerId)}`;
  }
  if (pathname.endsWith('/routing.html')) return '/routing';
  return '/overview';
}

function ensureInitialHashRoute() {
  if (window.location.hash.startsWith('#/')) return;
  const route = initialRoute();
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${route}`);
}

function ProviderRoute() {
  const { providerId } = useParams();
  const provider = getProviderById(providerId) ?? fallbackProvider;
  return <ProviderDetailContent provider={provider} />;
}

function DashboardRoutes() {
  const location = useLocation();
  const isProviderDetail = location.pathname.startsWith('/providers/');
  const activePage = location.pathname.startsWith('/providers') ? 'providers' : location.pathname.startsWith('/routing') ? 'routing' : 'overview';
  const provider = isProviderDetail ? getProviderById(location.pathname.split('/').filter(Boolean).at(-1)) : undefined;
  const pageTitle = provider?.name ?? (activePage === 'providers' ? 'Providers' : activePage === 'routing' ? 'Routing' : 'Overview');
  const pageDescription = provider ? 'Provider connection details' : activePage === 'providers' ? 'Connect and manage the routes behind your gateway' : activePage === 'routing' ? 'Policies, fallbacks, and request flow' : 'Your gateway at a glance';

  return (
    <DashboardShell activePage={activePage} pageTitle={pageTitle} pageDescription={pageDescription}>
      <div key={location.pathname} className="page-enter">
        <Routes>
          <Route path="/" element={<Navigate to="/overview" replace />} />
          <Route path="/overview" element={<DashboardOverviewContent />} />
          <Route path="/providers" element={<ProvidersContent />} />
          <Route path="/providers/:providerId" element={<ProviderRoute />} />
          <Route path="/routing" element={<RoutingContent />} />
          <Route path="*" element={<Navigate to="/overview" replace />} />
        </Routes>
      </div>
    </DashboardShell>
  );
}

export default function DashboardApp() {
  ensureInitialHashRoute();
  return <HashRouter><DashboardRoutes /></HashRouter>;
}
