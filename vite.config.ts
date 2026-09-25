import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/** Routes that must reach the dashboard SPA instead of a missing file. */
const dashboardPrefix = '/dashboard';

/** Old entry files, mapped to the route that replaced them. */
const legacyRoutes: Record<string, (search: URLSearchParams) => string> = {
  '/dashboard.html': () => '/dashboard/overview',
  '/providers.html': () => '/dashboard/providers',
  '/routing.html': () => '/dashboard/routing',
  '/provider.html': (search) => {
    const provider = search.get('provider');
    return provider ? `/dashboard/providers/${encodeURIComponent(provider)}` : '/dashboard/providers';
  },
};

function dashboardFallback(): Plugin {
  return {
    name: 'omnihilbras-dashboard-fallback',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const [rawPath = '', rawSearch = ''] = (request.url ?? '').split('?');
        const legacy = legacyRoutes[rawPath];
        if (legacy) {
          response.statusCode = 302;
          response.setHeader('location', legacy(new URLSearchParams(rawSearch)));
          response.end();
          return;
        }
        if (rawPath !== dashboardPrefix && !rawPath.startsWith(`${dashboardPrefix}/`)) {
          next();
          return;
        }
        // The SPA reads the real path, so only the HTML shell is rewritten.
        request.url = '/dashboard.html';
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [dashboardFallback(), react(), tailwindcss()],
  server: {
    port: 5173,
  },
  build: {
    rollupOptions: {
      input: {
        // The marketing site and the dashboard. Every dashboard view is a route
        // inside the dashboard SPA, served under /dashboard.
        main: new URL('./index.html', import.meta.url).pathname,
        dashboard: new URL('./dashboard.html', import.meta.url).pathname,
      },
    },
  },
});
