/**
 * The dashboard is one React Router mounted at /dashboard. These are router
 * paths (used with `Link`/`navigate`), not full URLs.
 */
export const dashboardRoutes = {
  overview: '/overview',
  providers: '/providers',
  routing: '/routing',
  keys: '/keys',
} as const;

export function providerRoute(providerId: string) {
  return `/providers/${encodeURIComponent(providerId)}`;
}

/** Public URL for a dashboard route, for links that leave the router. */
export function dashboardUrl(route: string = dashboardRoutes.overview) {
  return `/dashboard${route === dashboardRoutes.overview ? '' : route}`;
}
