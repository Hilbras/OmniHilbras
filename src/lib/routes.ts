/**
 * The dashboard is one React Router mounted at /dashboard. These are router
 * paths (used with `Link`/`navigate`), not full URLs.
 */
export const dashboardRoutes = {
  /**
   * There is no overview route, and there was one: a page with no data source at all, showing a
   * hardcoded request history behind a range selector that changed a hardcoded number. `/` and the
   * catch-all redirect here instead, because this page shows what the operator actually has.
   *
   * The honest way to point at work that does not exist yet is the shell's disabled "soon" entry, and
   * the shell already had three: Usage, Request log, Settings — which is exactly what the fabricated
   * pages were pretending to provide. The nav said they were missing; the pages invented them anyway.
   */
  providers: '/providers',
  routing: '/routing',
  keys: '/keys',
} as const;

export function providerRoute(providerId: string) {
  return `/providers/${encodeURIComponent(providerId)}`;
}

/** Public URL for a dashboard route, for links that leave the router. */
export function dashboardUrl(route: string = dashboardRoutes.providers) {
  return `/dashboard${route === dashboardRoutes.providers ? '' : route}`;
}
