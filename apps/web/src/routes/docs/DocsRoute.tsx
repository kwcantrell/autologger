// The documentation at /docs and /docs/<section>/<slug>: public (no sign-in), in the landing
// page's chrome, with "Open app" for signed-in readers. App.tsx lazy-loads this module ahead of
// RootGate, so it never weighs on the landing page or the app. Pages come from the repo's docs/
// folder through `virtual:docs` (vite.config.ts): the index ships with this chunk, each page's
// Markdown loads on demand. The document is viewport-locked on desktop (tailwind.css), so the
// page is its own scroll container, as the landing page is.

import { loaders, pages } from 'virtual:docs';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Menu, Pencil } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useCapabilities, useMe } from '@/api/queries';
import { Button } from '@/shared/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/shared/components/ui/sheet';
import { cn } from '@/shared/lib/utils';
import { ChromeProvider, FOCUS, Footer, Header, WRAP } from '../landing/chrome';
import { landingLinks, REPO_URL } from '../landing/links';
import { DocsMarkdown } from './DocsMarkdown';
import {
  type DocMeta,
  docNeighbours,
  docSections,
  extractHeadings,
  parseFrontMatter,
} from './docsIndex';

const SECTIONS = docSections(pages);
const SECTION_LABEL = new Map(SECTIONS.map((s) => [s.id, s.label]));
const EYEBROW =
  'm-0 font-label text-[0.75rem] font-semibold uppercase leading-none tracking-[0.14em] text-[color-mix(in_oklab,var(--si-accent)_72%,#ffffff)]';

const docUrl = (p: DocMeta) => (p.path ? `/docs/${p.path}` : '/docs');

/** '/docs/guide/topics/' → 'guide/topics'. */
function pathOf(location: string) {
  return location.replace(/^\/docs\/?/, '').replace(/\/+$/, '');
}

function usePageBody(page: DocMeta | null) {
  return useQuery({
    queryKey: ['docs', page?.path],
    enabled: page !== null,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      const raw = (await loaders[page!.path]()).default;
      // A leading `# Title` (handy when the file is read on GitHub) repeats the page title.
      return (parseFrontMatter(raw)?.body ?? raw).replace(/^\s*#[ \t]+[^\n]*\n/, '');
    },
  });
}

/** The tab title and meta description follow the page; both are restored on leaving the docs. */
function useDocumentMeta(title: string, description: string) {
  useEffect(() => {
    const prevTitle = document.title;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const created = !meta;
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'description';
      document.head.append(meta);
    }
    const prevDescription = meta.content;
    document.title = title;
    meta.content = description;
    return () => {
      document.title = prevTitle;
      if (created) meta.remove();
      else meta.content = prevDescription;
    };
  }, [title, description]);
}

/**
 * The route mounts before the page's Markdown arrives, so the browser can't find a `#heading` on
 * first load. Once the body is rendered, scroll to the URL's hash (headings carry scroll-mt for
 * the sticky header), or to the top when moving to another page.
 */
function useScrollOnPage(
  scroller: React.RefObject<HTMLElement | null>,
  path: string,
  ready: boolean,
) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs again for every new page (path)
  useEffect(() => {
    if (!ready) return;
    let id = '';
    try {
      id = decodeURIComponent(window.location.hash.slice(1));
    } catch {
      /* a malformed hash scrolls to the top */
    }
    const el = id ? document.getElementById(id) : null;
    if (el) el.scrollIntoView({ block: 'start', behavior: 'instant' });
    else scroller.current?.scrollTo({ top: 0, behavior: 'instant' });
  }, [scroller, path, ready]);
}

export function DocsRoute() {
  const [location] = useLocation();
  const path = pathOf(location);
  const page = pages.find((p) => p.path === path) ?? null;
  const body = usePageBody(page);
  const me = useMe();
  const docsUrl = useCapabilities().data?.docsUrl;
  const chrome = useMemo(
    () => ({ links: landingLinks(docsUrl), page: 'docs' as const, signedIn: Boolean(me.data) }),
    [docsUrl, me.data],
  );
  const scroller = useRef<HTMLDivElement>(null);
  useDocumentMeta(
    page
      ? page.path
        ? `${page.title} · AutoLogger docs`
        : 'AutoLogger docs'
      : 'Page not found · AutoLogger docs',
    page?.description ?? 'AutoLogger documentation.',
  );
  useScrollOnPage(scroller, path, page === null || body.isSuccess);

  return (
    <ChromeProvider value={chrome}>
      <div
        id="top"
        ref={scroller}
        className="h-dvh w-full overflow-x-hidden overflow-y-auto bg-si-bg text-si-fg"
      >
        <a
          href="#main"
          className="sr-only z-50 rounded-ctl bg-si-panel-2 px-3 py-2 text-si-fg focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
        >
          Skip to content
        </a>
        <Header />
        <div
          className={cn(
            WRAP,
            'grid grid-cols-1 gap-x-10 lg:grid-cols-[13.5rem_minmax(0,1fr)] xl:grid-cols-[13.5rem_minmax(0,1fr)_12rem]',
          )}
        >
          <aside
            aria-label="Documentation"
            className="sticky top-14 max-h-[calc(100dvh-3.5rem)] self-start overflow-y-auto py-8 max-lg:hidden"
          >
            <DocsNav current={page?.path ?? null} />
          </aside>
          <main id="main" tabIndex={-1} className="min-w-0 pt-6 pb-16 outline-none lg:pt-10">
            <PhoneNav current={page} />
            {page ? (
              <DocPage
                page={page}
                body={body.data}
                status={body.status}
                retry={() => void body.refetch()}
              />
            ) : (
              <NotFound path={path} />
            )}
          </main>
          {page && body.data && <OnThisPage body={body.data} />}
        </div>
        <Footer />
      </div>
    </ChromeProvider>
  );
}

function DocsNav({ current, onNavigate }: { current: string | null; onNavigate?: () => void }) {
  const item = (p: DocMeta, label = p.title) => {
    const active = p.path === current;
    return (
      <li key={p.path}>
        <Link
          href={docUrl(p)}
          onClick={onNavigate}
          aria-current={active ? 'page' : undefined}
          className={cn(
            'flex min-h-9 items-center rounded-ctl px-2.5 py-1.5 text-[0.875rem] leading-snug no-underline transition-colors max-lg:min-h-11',
            active
              ? 'bg-(--si-primary-tint) font-semibold text-si-fg'
              : 'text-si-muted hover:bg-[rgba(255,255,255,0.06)] hover:text-si-fg',
            FOCUS,
          )}
        >
          {label}
        </Link>
      </li>
    );
  };
  const home = pages.find((p) => p.path === '');
  return (
    <nav aria-label="Documentation pages" className="flex flex-col gap-6">
      {home && <ul className="m-0 flex list-none flex-col p-0">{item(home, 'Overview')}</ul>}
      {SECTIONS.map((s) => (
        <section key={s.id} aria-labelledby={`docs-nav-${s.id}`}>
          <h2
            id={`docs-nav-${s.id}`}
            className="m-0 mb-1.5 px-2.5 font-label text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-si-dim"
          >
            {s.label}
          </h2>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">{s.pages.map((p) => item(p))}</ul>
        </section>
      ))}
    </nav>
  );
}

/** Below lg the sidebar is a sheet, opened from a bar above the page title. */
function PhoneNav({ current }: { current: DocMeta | null }) {
  const [open, setOpen] = useState(false);
  const where = current?.section ? SECTION_LABEL.get(current.section) : null;
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <Button
            variant="outline"
            className="mb-6 h-11 w-full justify-start gap-2 text-left lg:hidden"
          />
        }
      >
        <Menu aria-hidden="true" />
        <span className="min-w-0 truncate">
          {current ? (where ? `${where} › ${current.title}` : current.title) : 'Documentation'}
        </span>
      </SheetTrigger>
      <SheetContent side="left" className="w-[85vw] max-w-sm gap-0 overflow-y-auto">
        <SheetHeader className="pr-12">
          <SheetTitle>Documentation</SheetTitle>
          <SheetDescription>Guides, agents and developer docs.</SheetDescription>
        </SheetHeader>
        <div className="px-2 pb-6">
          <DocsNav current={current?.path ?? null} onNavigate={() => setOpen(false)} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function DocPage({
  page,
  body,
  status,
  retry,
}: {
  page: DocMeta;
  body: string | undefined;
  status: 'pending' | 'error' | 'success';
  retry: () => void;
}) {
  const { prev, next } = docNeighbours(pages, page.path);
  const section = page.section ? SECTION_LABEL.get(page.section) : null;
  return (
    <article aria-labelledby="doc-title" className="max-w-[46rem]">
      <header className="flex flex-col gap-3 border-b border-si-line pb-6">
        {section && <p className={EYEBROW}>{section}</p>}
        <h1
          id="doc-title"
          className="m-0 text-[2rem] font-semibold leading-[1.1] tracking-[-0.01em] sm:text-[2.5rem]"
        >
          {page.title}
        </h1>
        <p className="m-0 text-[1.0625rem] leading-[1.55] text-si-muted">{page.description}</p>
      </header>
      <div className="mt-6">
        {status === 'pending' && (
          <p role="status" className="text-si-muted">
            Loading…
          </p>
        )}
        {status === 'error' && (
          <div role="alert" className="flex flex-col items-start gap-3">
            <p className="m-0 text-si-muted">
              Couldn't load this page. Check your connection and try again.
            </p>
            <Button variant="outline" onClick={retry}>
              Try again
            </Button>
          </div>
        )}
        {body !== undefined && <DocsMarkdown body={body} />}
      </div>
      {page.path === '' && <SectionCards />}
      <footer className="mt-12 flex flex-col gap-6 border-t border-si-line pt-6">
        <a
          href={`${REPO_URL}/edit/main/${page.file}`}
          target="_blank"
          rel="noreferrer"
          className={cn(
            'inline-flex w-fit items-center gap-1.5 text-[0.875rem] text-si-muted no-underline hover:text-si-fg hover:underline',
            FOCUS,
          )}
        >
          <Pencil aria-hidden="true" className="size-3.5" />
          Edit this page on GitHub
        </a>
        {(prev || next) && (
          <nav aria-label="Previous and next page" className="grid gap-3 sm:grid-cols-2">
            {prev ? (
              <PagerLink page={prev} dir="prev" />
            ) : (
              <span aria-hidden="true" className="max-sm:hidden" />
            )}
            {next && <PagerLink page={next} dir="next" />}
          </nav>
        )}
      </footer>
    </article>
  );
}

function PagerLink({ page, dir }: { page: DocMeta; dir: 'prev' | 'next' }) {
  return (
    <Link
      href={docUrl(page)}
      rel={dir}
      className={cn(
        'flex flex-col gap-1 rounded-card border border-si-line bg-si-panel p-4 no-underline transition-colors hover:border-(--si-line-strong)',
        dir === 'next' && 'sm:col-start-2 sm:items-end sm:text-right',
        FOCUS,
      )}
    >
      <span className="flex items-center gap-1.5 text-[0.75rem] text-si-dim">
        {dir === 'prev' && <ArrowLeft aria-hidden="true" className="size-3.5" />}
        {dir === 'prev' ? 'Previous' : 'Next'}
        {dir === 'next' && <ArrowRight aria-hidden="true" className="size-3.5" />}
      </span>
      <span className="text-[0.9375rem] font-semibold text-si-fg">{page.title}</span>
    </Link>
  );
}

/** The docs home: one card per section, listing its pages. */
function SectionCards() {
  return (
    <ul className="m-0 mt-8 grid list-none gap-4 p-0 md:grid-cols-2">
      {SECTIONS.map((s) => (
        <li
          key={s.id}
          className="flex flex-col gap-3 rounded-card border border-si-line bg-si-panel p-5"
        >
          <h2 className="m-0 text-[1.0625rem] font-semibold">{s.label}</h2>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {s.pages.map((p) => (
              <li key={p.path} className="flex flex-col gap-0.5">
                <Link
                  href={docUrl(p)}
                  className={cn(
                    'w-fit text-[0.9375rem] font-semibold text-[color-mix(in_oklab,var(--si-accent)_72%,#ffffff)] no-underline hover:underline',
                    FOCUS,
                  )}
                >
                  {p.title}
                </Link>
                <span className="text-[0.84rem] leading-[1.5] text-si-muted">{p.description}</span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

function OnThisPage({ body }: { body: string }) {
  const headings = useMemo(
    () => extractHeadings(body).filter((h) => h.depth === 2 || h.depth === 3),
    [body],
  );
  if (headings.length < 2) return null;
  return (
    <aside
      aria-labelledby="docs-toc-title"
      className="sticky top-14 max-h-[calc(100dvh-3.5rem)] self-start overflow-y-auto py-10 max-xl:hidden"
    >
      <h2
        id="docs-toc-title"
        className="m-0 mb-2 font-label text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-si-dim"
      >
        On this page
      </h2>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {headings.map((h) => (
          <li key={h.id} className={cn(h.depth === 3 && 'pl-3')}>
            <a
              href={`#${h.id}`}
              className={cn(
                'text-[0.8125rem] leading-snug text-si-muted no-underline hover:text-si-fg',
                FOCUS,
              )}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function NotFound({ path }: { path: string }): ReactNode {
  return (
    <section aria-labelledby="doc-title" className="max-w-[46rem]">
      <p className={EYEBROW}>404</p>
      <h1
        id="doc-title"
        className="m-0 mt-3 text-[2rem] font-semibold leading-[1.1] tracking-[-0.01em] sm:text-[2.5rem]"
      >
        Page not found
      </h1>
      <p className="mt-4 text-[1.0625rem] leading-[1.55] text-si-muted">
        There's no documentation page at{' '}
        <code className="font-mono text-[0.9em] text-si-fg [overflow-wrap:anywhere]">
          /docs/{path}
        </code>
        . It may have moved: start from the overview or pick a page from the list.
      </p>
      <Button nativeButton={false} className="mt-2 h-11 px-5" render={<Link href="/docs" />}>
        Documentation overview
      </Button>
    </section>
  );
}
