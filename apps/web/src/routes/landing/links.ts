// Outbound links shared by the landing page's header menus, developer cards and footer.

const REPO = 'https://github.com/kwcantrell/autologger';
const BLOB = `${REPO}/blob/main`;
/** Upstream docs folder; a server's DOCS_URL (capabilities.docsUrl) replaces it. */
const UPSTREAM_DOCS = `${BLOB}/docs`;
const MARKETPLACE = 'https://github.com/kwcantrell/autologger-marketplace';

export type NavLink = { label: string; href: string; hint: string };
export type NavGroup = { id: string; label: string; links: NavLink[] };

/** In-page sections, in page order (the Product menu and footer column). */
export const PRODUCT_LINKS: NavLink[] = [
  { label: 'Live logging', href: '#logging', hint: 'Hotkeys, transport and Stream Deck' },
  { label: 'Transcripts', href: '#transcripts', hint: 'Speaker-labelled, timecoded' },
  { label: 'Topics', href: '#topics', hint: 'Chapters for every session' },
  { label: 'Dashboards', href: '#dashboards', hint: 'Declarative session stats' },
  { label: 'Show wiki', href: '#wiki', hint: 'A cited knowledge base' },
  { label: 'Ask & compile', href: '#compilations', hint: 'Answers as video compilations' },
  { label: 'Agents over MCP', href: '#agents', hint: 'Every change undoable' },
  { label: 'Import & export', href: '#import', hint: 'YouTube in, CSV and SRT out' },
];

export type LandingLinks = {
  navGroups: NavGroup[];
  mcpDocsHref: string;
  companionDocsHref: string;
};

/**
 * Links to files in docs/ (the Docs menu, the MCP server card, "Connect an agent", "Read the docs",
 * "Companion setup") resolve against `docsUrl`, the server's DOCS_URL, when set: it replaces the
 * upstream `blob/main/docs` folder and the file names stay the same (`<docsUrl>/mcp.md`). Links
 * to the upstream repos (Resources, Contributing, GitHub) never change.
 */
export function landingLinks(docsUrl?: string | null): LandingLinks {
  const docs = (file: string) => `${docsUrl ?? UPSTREAM_DOCS}/${file}`;
  const mcpDocsHref = docs('mcp.md');
  const companionDocsHref = docs('companion.md');
  const navGroups: NavGroup[] = [
    {
      id: 'docs',
      label: 'Docs',
      links: [
        {
          label: 'Connecting agents (MCP)',
          href: mcpDocsHref,
          hint: 'Claude Code, claude.ai, tokens',
        },
        {
          label: 'Media & transcription',
          href: docs('media.md'),
          hint: 'Storage, worker, YouTube',
        },
        { label: 'Bitfocus Companion', href: companionDocsHref, hint: 'Stream Deck setup' },
      ],
    },
    {
      id: 'resources',
      label: 'Resources',
      links: [
        { label: 'Plugin marketplace', href: MARKETPLACE, hint: 'Ready-made skills for Claude' },
        {
          label: 'Companion module',
          href: `${REPO}/tree/main/apps/companion`,
          hint: 'Hardware control',
        },
        { label: 'Architecture', href: `${BLOB}/ARCHITECTURE.md`, hint: 'How it fits together' },
      ],
    },
    {
      id: 'developers',
      label: 'Developers',
      links: [
        {
          label: 'MCP server',
          href: mcpDocsHref,
          hint: 'Tools generated from the ops registry',
        },
        {
          label: 'Contributing',
          href: `${MARKETPLACE}/tree/main/plugins/autologger-contribute`,
          hint: 'The autologger-contribute plugin',
        },
        { label: 'GitHub', href: REPO, hint: 'Source, issues and pull requests' },
      ],
    },
  ];
  return { navGroups, mcpDocsHref, companionDocsHref };
}

export const SIGN_IN_HREF = `/login?return=${encodeURIComponent('/')}`;
export const ASK_PLUGIN_HREF = `${MARKETPLACE}/tree/main/plugins/autologger-ask`;
