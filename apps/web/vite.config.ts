import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API = process.env.API_URL ?? 'http://localhost:18081';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    proxy: {
      '/api': API,
      '/auth': API,
      '/oauth/register': API,
      '/oauth/authorize': API,
      '/oauth/token': API,
      '/oauth/revoke': API,
      '/.well-known': API,
      '/mcp': API,
      '/ws': { target: API, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // React changes far less often than the app: its own chunk stays cached across deploys.
        // Only packages every screen loads belong here, or lazy routes' code would load up front.
        manualChunks(id) {
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react';
        },
      },
    },
  },
});
