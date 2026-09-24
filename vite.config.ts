import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
  },
  build: {
    rollupOptions: {
      input: {
        main: new URL('./index.html', import.meta.url).pathname,
        dashboard: new URL('./dashboard.html', import.meta.url).pathname,
        providers: new URL('./providers.html', import.meta.url).pathname,
        provider: new URL('./provider.html', import.meta.url).pathname,
      },
    },
  },
});
