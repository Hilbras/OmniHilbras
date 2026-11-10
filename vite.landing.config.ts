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
      },
    },
  },
});
