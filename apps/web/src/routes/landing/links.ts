// Links shared by the landing page's header menus, developer cards and footer, and by the docs
// pages' header and footer (the same chrome).

import { DOC_PAGES, docsHref } from '@/lib/docsLinks';

export const REPO_URL = 'https://github.com/kwcantrell/autologger';
const REPO = REPO_URL;
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
  /** The docs home ("Read the docs"). */
  docsHomeHref: string;
  /** "Connect an agent". */
  connectAgentHref: string;
  /** "Companion setup". */
  companionDocsHref: string;
  /** The developer cards. */
  mcpServer: NavLink;
  marketplace: NavLink;
  companionModule: NavLink;
  github: NavLink;
};

/**
 * Documentation links go to the built-in docs at /docs (same origin), or to
 * `<docsUrl>/<section>/<slug>` when the server sets DOCS_URL. The plugin marketplace, the Companion
 * module's source and the repository itself live on GitHub and never change.
 */
export function landingLinks(docsUrl?: string | null): LandingLinks {
  const docs = (page: string) => docsHref(page, docsUrl);
  const docsHomeHref = docs(DOC_PAGES.home);
  const connectAgentHref = docs(DOC_PAGES.connectingAgents);
  const companionDocsHref = docs(DOC_PAGES.companion);
  const mcpServer: NavLink = {
    label: 'MCP server',
    href: docs(DOC_PAGES.mcpServer),
    hint: 'Tools generated from the ops registry',
  };
  const marketplace: NavLink = {
    label: 'Plugin marketplace',
    href: MARKETPLACE,
    hint: 'Ready-made skills for Claude',
  };
  const companionModule: NavLink = {
    label: 'Companion module',
    href: `${REPO}/tree/main/apps/companion`,
    hint: 'Source of the hardware module',
  };
  const github: NavLink = { label: 'GitHub', href: REPO, hint: 'Source, issues and pull requests' };
  const navGroups: NavGroup[] = [
    {
      id: 'docs',
      label: 'Docs',
      links: [
        { label: 'Documentation', href: docsHomeHref, hint: 'Guides, agents and developers' },
        {
          label: 'Getting started',
          href: docs(DOC_PAGES.gettingStarted),
          hint: 'Your first show and session',
        },
        {
          label: 'Connecting agents',
          href: connectAgentHref,
          hint: 'Claude Code, claude.ai, tokens',
        },
        { label: 'Bitfocus Companion', href: companionDocsHref, hint: 'Stream Deck setup' },
      ],
    },
    {
      id: 'resources',
      label: 'Resources',
      links: [
        marketplace,
        { label: 'Agent plugins', href: docs(DOC_PAGES.plugins), hint: 'What each skill does' },
        companionModule,
        { label: 'Architecture', href: docs(DOC_PAGES.architecture), hint: 'How it fits together' },
      ],
    },
    {
      id: 'developers',
      label: 'Developers',
      links: [
        mcpServer,
        {
          label: 'Self-hosting',
          href: docs(DOC_PAGES.selfHosting),
          hint: 'Deploy, storage, worker, YouTube',
        },
        {
          label: 'Contributing',
          href: docs(DOC_PAGES.contributing),
          hint: 'Dev stack, tests, pull requests',
        },
        github,
      ],
    },
  ];
  return {
    navGroups,
    docsHomeHref,
    connectAgentHref,
    companionDocsHref,
    mcpServer,
    marketplace,
    companionModule,
    github,
  };
}

export const SIGN_IN_HREF = `/login?return=${encodeURIComponent('/')}`;
export const ASK_PLUGIN_HREF = `${MARKETPLACE}/tree/main/plugins/autologger-ask`;
