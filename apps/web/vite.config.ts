import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { docMetaFromFile, sortDocs } from './src/routes/docs/docsIndex';

const API = process.env.API_URL ?? 'http://localhost:18081';
const DOCS_DIR = fileURLToPath(new URL('../../docs', import.meta.url));

/**
 * `virtual:docs`: the published pages of the repo's docs/ folder (files with front matter, see
 * src/routes/docs/docsIndex.ts) in reading order, and one lazy `?raw` loader per page, so each
 * page is its own small chunk and only the metadata ships with the docs route. Bad front matter
 * fails the build. In dev, adding, removing or editing a docs file reloads the page.
 */
function docsPlugin(): Plugin {
  const ID = 'virtual:docs';
  const RESOLVED = `\0${ID}`;
  const files = () =>
    (readdirSync(DOCS_DIR, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.split(sep).join('/'))
      .sort();
  return {
    name: 'autologger-docs',
    resolveId: (id) => (id === ID ? RESOLVED : undefined),
    load(id) {
      if (id !== RESOLVED) return;
      const pages = sortDocs(
        files().flatMap((f) => {
          const meta = docMetaFromFile(f, readFileSync(join(DOCS_DIR, f), 'utf8'));
          return meta ? [meta] : [];
        }),
      );
      const loaders = pages.map(
        (p) =>
          `${JSON.stringify(p.path)}: () => import(${JSON.stringify(`${join(DOCS_DIR, p.file.slice('docs/'.length))}?raw`)})`,
      );
      return `export const pages = ${JSON.stringify(pages)};\nexport const loaders = {\n${loaders.join(',\n')}\n};\n`;
    },
    configureServer(server) {
      server.watcher.add(DOCS_DIR);
      server.watcher.on('all', (_event, file) => {
        if (!file.endsWith('.md') || relative(DOCS_DIR, file).startsWith('..')) return;
        const mod = server.moduleGraph.getModuleById(RESOLVED);
        if (mod) server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: 'full-reload' });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), docsPlugin()],
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
