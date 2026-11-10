import { defineConfig, type UserConfig } from 'vite';
import base from './vite.config';

/**
 * Marketing-only build.
 *
 * `vite build` emits both `index.html` and `dashboard.html`, because the dashboard is part of the same
 * Vite project. Vercel hosts only the landing page, so this config keeps the shared plugins and settings
 * and drops the dashboard entry instead of shipping an unused SPA with the marketing site.
 */
const baseConfig = base as UserConfig;

export default defineConfig({
  ...baseConfig,
  build: {
    ...baseConfig.build,
    outDir: 'dist-landing',
    emptyOutDir: true,
    rollupOptions: {
      ...baseConfig.build?.rollupOptions,
      input: {
        main: new URL('./index.html', import.meta.url).pathname,
        download: new URL('./download.html', import.meta.url).pathname,
        docs: new URL('./docs.html', import.meta.url).pathname,
        about: new URL('./about.html', import.meta.url).pathname,
        pricing: new URL('./pricing.html', import.meta.url).pathname,
        changelog: new URL('./changelog.html', import.meta.url).pathname,
        security: new URL('./security.html', import.meta.url).pathname,
        privacy: new URL('./privacy.html', import.meta.url).pathname,
      },
    },
  },
});
