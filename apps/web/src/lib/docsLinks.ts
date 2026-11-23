// Links to the documentation. The app serves it at /docs (routes/docs, built from the repo's
// docs/ folder); a server's DOCS_URL (capabilities.docsUrl) replaces that base, so a page
// '<section>/<slug>' links to `<DOCS_URL>/<section>/<slug>` and the home page to DOCS_URL itself.

import { useCapabilities } from '@/api/queries';

/** Pages other screens link to, as '<section>/<slug>' under /docs. */
export const DOC_PAGES = {
  home: '',
  gettingStarted: 'guide/getting-started',
  companion: 'guide/companion',
  connectingAgents: 'agents/connecting-agents',
  plugins: 'agents/plugins',
  mcpServer: 'developers/mcp-server',
  selfHosting: 'developers/self-hosting',
  importHelper: 'developers/import-helper',
  companionProtocol: 'developers/companion-protocol',
  architecture: 'developers/architecture',
  contributing: 'developers/contributing',
} as const;

export function docsHref(page: string, docsUrl?: string | null): string {
  const base = docsUrl ?? '/docs';
  return page ? `${base}/${page}` : base;
}

/** docsHref against this server's DOCS_URL (the built-in /docs until capabilities load). */
export function useDocsHref() {
  const docsUrl = useCapabilities().data?.docsUrl;
  return (page: string) => docsHref(page, docsUrl);
}
