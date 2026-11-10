import { defineConfig, type UserConfig } from 'vite';
import base from './vite.config';

/**
 * Dashboard-only build for the Android shell.
 *
 * Capacitor serves `webDir` at the app root, so this build has no marketing page and the dashboard
 * router uses an empty basename. `scripts/finalize-android.mjs` renames the HTML entry to index.html.
 */
const baseConfig = base as UserConfig;

export default defineConfig({
  ...baseConfig,
  define: {
    ...(baseConfig.define ?? {}),
    'import.meta.env.VITE_ANDROID': JSON.stringify('1'),
  },
  build: {
    ...baseConfig.build,
    outDir: 'dist-android',
    emptyOutDir: true,
    rollupOptions: {
      ...baseConfig.build?.rollupOptions,
      input: { index: new URL('./dashboard.html', import.meta.url).pathname },
    },
  },
});
