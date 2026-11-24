// `/wiki`: the active show's wiki, and `/teams/:teamId/wiki`: the team's shared wiki (people, bits
// and topics spanning its shows). One fetch of the wiki's pages; the line tabs split them by kind
// and the filter matches titles and aliases (case- and accent-insensitive). The show wiki also
// lists, per kind, the team wiki's pages its [[links]] reach (those it has no page of its own for).

import { normTitle, type WikiKind, type WikiPageSummary } from '@autologger/contract';
import { HistoryIcon, LibraryIcon, PlusIcon, SearchIcon } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { useMe, useWikiList, type WikiScope } from '@/api/queries';
import { errorMessage } from '@/api/rpc';
import { useActive } from '@/app/useActive';
import { PageFrame, RouteLoadingState } from '@/components/RouteState';
import { Button } from '@/shared/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/shared/components/ui/empty';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/shared/components/ui/input-group';
import { Spinner } from '@/shared/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/components/ui/tabs';
import { LoadErrorAlert } from '@/shared/ui/LoadErrorAlert';
import { Tooltip } from '@/shared/ui/Tooltip';
import { NewWikiPageDialog } from './NewWikiPageDialog';
import { fmtDate, fold, teamWikiHref, wikiHref } from './wikiShared';

const TABS: { id: WikiKind; label: string; empty: string }[] = [
  { id: 'person', label: 'People', empty: 'No people yet' },
  { id: 'topic', label: 'Topics', empty: 'No topics yet' },
  { id: 'bit', label: 'Running bits', empty: 'No running bits yet' },
  { id: 'session', label: 'Sessions', empty: 'No session pages yet' },
  { id: 'question', label: 'Questions', empty: 'No questions yet' },
];

const ROW =
  'flex w-full min-w-0 flex-col items-start gap-0.5 rounded-ctl px-3 py-2.5 text-left no-underline outline-none transition-colors hover:bg-si-panel-2 focus-visible:ring-[3px] focus-visible:ring-ring/50';

/** Titles in reading order: numbers compare as numbers ("Chapter 2" before "Chapter 10"). */
const TITLE_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function matches(page: WikiPageSummary, needle: string) {
  return !needle || [page.title, ...page.aliases].some((s) => fold(s).includes(needle));
}

function PageRow({ page }: { page: WikiPageSummary }) {
  return (
    <li>
      <Link href={wikiHref(page.id)} className={ROW} data-title={page.title}>
        <span className="w-full truncate font-medium text-si-fg">{page.title}</span>
        {page.aliases.length > 0 && (
          <span className="w-full truncate text-xs text-si-muted">
            Also: {page.aliases.join(', ')}
          </span>
        )}
        <span className="text-xs text-si-dim">
          Updated {fmtDate(page.updatedAt)}
          {page.updatedBy ? ` by ${page.updatedBy.name}` : ''}
        </span>
      </Link>
    </li>
  );
}

function Status({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 py-10 text-sm text-si-muted"
    >
      {children}
    </div>
  );
}

const byTitle = (a: WikiPageSummary, b: WikiPageSummary) => TITLE_ORDER.compare(a.title, b.title);

function PageList({
  scope,
  teamId,
  tab,
  needle,
  filterText,
}: {
  scope: WikiScope;
  /** For a show wiki: its team, whose shared pages are listed below the show's. */
  teamId?: string;
  tab: (typeof TABS)[number];
  needle: string;
  filterText: string;
}) {
  const { data, isPending, isError, error, refetch, isRefetching } = useWikiList(scope);
  const team = useWikiList(teamId ? { teamId } : undefined);
  const ofKind = useMemo(
    () => (data ?? []).filter((p) => p.kind === tab.id).sort(byTitle),
    [data, tab.id],
  );
  // Team pages the show's links reach: none of the show's pages takes their title.
  const teamOfKind = useMemo(() => {
    const own = new Set((data ?? []).flatMap((p) => [p.title, ...p.aliases].map(normTitle)));
    return (team.data ?? [])
      .filter((p) => p.kind === tab.id && !own.has(normTitle(p.title)))
      .sort(byTitle);
  }, [data, team.data, tab.id]);
  const pages = useMemo(() => ofKind.filter((p) => matches(p, needle)), [ofKind, needle]);
  const teamPages = useMemo(
    () => teamOfKind.filter((p) => matches(p, needle)),
    [teamOfKind, needle],
  );

  if (isError)
    return (
      <LoadErrorAlert
        title="Couldn’t load the wiki"
        onRetry={() => void refetch()}
        retrying={isRefetching}
        className="my-4"
      >
        {errorMessage(error) || 'Check your connection and try again.'}
      </LoadErrorAlert>
    );
  if (isPending)
    return (
      <Status>
        <Spinner role="presentation" aria-hidden="true" className="size-4" /> Loading pages…
      </Status>
    );
  if (ofKind.length === 0 && teamOfKind.length === 0)
    return (
      <Empty className="py-10">
        <EmptyHeader className="max-w-[26rem]">
          <EmptyTitle>{tab.empty}</EmptyTitle>
          <EmptyDescription>
            Pages are written by operators here with “New page”, or by agents connected over MCP.
            Link pages to each other with [[Title]].
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  if (pages.length === 0 && teamPages.length === 0)
    return (
      <p className="m-0 py-10 text-center text-sm text-si-muted">
        No pages match “{filterText.trim()}”.
      </p>
    );
  return (
    <>
      {pages.length > 0 && (
        <ul aria-label={`${tab.label} pages`} className="m-0 flex list-none flex-col p-0">
          {pages.map((p) => (
            <PageRow key={p.id} page={p} />
          ))}
        </ul>
      )}
      {teamId && teamPages.length > 0 && (
        <section
          aria-labelledby={`team-${tab.id}`}
          className="mt-3 flex flex-col gap-1 border-t border-si-line pt-3"
        >
          <h2
            id={`team-${tab.id}`}
            className="m-0 px-3 text-xs font-semibold tracking-wide text-si-dim uppercase"
          >
            From the team wiki
          </h2>
          <ul aria-label={`Team ${tab.label} pages`} className="m-0 flex list-none flex-col p-0">
            {teamPages.map((p) => (
              <PageRow key={p.id} page={p} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/** Filter, kind tabs and page lists of one wiki, plus its New page dialog. */
function WikiIndex({
  scope,
  teamId,
  tabs,
  creating,
  onCreatingChange,
}: {
  scope: WikiScope;
  teamId?: string;
  tabs: typeof TABS;
  creating: boolean;
  onCreatingChange: (open: boolean) => void;
}) {
  const [tab, setTab] = useState<WikiKind>('person');
  const [filter, setFilter] = useState('');
  const needle = fold(filter.trim());
  return (
    <>
      <InputGroup>
        <InputGroupInput
          type="search"
          aria-label="Filter pages"
          placeholder="Filter by title or alias"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <InputGroupAddon className="text-si-dim">
          <SearchIcon aria-hidden="true" />
        </InputGroupAddon>
      </InputGroup>
      <Tabs value={tab} onValueChange={(v) => setTab(v as WikiKind)} className="min-w-0">
        <div className="flex min-w-0 max-md:overflow-x-auto max-md:[scrollbar-width:none]">
          <TabsList variant="line" aria-label="Page kinds">
            {tabs.map((t) => (
              <TabsTrigger key={t.id} value={t.id}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {tabs.map((t) => (
          <TabsContent key={t.id} value={t.id} className="pt-3">
            <PageList scope={scope} teamId={teamId} tab={t} needle={needle} filterText={filter} />
          </TabsContent>
        ))}
      </Tabs>
      <NewWikiPageDialog
        scope={scope}
        open={creating}
        onOpenChange={onCreatingChange}
        initialKind={tab}
      />
    </>
  );
}

export function WikiRoute() {
  const { show, team, showsLoading, canWriteShow } = useActive();
  const [creating, setCreating] = useState(false);

  if (showsLoading) return <RouteLoadingState label="Loading wiki" />;

  return (
    <PageFrame className="max-md:px-3">
      <div data-slot="wiki-route" className="contents">
        <div className="flex min-w-0 flex-wrap items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h1 className="m-0 text-[1.35rem] font-semibold text-si-fg">Wiki</h1>
            {show && <p className="m-0 truncate text-sm text-si-muted">{show.name}</p>}
          </div>
          {show && (
            <Tooltip content={`Pages shared by every show of ${show.teamName}`}>
              <Button
                variant="outline"
                nativeButton={false}
                render={<Link href={teamWikiHref(show.teamId)} />}
              >
                <LibraryIcon data-icon="inline-start" />
                Team wiki
              </Button>
            </Tooltip>
          )}
          {show && (
            <Tooltip content="Wiki edits and deletes, with undo">
              <Button
                variant="outline"
                nativeButton={false}
                render={<Link href="/changes?where=show&kind=wiki_page" />}
              >
                <HistoryIcon data-icon="inline-start" />
                Changes
              </Button>
            </Tooltip>
          )}
          {show && (
            <Tooltip content="You can read this show but not edit it." disabled={canWriteShow}>
              <span className="inline-flex">
                <Button onClick={() => setCreating(true)} disabled={!canWriteShow}>
                  <PlusIcon data-icon="inline-start" />
                  New page
                </Button>
              </span>
            </Tooltip>
          )}
        </div>
        {!show ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No show chosen</EmptyTitle>
              <EmptyDescription>
                Choose a show in the top bar to see its wiki
                {team ? (
                  <>
                    , or open{' '}
                    <Link href={teamWikiHref(team.id)} className="underline underline-offset-2">
                      {team.name}’s team wiki
                    </Link>
                  </>
                ) : null}
                .
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <WikiIndex
            key={show.id}
            scope={{ showId: show.id }}
            teamId={show.teamId}
            tabs={TABS}
            creating={creating}
            onCreatingChange={setCreating}
          />
        )}
      </div>
    </PageFrame>
  );
}

const TEAM_TABS = TABS.filter((t) => t.id !== 'session');

/** `/teams/:teamId/wiki`: the team's shared wiki; every member reads and edits it. */
export function TeamWikiRoute({ teamId }: { teamId: string }) {
  const { teams } = useActive();
  const me = useMe();
  const team = teams.find((t) => t.id === teamId) ?? null;
  const [creating, setCreating] = useState(false);

  if (me.isPending) return <RouteLoadingState label="Loading wiki" />;

  return (
    <PageFrame className="max-md:px-3">
      <div data-slot="wiki-route" className="contents">
        <div className="flex min-w-0 flex-wrap items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h1 className="m-0 text-[1.35rem] font-semibold text-si-fg">Team wiki</h1>
            {team && (
              <p className="m-0 truncate text-sm text-si-muted">
                {team.name} · people, bits and topics shared by its shows
              </p>
            )}
          </div>
          {team && (
            <Button onClick={() => setCreating(true)}>
              <PlusIcon data-icon="inline-start" />
              New page
            </Button>
          )}
        </div>
        {!team ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Team not found</EmptyTitle>
              <EmptyDescription>
                You aren’t a member of this team, or it no longer exists.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <WikiIndex
            key={team.id}
            scope={{ teamId: team.id }}
            tabs={TEAM_TABS}
            creating={creating}
            onCreatingChange={setCreating}
          />
        )}
      </div>
    </PageFrame>
  );
}
