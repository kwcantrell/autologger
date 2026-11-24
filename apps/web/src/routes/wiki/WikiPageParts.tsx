// The read view of a wiki page around its body (WikiMarkdown): the header and the "Linked from"
// list. Presentational (props in, markup out), so the landing page mocks render them too.

import type { WikiPage } from '@autologger/contract';
import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { Badge } from '@/shared/components/ui/badge';
import { fmtWhen, WIKI_KIND_LABEL, wikiHref } from './wikiShared';

/** Kind, title, aliases and who changed it last (with the session, for a recap). */
export function WikiPageHeader({
  page,
}: {
  page: Pick<
    WikiPage,
    'kind' | 'title' | 'aliases' | 'updatedBy' | 'updatedAt' | 'revision' | 'sessionId'
  >;
}) {
  return (
    <header className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{WIKI_KIND_LABEL[page.kind]}</Badge>
      </div>
      <h1 className="m-0 text-[1.35rem] font-semibold break-words text-si-fg">{page.title}</h1>
      {page.aliases.length > 0 && (
        <ul aria-label="Aliases" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {page.aliases.map((a) => (
            <li key={a}>
              <Badge variant="outline" className="normal-case tracking-normal">
                {a}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <p className="m-0 text-xs text-si-dim">
        Last changed by <span className="text-si-muted">{page.updatedBy?.name ?? 'someone'}</span>,{' '}
        <time dateTime={page.updatedAt}>{fmtWhen(page.updatedAt)}</time> · r{page.revision}
        {page.sessionId && (
          <>
            {' · '}
            <Link
              href={`/sessions/${encodeURIComponent(page.sessionId)}`}
              className="text-si-muted underline underline-offset-2 hover:text-si-fg"
            >
              Open session
            </Link>
          </>
        )}
      </p>
    </header>
  );
}

/**
 * "Linked from": the backlinks given; `children` adds list items after them ("and N more").
 * `wikiOf` names the wiki a backlink comes from when it isn't the page's own (a show page linking
 * a team page).
 */
export function BacklinksSection({
  backlinks,
  children,
  wikiOf,
}: {
  backlinks: (Pick<WikiPage['backlinks'][number], 'id' | 'title' | 'kind'> & {
    showId?: string | null;
  })[];
  children?: ReactNode;
  wikiOf?: (showId: string | null) => string | undefined;
}) {
  return (
    <section
      aria-labelledby="wiki-backlinks"
      className="flex flex-col gap-1 border-t border-si-line pt-4"
    >
      <h2
        id="wiki-backlinks"
        className="m-0 text-xs font-semibold tracking-wide text-si-dim uppercase"
      >
        Linked from
      </h2>
      <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">
        {backlinks.map((b) => (
          <li key={b.id} className="flex items-baseline gap-1.5 text-sm">
            <Link
              href={wikiHref(b.id)}
              className="text-si-fg underline decoration-(--si-line-strong) underline-offset-2 hover:text-si-accent"
            >
              {b.title}
            </Link>
            <span className="text-xs text-si-dim">
              {WIKI_KIND_LABEL[b.kind]}
              {b.showId !== undefined && wikiOf?.(b.showId) ? ` · ${wikiOf(b.showId)}` : ''}
            </span>
          </li>
        ))}
        {children}
      </ul>
    </section>
  );
}
