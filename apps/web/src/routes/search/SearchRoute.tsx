// `/search?q=&show=`: the full results page. The URL is the state; every edit REPLACES the entry
// (Back leaves the page rather than stepping through keystrokes). Results are grouped by kind;
// moments are grouped under their session, 3 each, with "Show N more in this session".

import type { SearchHit } from '@autologger/contract';
import { BookOpenIcon, SearchIcon } from 'lucide-react';
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react';
import { Link, useLocation, useSearch as useLocationSearch } from 'wouter';
import { useSearch } from '@/api/queries';
import { errorMessage } from '@/api/rpc';
import { useActive } from '@/app/useActive';
import { PageFrame } from '@/components/RouteState';
import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select';
import { Spinner } from '@/shared/components/ui/spinner';
import { fmtDateOnly } from '@/shared/utils/fmtDateOnly';
import { SearchSnippet } from './SearchSnippet';
import {
  groupHits,
  hitHref,
  isSearchable,
  type MomentHit,
  momentLabel,
  SEARCH_DEBOUNCE_MS,
  sessionHref,
  showAndDate,
  untitled,
} from './searchLinks';

const PAGE_LIMIT = 100;
const PER_SESSION = 3;
const ALL = '__all__';

const RESULT_ROW =
  'flex w-full min-w-0 flex-col items-start gap-1 rounded-ctl px-3 py-2.5 text-left no-underline outline-none transition-colors hover:bg-si-panel-2 focus-visible:ring-[3px] focus-visible:ring-ring/50';

function ResultLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className={RESULT_ROW}>
      {children}
    </Link>
  );
}

function ResultGroup({
  title,
  children,
  list = true,
}: {
  title: string;
  children: ReactNode;
  list?: boolean;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1">
      <h2 id={id} className="m-0 px-3 text-xs font-semibold tracking-wide text-si-dim uppercase">
        {title}
      </h2>
      {list ? <ul className="m-0 flex list-none flex-col p-0">{children}</ul> : children}
    </section>
  );
}

function MomentItem({ h }: { h: MomentHit }) {
  return (
    <li>
      <ResultLink href={hitHref(h)}>
        <span data-slot="moment-label" className="text-xs font-medium tracking-wide text-si-dim">
          {momentLabel(h)}
        </span>
        <SearchSnippet text={h.snippet} className="text-sm" />
      </ResultLink>
    </li>
  );
}

function SessionMoments({
  sessionId,
  title,
  date,
  moments,
}: {
  sessionId: string;
  title: string;
  date: string | null;
  moments: MomentHit[];
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? moments : moments.slice(0, PER_SESSION);
  const more = moments.length - shown.length;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-0.5">
      <h3
        id={id}
        className="m-0 flex min-w-0 items-baseline gap-2 px-3 pt-1 text-sm font-medium text-si-fg"
      >
        <span className="truncate">{untitled(title)}</span>
        {date && (
          <span className="shrink-0 text-xs font-normal text-si-dim">{fmtDateOnly(date)}</span>
        )}
        <Link
          href={sessionHref(sessionId)}
          className="shrink-0 text-xs font-normal text-si-dim underline-offset-2 hover:text-si-fg hover:underline"
        >
          Open session
        </Link>
      </h3>
      <ul className="m-0 flex list-none flex-col p-0">
        {shown.map((h) => (
          <MomentItem key={`${h.kind}:${h.id}`} h={h} />
        ))}
      </ul>
      {more > 0 && (
        <Button
          variant="link"
          size="xs"
          className="self-start px-3"
          onClick={() => setExpanded(true)}
        >
          Show {more} more in this session
        </Button>
      )}
    </section>
  );
}

function MomentsBySession({ moments }: { moments: MomentHit[] }) {
  const groups = useMemo(() => {
    const by = new Map<string, MomentHit[]>();
    for (const m of moments) {
      const k = m.sessionId ?? '';
      const list = by.get(k);
      if (list) list.push(m);
      else by.set(k, [m]);
    }
    return [...by].map(([sessionId, list]) => ({
      sessionId,
      list,
      title: list[0]?.sessionTitle ?? '',
      date: list[0]?.sessionDate ?? null,
    }));
  }, [moments]);
  return (
    <div className="flex flex-col gap-3">
      {groups.map((g) => (
        <SessionMoments
          key={g.sessionId}
          sessionId={g.sessionId}
          title={g.title}
          date={g.date}
          moments={g.list}
        />
      ))}
    </div>
  );
}

function searchUrl(q: string, show: string) {
  const p = new URLSearchParams();
  if (q) p.set('q', q);
  if (show) p.set('show', show);
  const s = p.toString();
  return s ? `/search?${s}` : '/search';
}

export function SearchRoute() {
  const [, navigate] = useLocation();
  const search = useLocationSearch();
  const { q, show } = useMemo(() => {
    const p = new URLSearchParams(search);
    return { q: p.get('q') ?? '', show: p.get('show') ?? '' };
  }, [search]);
  const replace = (next: { q?: string; show?: string }) =>
    navigate(searchUrl(next.q ?? q, next.show ?? show), { replace: true });

  // The URL's query searches at once; later edits wait for typing to pause.
  const [debouncedQ, setDebouncedQ] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  const { allShows, teams } = useActive();
  const { data, isPending, isFetching, isError, error, refetch } = useSearch(
    isSearchable(debouncedQ)
      ? { query: debouncedQ.trim(), limit: PAGE_LIMIT, ...(show ? { showId: show } : {}) }
      : null,
  );

  const multiTeam = teams.length > 1;
  const showItems = [
    { value: ALL, label: 'All shows' },
    ...allShows.map((s) => ({
      value: s.id,
      label: multiTeam ? `${s.name} · ${s.teamName}` : s.name,
    })),
  ];

  const searchable = isSearchable(q);
  const waiting = debouncedQ !== q || isPending || (isFetching && !data);
  const groups = searchable && data ? groupHits(data) : null;

  let body: ReactNode;
  if (!searchable) {
    body = (
      <p className="m-0 py-10 text-center text-sm text-si-muted">
        Type at least 2 characters to search sessions, transcripts, topics and events.
      </p>
    );
  } else if (isError && !waiting) {
    body = (
      <div role="alert" className="flex flex-col items-center gap-3 py-10 text-center text-sm">
        <p className="m-0 text-si-fg">{errorMessage(error) || 'Search failed.'}</p>
        <Button variant="outline" onClick={() => void refetch()}>
          Try again
        </Button>
      </div>
    );
  } else if (!groups || waiting) {
    body = (
      <div
        role="status"
        className="flex items-center justify-center gap-2 py-10 text-sm text-si-muted"
      >
        <Spinner role="presentation" aria-hidden="true" className="size-4" /> Searching…
      </div>
    );
  } else if (!groups.sessions.length && !groups.moments.length && !groups.wiki.length) {
    body = (
      <p className="m-0 py-10 text-center text-sm text-si-muted">No results for “{q.trim()}”.</p>
    );
  } else {
    body = (
      <div className="flex flex-col gap-6">
        {groups.sessions.length > 0 && (
          <ResultGroup title="Sessions">
            {groups.sessions.map((h) => (
              <li key={h.id}>
                <ResultLink href={hitHref(h)}>
                  <span className="flex w-full min-w-0 items-baseline gap-2">
                    <span className="truncate font-medium text-si-fg">{untitled(h.title)}</span>
                    <span className="ml-auto shrink-0 text-xs text-si-dim">{showAndDate(h)}</span>
                  </span>
                  {h.snippet && <SearchSnippet text={h.snippet} className="text-sm" />}
                </ResultLink>
              </li>
            ))}
          </ResultGroup>
        )}
        {groups.moments.length > 0 && (
          <ResultGroup title="Moments" list={false}>
            <MomentsBySession key={`${debouncedQ}\n${show}`} moments={groups.moments} />
          </ResultGroup>
        )}
        {groups.wiki.length > 0 && (
          <ResultGroup title="Wiki pages">
            {groups.wiki.map((h: SearchHit) => (
              <li key={h.id}>
                <ResultLink href={hitHref(h)}>
                  <span className="flex w-full min-w-0 items-baseline gap-2">
                    <BookOpenIcon
                      aria-hidden="true"
                      className="size-3.5 shrink-0 self-center text-si-dim"
                    />
                    <span className="truncate font-medium text-si-fg">{h.title}</span>
                    <span className="ml-auto shrink-0 text-xs text-si-dim">{h.showName}</span>
                  </span>
                  {h.snippet && <SearchSnippet text={h.snippet} className="text-sm" />}
                </ResultLink>
              </li>
            ))}
          </ResultGroup>
        )}
      </div>
    );
  }

  return (
    <PageFrame className="max-md:px-3">
      <div data-slot="search-route" className="contents">
        <h1 className="m-0 text-[1.35rem] font-semibold text-si-fg">Search</h1>
        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <div className="relative min-w-0 flex-1">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-si-dim"
            />
            <Input
              type="search"
              aria-label="Search"
              placeholder="Search sessions, transcripts, topics, events…"
              value={q}
              onChange={(e) => replace({ q: e.target.value })}
              className="pl-9"
              autoFocus={!q}
            />
          </div>
          <Select
            items={showItems}
            value={show || ALL}
            onValueChange={(v) => replace({ show: !v || v === ALL ? '' : String(v) })}
          >
            <SelectTrigger aria-label="Show filter" className="md:w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {showItems.map((it) => (
                <SelectItem key={it.value} value={it.value}>
                  {it.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {body}
      </div>
    </PageFrame>
  );
}
