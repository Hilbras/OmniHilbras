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
  /**
   * Added in 1.64.0, with the page and with the gateway's usage store.
   *
   * This route was listed in the README as if it existed for several releases, and `tests/documentation-counts.test.js`
   * caught it when the page actually landed — which is the guard doing exactly its job: a documented route
   * that 404s reads as a bug in the app, and a reader cannot tell it from one that was never built.
   *
   * The nav entry existed the whole time as a disabled "soon" item, so the shell was honest and the README
   * was not.
   */
  usage: '/usage',
} as const;

export function providerRoute(providerId: string) {
  return `/providers/${encodeURIComponent(providerId)}`;
}

/** Public URL for a dashboard route, for links that leave the router. */
export function dashboardUrl(route: string = dashboardRoutes.providers) {
  return `/dashboard${route === dashboardRoutes.providers ? '' : route}`;
}
