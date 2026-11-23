// Public landing page for signed-out visitors at `/` (RootGate lazy-loads it). Static: no RPC,
// no session state; only /api/capabilities (already loaded by RootGate) for the docs base URL. The document is viewport-locked on desktop (tailwind.css), so the page is its
// own scroll container and the header sticks inside it.

import { ArrowRight, ChevronDown, ExternalLink, Menu } from 'lucide-react';
import {
  type ComponentType,
  createContext,
  type LazyExoticComponent,
  lazy,
  type ReactNode,
  type RefObject,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link } from 'wouter';
import { useCapabilities } from '@/api/queries';
import { Button } from '@/shared/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLinkItem,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/shared/components/ui/sheet';
import { cn } from '@/shared/lib/utils';
import { WorkspaceMock } from './heroMock';
import {
  ASK_PLUGIN_HREF,
  type LandingLinks,
  landingLinks,
  type NavLink,
  PRODUCT_LINKS,
  SIGN_IN_HREF,
} from './links';
import type * as Mocks from './mocks';
import type * as WikiMocks from './wikiMocks';

const WRAP = 'mx-auto w-full max-w-[72rem] px-4 sm:px-6 lg:px-8';
const EYEBROW =
  'm-0 font-label text-[0.75rem] font-semibold uppercase leading-none tracking-[0.14em] text-[color-mix(in_oklab,var(--si-accent)_72%,#ffffff)]';
const H2 = 'm-0 text-[1.75rem] font-semibold leading-[1.15] tracking-[-0.01em] sm:text-[2.25rem]';
const LEAD = 'm-0 text-[1rem] leading-[1.6] text-si-muted sm:text-[1.0625rem]';
const FOCUS =
  'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:rounded-ctl';

// Doc links follow the server's DOCS_URL (capabilities.docsUrl); upstream docs until it loads.
const LinksContext = createContext<LandingLinks>(landingLinks());
const useLinks = () => useContext(LinksContext);

// ── lazily loaded mocks ─────────────────────────────────────────────
// The feature and import/export mocks load when their slot comes within half a screen of the
// page's scroll viewport, so the first paint fetches only the hero. The wiki and Ask mocks are a
// module of their own (wikiMocks.tsx) because they pull in react-markdown. Until a mock arrives an
// empty card of its measured height (phone, sm, lg) holds its place, so the rows around it do not
// move. Changed a mock's size? Update its height here.

type MockName = keyof typeof Mocks | keyof typeof WikiMocks;
const loadMock = (name: MockName): Promise<ComponentType> =>
  name === 'WikiMock' || name === 'CompileMock'
    ? import('./wikiMocks').then((m) => m[name])
    : import('./mocks').then((m) => m[name]);
const lazyMocks = new Map<MockName, LazyExoticComponent<ComponentType>>();

function lazyMock(name: MockName) {
  let Mock = lazyMocks.get(name);
  if (!Mock) {
    Mock = lazy(() => loadMock(name).then((c) => ({ default: c })));
    lazyMocks.set(name, Mock);
  }
  return Mock;
}

function useNearViewport(ref: RefObject<HTMLElement | null>) {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (near || !el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    // The page is its own scroll container (#top below), so observe within it: with the
    // viewport as root, the container's clipping would cancel the margin.
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { root: el.closest('#top'), rootMargin: '50% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near, ref]);
  return near;
}

function LazyMock({ name, height }: { name: MockName; height: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const near = useNearViewport(ref);
  const placeholder = (
    <div
      aria-hidden="true"
      className={cn('w-full rounded-card border border-si-line bg-si-panel', height)}
    />
  );
  const Mock = lazyMock(name);
  return (
    <div ref={ref} className="min-w-0">
      {near ? (
        <Suspense fallback={placeholder}>
          <Mock />
        </Suspense>
      ) : (
        placeholder
      )}
    </div>
  );
}

function useMenuGroups() {
  const { navGroups } = useLinks();
  return [{ id: 'product', label: 'Product', links: PRODUCT_LINKS }, ...navGroups];
}

function isExternal(href: string) {
  return href.startsWith('http');
}

function ext(href: string) {
  return isExternal(href) ? { target: '_blank', rel: 'noreferrer' } : {};
}

function Logo() {
  return (
    <a
      href="#top"
      className={cn('flex shrink-0 items-center gap-2 text-si-fg no-underline', FOCUS)}
    >
      <img
        src="/static/logo-autologger-transparent.png"
        alt=""
        width={28}
        height={28}
        className="size-7"
      />
      <span className="font-league-gothic text-[1.6rem] uppercase leading-none tracking-[0.02em]">
        AutoLogger
      </span>
    </a>
  );
}

function SignInButton({ className, size }: { className?: string; size?: 'default' | 'lg' }) {
  return (
    <Button
      nativeButton={false}
      size={size}
      className={className}
      render={<Link href={SIGN_IN_HREF} />}
    >
      Sign in
    </Button>
  );
}

function DesktopNav() {
  const menuGroups = useMenuGroups();
  return (
    <nav aria-label="Main" className="flex items-center gap-1 max-md:hidden">
      {menuGroups.map((g) => (
        <DropdownMenu key={g.id}>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                className="gap-1 px-3 text-si-muted data-popup-open:text-si-fg hover:text-si-fg"
              />
            }
          >
            {g.label}
            <ChevronDown aria-hidden="true" className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[17rem]">
            {g.links.map((l) => (
              <DropdownMenuLinkItem
                key={l.href + l.label}
                href={l.href}
                {...ext(l.href)}
                className="flex-col items-start gap-0.5 py-2"
              >
                <span className="flex items-center gap-1.5 text-[0.84rem] font-semibold tracking-normal">
                  {l.label}
                  {isExternal(l.href) && (
                    <ExternalLink aria-hidden="true" className="size-3 text-si-dim" />
                  )}
                </span>
                <span className="text-[0.75rem] tracking-normal text-si-dim">{l.hint}</span>
              </DropdownMenuLinkItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ))}
    </nav>
  );
}

function MobileNav() {
  const [open, setOpen] = useState(false);
  const menuGroups = useMenuGroups();
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="size-11 md:hidden"
            aria-label="Open menu"
          />
        }
      >
        <Menu aria-hidden="true" />
      </SheetTrigger>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-sm">
        <SheetHeader className="pr-12">
          <SheetTitle>AutoLogger</SheetTitle>
          <SheetDescription>Product tour, docs and developer links.</SheetDescription>
        </SheetHeader>
        <nav aria-label="Main" className="flex flex-col gap-5 px-4 pb-6">
          {menuGroups.map((g) => (
            <section key={g.id} aria-labelledby={`m-nav-${g.id}`}>
              <h2
                id={`m-nav-${g.id}`}
                className="m-0 mb-1.5 font-label text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-si-dim"
              >
                {g.label}
              </h2>
              <ul className="m-0 flex list-none flex-col p-0">
                {g.links.map((l) => (
                  <li key={l.href + l.label}>
                    <a
                      href={l.href}
                      {...ext(l.href)}
                      onClick={() => setOpen(false)}
                      className={cn(
                        'flex min-h-11 items-center gap-1.5 rounded-ctl px-2 text-[0.9375rem] text-si-fg no-underline hover:bg-[rgba(255,255,255,0.06)]',
                        FOCUS,
                      )}
                    >
                      {l.label}
                      {isExternal(l.href) && (
                        <ExternalLink aria-hidden="true" className="size-3.5 text-si-dim" />
                      )}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <SignInButton className="h-11 w-full" />
        </nav>
      </SheetContent>
    </Sheet>
  );
}

function Header() {
  const { mcpDocsHref } = useLinks();
  return (
    <header className="sticky top-0 z-30 border-b border-[color-mix(in_oklab,var(--si-accent)_22%,var(--si-line))] bg-[color-mix(in_oklab,var(--si-accent)_10%,#0c0d10)]">
      <div className={cn(WRAP, 'flex h-14 items-center gap-4 lg:gap-8')}>
        <Logo />
        <DesktopNav />
        <div className="ml-auto flex items-center gap-2">
          <Button
            nativeButton={false}
            variant="ghost"
            className="text-si-muted hover:text-si-fg max-lg:hidden"
            render={<a href={mcpDocsHref} {...ext(mcpDocsHref)} />}
          >
            Connect an agent
          </Button>
          <SignInButton className="max-md:hidden" />
          <MobileNav />
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section aria-labelledby="hero-title" className="border-b border-si-line">
      <div
        className={cn(
          WRAP,
          'grid items-center gap-10 py-14 sm:py-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-14 lg:py-24',
        )}
      >
        <div className="flex flex-col gap-6">
          <p className={EYEBROW}>Logging for podcasts, shoots and streams</p>
          <h1
            id="hero-title"
            className="m-0 text-[2.5rem] font-semibold leading-[1.05] tracking-[-0.02em] sm:text-[3.25rem] lg:text-[3.75rem]"
          >
            Mark the moment while the show is still rolling.
          </h1>
          <p className={cn(LEAD, 'max-w-[34rem]')}>
            AutoLogger is a logging workspace for live productions. Press a key or a Stream Deck
            button and the moment lands on the session's timecode. The audio becomes a
            speaker-labelled transcript, and your AI agents turn it into chapters, dashboards and a
            show wiki you can undo at any time.
          </p>
          <div className="flex flex-wrap gap-3">
            <SignInButton size="lg" className="h-11 px-6 max-sm:flex-1" />
            <Button
              nativeButton={false}
              variant="outline"
              size="lg"
              className="h-11 px-5 max-sm:flex-1"
              render={<a href="#how" />}
            >
              See how it works
            </Button>
          </div>
        </div>
        <div className="min-w-0 animate-overlay-fade-in motion-reduce:animate-none">
          <WorkspaceMock />
        </div>
      </div>
    </section>
  );
}

const STEPS = [
  {
    title: 'Log it live',
    body: 'Operators tag laughs, intros, ad reads and problems with hotkeys 1–9 or Companion buttons.',
  },
  {
    title: 'Get the transcript',
    body: 'Recorded or imported audio is transcribed with speaker labels on the same clock.',
  },
  {
    title: 'Let agents annotate',
    body: 'Claude or any MCP client adds topics, events, dashboards and recaps, as you, undoably.',
  },
  {
    title: 'Hand it to editors',
    body: 'Briefs, dashboards, the wiki and CSV or SRT exports go straight into the edit.',
  },
];

function HowItWorks() {
  return (
    <section
      id="how"
      aria-labelledby="how-title"
      className="scroll-mt-14 border-b border-si-line bg-si-panel"
    >
      <div className={cn(WRAP, 'py-14 sm:py-16')}>
        <p className={EYEBROW}>How it works</p>
        <h2 id="how-title" className={cn(H2, 'mt-3 max-w-[40rem]')}>
          From the first roll to the editor's notes.
        </h2>
        <ol className="m-0 mt-10 grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <li
              key={s.title}
              className="flex flex-col gap-3 rounded-card border border-si-line bg-si-bg p-5"
            >
              <span className="flex size-8 items-center justify-center rounded-ctl border border-(--si-primary-line) bg-(--si-primary-tint) font-tc text-[0.8rem] font-semibold">
                {i + 1}
              </span>
              <h3 className="m-0 text-[1.0625rem] font-semibold">{s.title}</h3>
              <p className="m-0 text-[0.9rem] leading-[1.55] text-si-muted">{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

type Feature = {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  points: string[];
  mock: ReactNode;
  link?: NavLink;
};

const features = (links: LandingLinks): Feature[] => [
  {
    id: 'logging',
    eyebrow: 'Live logging',
    title: 'Every press lands on timecode.',
    body: 'Each show gets its own event buttons. While the session rolls, number keys 1–9 log them on the session clock, so nobody types a timecode by hand.',
    points: [
      'Buttons, on/off toggles, pick-lists and free-text notes',
      'Roll, stop and takes on a shared transport every client follows',
      'Bitfocus Companion turns a Stream Deck into a logging surface',
    ],
    mock: <LazyMock name="LoggingMock" height="h-[337px] sm:h-[499px] lg:h-[407px]" />,
    link: { label: 'Companion setup', href: links.companionDocsHref, hint: '' },
  },
  {
    id: 'transcripts',
    eyebrow: 'Transcripts',
    title: 'Who said what, and exactly when.',
    body: 'Record in the browser or upload a file, and the worker transcribes it with speaker labels. Each line is timecoded to the same clock as your log, so a click on a line jumps the player.',
    points: [
      'Rename speakers once for the whole session',
      'Key terms steer the spelling of guest names and jargon',
      'Fix, merge and split lines by hand, or have an agent clean up',
    ],
    mock: <LazyMock name="TranscriptMock" height="h-[394px] sm:h-[295px] lg:h-[346px]" />,
  },
  {
    id: 'topics',
    eyebrow: 'Topics',
    title: 'Chapters without the scrubbing.',
    body: 'Topics break a session into named chapters with start times and lengths. Write them yourself, or ask an agent to chapter the transcript and review what it wrote.',
    points: [
      'Chapter start times line up with events and transcript lines',
      'Ready to paste into show notes, or export as CSV',
    ],
    mock: <LazyMock name="TopicsMock" height="h-[536px] sm:h-[387px] lg:h-[423px]" />,
  },
  {
    id: 'dashboards',
    eyebrow: 'Dashboards',
    title: 'Session stats from a spec, not a script.',
    body: 'A dashboard is a declarative JSON spec: stat tiles, bar, line and pie charts, tables, timelines and Markdown. Agents can build one from a sentence, and nothing in a spec ever runs as code.',
    points: [
      'Event counts, talk time per speaker, topic timelines, custom stats',
      'Preview the data behind each widget before you save it',
    ],
    mock: <LazyMock name="DashboardMock" height="h-[607px] sm:h-[615px] lg:h-[615px]" />,
  },
  {
    id: 'wiki',
    eyebrow: 'Show wiki',
    title: "Your show's memory, linked together.",
    body: 'Every show keeps a Markdown wiki of people, recurring bits, session recaps and answered questions. Pages link with [[double brackets]] and cite the exact range of a session they come from, so the wiki doubles as a knowledge base you can check.',
    points: [
      'Citations open the session and play just that range',
      'Each session lists the wiki pages that cite it',
      'Revision history for every page, and lint for broken links and citations',
    ],
    mock: <LazyMock name="WikiMock" height="h-[438px] sm:h-[375px] lg:h-[422px]" />,
  },
  {
    id: 'compilations',
    eyebrow: 'Ask & compile',
    title: 'Ask the archive. Watch the answer.',
    body: 'Ask a question about a show and an agent answers with the ranges in each episode where it comes up, saved to the wiki as a cited question page. When the episodes came from YouTube, AutoLogger cuts those ranges into one video you can play or download.',
    points: [
      'Answers are kept as question pages, so the knowledge base grows with every question',
      'Built on the server: only the cited sections are downloaded, joined into a 720p MP4',
      'The Compilations page plays, downloads and deletes them',
    ],
    mock: <LazyMock name="CompileMock" height="h-[504px] sm:h-[418px] lg:h-[441px]" />,
    link: { label: 'The autologger-ask plugin', href: ASK_PLUGIN_HREF, hint: '' },
  },
  {
    id: 'agents',
    eyebrow: 'Agents over MCP',
    title: 'Bring your own AI. Keep the undo button.',
    body: 'AutoLogger never calls a model itself. Claude Code, claude.ai or any MCP client connects as you, with your access. Its changes apply right away, and each one carries the name of the client that made it.',
    points: [
      'The Agents tab lists every change by client and tool',
      'Undo a single change, or every change from one call at once',
      'Ready-made skills for topics, moments, dashboards, wiki, briefs and questions',
    ],
    mock: <LazyMock name="AgentsMock" height="h-[447px] sm:h-[455px] lg:h-[455px]" />,
    link: { label: 'Connect an agent', href: links.mcpDocsHref, hint: '' },
  },
];

function FeatureRow({ f, flip }: { f: Feature; flip: boolean }) {
  return (
    <section id={f.id} aria-labelledby={`${f.id}-title`} className="scroll-mt-14">
      <div className={cn(WRAP, 'grid items-center gap-8 py-14 sm:py-20 lg:grid-cols-2 lg:gap-16')}>
        <div className={cn('flex flex-col gap-5', flip && 'lg:order-2')}>
          <p className={EYEBROW}>{f.eyebrow}</p>
          <h2 id={`${f.id}-title`} className={H2}>
            {f.title}
          </h2>
          <p className={LEAD}>{f.body}</p>
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
            {f.points.map((p) => (
              <li key={p} className="flex gap-3 text-[0.9375rem] leading-[1.5]">
                <span
                  aria-hidden="true"
                  className="mt-[0.55rem] h-0.5 w-3 shrink-0 rounded-full bg-si-accent"
                />
                {p}
              </li>
            ))}
          </ul>
          {f.link && <TextLink link={f.link} />}
        </div>
        <div className="min-w-0">{f.mock}</div>
      </div>
    </section>
  );
}

function TextLink({ link }: { link: NavLink }) {
  return (
    <a
      href={link.href}
      {...ext(link.href)}
      className={cn(
        'inline-flex w-fit items-center gap-1.5 text-[0.9375rem] font-semibold text-[color-mix(in_oklab,var(--si-accent)_72%,#ffffff)] no-underline hover:underline',
        FOCUS,
      )}
    >
      {link.label}
      <ArrowRight aria-hidden="true" className="size-4" />
    </a>
  );
}

function MediaSection() {
  return (
    <section
      id="import"
      aria-labelledby="import-title"
      className="scroll-mt-14 border-t border-si-line"
    >
      <div className={cn(WRAP, 'py-14 sm:py-20')}>
        <p className={EYEBROW}>Import & export</p>
        <h2 id="import-title" className={cn(H2, 'mt-3 max-w-[40rem]')}>
          Back catalogue in, edit-ready files out.
        </h2>
        <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-2">
          <article className="flex flex-col gap-5 rounded-card border border-si-line bg-si-bg p-5 sm:p-6">
            <div className="flex flex-col gap-2">
              <h3 className="m-0 text-[1.25rem] font-semibold">YouTube and playlist import</h3>
              <p className="m-0 text-[0.9375rem] leading-[1.55] text-si-muted">
                Paste a video or a whole playlist. AutoLogger creates one session per video,
                downloads the audio and transcribes it, so last season is as searchable as tonight's
                show.
              </p>
            </div>
            <LazyMock name="ImportMock" height="h-[351px] sm:h-[339px]" />
          </article>
          <article
            id="exports"
            className="flex scroll-mt-14 flex-col gap-5 rounded-card border border-si-line bg-si-bg p-5 sm:p-6"
          >
            <div className="flex flex-col gap-2">
              <h3 className="m-0 text-[1.25rem] font-semibold">Exports</h3>
              <p className="m-0 text-[0.9375rem] leading-[1.55] text-si-muted">
                Take the log to the edit bay as CSV or JSON Lines, the transcript as text or SRT
                subtitles, and the chapters as a topics CSV.
              </p>
            </div>
            <LazyMock name="ExportMock" height="h-[379px] sm:h-[371px]" />
          </article>
        </div>
      </div>
    </section>
  );
}

function Developers() {
  const { navGroups } = useLinks();
  const cards = [
    {
      title: 'MCP server',
      body: 'Every capability is one op in a registry, and every op an agent may use becomes an MCP tool. OAuth or personal access tokens.',
      link: navGroups[2].links[0],
      cta: 'Read the MCP guide',
    },
    {
      title: 'Plugin marketplace',
      body: 'Install the autologger plugin for Claude Code: skills to chapter, log moments, build dashboards, keep the wiki and write briefs — and autologger-ask to answer questions with cited clips and compilations.',
      link: navGroups[1].links[0],
      cta: 'Browse the plugins',
    },
    {
      title: 'Companion module',
      body: 'Roll, stop and log from a Stream Deck, with timecode, take and the last event shown on the keys.',
      link: navGroups[1].links[1],
      cta: 'Get the module',
    },
    {
      title: 'Open source',
      body: 'TypeScript end to end: Hono, Postgres, React. The contributor plugins walk you from first checkout to pull request.',
      link: navGroups[2].links[2],
      cta: 'View on GitHub',
    },
  ];
  return (
    <section
      id="developers"
      aria-labelledby="dev-title"
      className="scroll-mt-14 border-t border-si-line bg-si-panel"
    >
      <div className={cn(WRAP, 'py-14 sm:py-20')}>
        <p className={EYEBROW}>For developers</p>
        <h2 id="dev-title" className={cn(H2, 'mt-3 max-w-[40rem]')}>
          Built to be driven by agents and hardware.
        </h2>
        <ul className="m-0 mt-10 grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-4">
          {cards.map((c) => (
            <li
              key={c.title}
              className="flex flex-col gap-3 rounded-card border border-si-line bg-si-bg p-5"
            >
              <h3 className="m-0 text-[1.0625rem] font-semibold">{c.title}</h3>
              <p className="m-0 flex-1 text-[0.9rem] leading-[1.55] text-si-muted">{c.body}</p>
              <TextLink
                link={{
                  ...c.link,
                  label: c.cta,
                }}
              />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function CtaBand() {
  const { mcpDocsHref } = useLinks();
  return (
    <section aria-labelledby="cta-title" className="border-t border-si-line">
      <div className={cn(WRAP, 'py-16 sm:py-20')}>
        <div className="flex flex-col items-center gap-5 rounded-card border border-(--si-primary-line) bg-[color-mix(in_oklab,var(--si-accent)_10%,var(--si-panel))] px-6 py-12 text-center sm:px-10">
          <h2 id="cta-title" className={cn(H2, 'max-w-[36rem]')}>
            Ready for the next take?
          </h2>
          <p className={cn(LEAD, 'max-w-[34rem]')}>
            Sign in to open your shows. New accounts are approved by the administrator of this
            AutoLogger server, or straight away when you were invited to a team.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <SignInButton size="lg" className="h-11 px-6" />
            <Button
              nativeButton={false}
              variant="outline"
              size="lg"
              className="h-11 px-5"
              render={<a href={mcpDocsHref} {...ext(mcpDocsHref)} />}
            >
              Read the docs
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  const menuGroups = useMenuGroups();
  return (
    <footer className="border-t border-si-line bg-[color-mix(in_oklab,var(--si-accent)_10%,#0c0d10)]">
      <div
        className={cn(
          WRAP,
          'grid grid-cols-2 gap-x-6 gap-y-10 py-12 lg:grid-cols-[1.4fr_repeat(4,minmax(0,1fr))]',
        )}
      >
        <div className="col-span-2 flex flex-col gap-3 lg:col-span-1">
          <Logo />
          <p className="m-0 max-w-[18rem] text-[0.875rem] leading-[1.55] text-si-muted">
            Session logging for production teams, with AI that works through MCP.
          </p>
        </div>
        {menuGroups.map((g) => (
          <nav key={g.id} aria-labelledby={`f-nav-${g.id}`}>
            <h2
              id={`f-nav-${g.id}`}
              className="m-0 mb-3 font-label text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-si-dim"
            >
              {g.label}
            </h2>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {g.links.map((l) => (
                <li key={l.href + l.label}>
                  <a
                    href={l.href}
                    {...ext(l.href)}
                    className={cn(
                      'text-[0.875rem] text-si-muted no-underline hover:text-si-fg hover:underline',
                      FOCUS,
                    )}
                  >
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div
        className={cn(
          WRAP,
          'flex flex-wrap items-center justify-between gap-3 border-t border-si-line py-5',
        )}
      >
        <p className="m-0 text-[0.8125rem] text-si-dim">AutoLogger is open source.</p>
        <Link
          href={SIGN_IN_HREF}
          className={cn('text-[0.8125rem] text-si-muted no-underline hover:text-si-fg', FOCUS)}
        >
          Sign in
        </Link>
      </div>
    </footer>
  );
}

export function LandingPage() {
  const docsUrl = useCapabilities().data?.docsUrl;
  const links = useMemo(() => landingLinks(docsUrl), [docsUrl]);
  return (
    <LinksContext value={links}>
      <div
        id="top"
        className="h-dvh w-full overflow-x-hidden overflow-y-auto scroll-smooth bg-si-bg text-si-fg motion-reduce:scroll-auto"
      >
        <a
          href="#main"
          className="sr-only z-50 rounded-ctl bg-si-panel-2 px-3 py-2 text-si-fg focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
        >
          Skip to content
        </a>
        <Header />
        <main id="main" tabIndex={-1} className="outline-none">
          <Hero />
          <HowItWorks />
          <div id="features">
            {features(links).map((f, i) => (
              <div key={f.id} className={cn(i > 0 && 'border-t border-si-line')}>
                <FeatureRow f={f} flip={i % 2 === 1} />
              </div>
            ))}
          </div>
          <MediaSection />
          <Developers />
          <CtaBand />
        </main>
        <Footer />
      </div>
    </LinksContext>
  );
}
