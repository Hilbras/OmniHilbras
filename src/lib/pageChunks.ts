import { lazy } from 'react';

/**
 * Every dashboard page, loaded on demand instead of on every page.
 *
 * `dashboardApp.tsx` imported all eleven pages eagerly, so one `dashboardApp` chunk was **406 KB raw / 106 KB
 * gzip** and `src/pages` alone was 289 KB of it. Opening `/providers` downloaded the settings page, the token
 * saver, and everything they import — including the zod schemas and chart helpers that only two pages use.
 *
 * A `lazy()` per route splits that at the module boundary Vite already understands, with no configuration and no
 * second copy of the page map. `prefetch()` is the other half: the download starts when the pointer or the
 * keyboard focus lands on a nav entry, so the click usually finds the module in the cache and the skeleton is
 * never seen. Prefetching every page on idle was the alternative and it is worse — it re-fetches the whole 289 KB
 * for a user who visits one page.
 *
 * The named exports are why each `lazy()` carries a `.then`: the pages export `XContent`, not a default, and a
 * default-export shim in each page file would be a second spelling of one thing.
 */

export const AppHomeContent = lazy(() => import('../pages/AppHomePage').then((module) => ({ default: module.AppHomeContent })));
export const ProvidersContent = lazy(() => import('../pages/ProvidersPage').then((module) => ({ default: module.ProvidersContent })));
export const ProviderDetailContent = lazy(() => import('../pages/ProviderDetailPage').then((module) => ({ default: module.ProviderDetailContent })));
export const ModelsContent = lazy(() => import('../pages/ModelsPage').then((module) => ({ default: module.ModelsContent })));
export const RoutingContent = lazy(() => import('../pages/RoutingPage').then((module) => ({ default: module.RoutingContent })));
export const ApiKeysContent = lazy(() => import('../pages/ApiKeysPage').then((module) => ({ default: module.ApiKeysContent })));
export const UsageContent = lazy(() => import('../pages/UsagePage').then((module) => ({ default: module.UsageContent })));
export const LogsContent = lazy(() => import('../pages/LogsPage').then((module) => ({ default: module.LogsContent })));
export const SettingsContent = lazy(() => import('../pages/SettingsPage').then((module) => ({ default: module.SettingsContent })));
export const AboutContent = lazy(() => import('../pages/AboutPage').then((module) => ({ default: module.AboutContent })));
export const TokenSaverContent = lazy(() => import('../pages/TokenSaverPage').then((module) => ({ default: module.TokenSaverContent })));
export const PromptsContent = lazy(() => import('../pages/PromptsPage').then((module) => ({ default: module.PromptsContent })));
export const MitmContent = lazy(() => import('../pages/MitmPage').then((module) => ({ default: module.MitmContent })));
export const ProxyPoolsContent = lazy(() => import('../pages/ProxyPoolsPage').then((module) => ({ default: module.ProxyPoolsContent })));
export const TunnelsContent = lazy(() => import('../pages/TunnelsPage').then((module) => ({ default: module.TunnelsContent })));
export const SkillsContent = lazy(() => import('../pages/SkillsPage').then((module) => ({ default: module.SkillsContent })));
export const TranslatorContent = lazy(() => import('../pages/TranslatorPage').then((module) => ({ default: module.TranslatorContent })));
export const CliToolsContent = lazy(() => import('../pages/CliToolsPage').then((module) => ({ default: module.CliToolsContent })));

/**
 * The module behind each nav path, for the preload.
 *
 * Keyed by the route path the shell links to, not by page name, because that is what the link knows when the
 * pointer lands on it. A path that is listed in `dashboardApp.tsx` and missing here costs one skeleton flash, not
 * a broken page — which is why this is a hint and not the loader the route depends on.
 */
const prefetchable: Record<string, () => Promise<unknown>> = {
  '/': () => import('../pages/AppHomePage'),
  '/providers': () => import('../pages/ProvidersPage'),
  '/models': () => import('../pages/ModelsPage'),
  '/routing': () => import('../pages/RoutingPage'),
  '/keys': () => import('../pages/ApiKeysPage'),
  '/usage': () => import('../pages/UsagePage'),
  '/logs': () => import('../pages/LogsPage'),
  '/settings': () => import('../pages/SettingsPage'),
  '/about': () => import('../pages/AboutPage'),
  '/token-saver': () => import('../pages/TokenSaverPage'),
  '/prompts': () => import('../pages/PromptsPage'),
  '/mitm': () => import('../pages/MitmPage'),
  '/proxy-pools': () => import('../pages/ProxyPoolsPage'),
  '/tunnels': () => import('../pages/TunnelsPage'),
  '/skills': () => import('../pages/SkillsPage'),
  '/translators': () => import('../pages/TranslatorPage'),
  '/cli-tools': () => import('../pages/CliToolsPage'),
};

/**
 * Starts the download for a path, and forgets it if it fails.
 *
 * A prefetch that throws would otherwise surface as an unhandled rejection from a *hover* — the one event a user
 * will not connect to an error. The route's own `lazy()` retries from scratch, so a failure here is only a hint
 * that did not land.
 */
export function prefetchRoute(path: string): void {
  const loader = prefetchable[path];
  if (!loader) return;
  loader().catch(() => undefined);
}
