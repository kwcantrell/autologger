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
      '/.well-known': API,
      '/mcp': API,
      '/ws': { target: API, ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
