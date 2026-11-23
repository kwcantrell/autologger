// `/wiki`: the active show's wiki. One fetch of the show's pages; the line tabs split them by kind
// and the filter matches titles and aliases (case- and accent-insensitive).

import type { WikiKind, WikiPageSummary } from '@autologger/contract';
import { HistoryIcon, PlusIcon, SearchIcon } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { useWikiList } from '@/api/queries';
import { errorMessage } from '@/api/rpc';
import { useActive } from '@/app/useActive';
import { PageFrame, RouteLoadingState } from '@/components/RouteState';
import { Button } from '@/shared/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/shared/components/ui/empty';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/shared/components/ui/input-group';
import { Spinner } from '@/shared/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/components/ui/tabs';
import { Tooltip } from '@/shared/ui/Tooltip';
import { NewWikiPageDialog } from './NewWikiPageDialog';
import { fmtDate, fold, wikiHref } from './wikiShared';

const TABS: { id: WikiKind; label: string; empty: string }[] = [
  { id: 'person', label: 'People', empty: 'No people yet.' },
  { id: 'topic', label: 'Topics', empty: 'No topics yet.' },
  { id: 'bit', label: 'Running bits', empty: 'No running bits yet.' },
  { id: 'session', label: 'Sessions', empty: 'No session pages yet.' },
  { id: 'question', label: 'Questions', empty: 'No questions yet.' },
];

const ROW =
  'flex w-full min-w-0 flex-col items-start gap-0.5 rounded-ctl px-3 py-2.5 text-left no-underline outline-none transition-colors hover:bg-si-panel-2 focus-visible:ring-[3px] focus-visible:ring-ring/50';

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

function PageList({
  showId,
  tab,
  needle,
  filterText,
}: {
  showId: string;
  tab: (typeof TABS)[number];
  needle: string;
  filterText: string;
}) {
  const { data, isPending, isError, error, refetch } = useWikiList(showId);
  const ofKind = useMemo(() => (data ?? []).filter((p) => p.kind === tab.id), [data, tab.id]);
  const pages = useMemo(() => ofKind.filter((p) => matches(p, needle)), [ofKind, needle]);

  if (isError)
    return (
      <div role="alert" className="flex flex-col items-center gap-3 py-10 text-center text-sm">
        <p className="m-0 text-si-fg">{errorMessage(error) || 'Could not load the wiki.'}</p>
        <Button variant="outline" onClick={() => void refetch()}>
          Try again
        </Button>
      </div>
    );
  if (isPending)
    return (
      <Status>
        <Spinner role="presentation" aria-hidden="true" className="size-4" /> Loading pages…
      </Status>
    );
  if (ofKind.length === 0)
    return (
      <div className="flex flex-col items-center gap-1 py-10 text-center">
        <p className="m-0 text-sm text-si-muted">{tab.empty}</p>
        <p className="m-0 max-w-[26rem] text-xs text-si-dim">
          Pages are written by operators here with “New page”, or by agents connected over MCP. Link
          pages to each other with [[Title]].
        </p>
      </div>
    );
  if (pages.length === 0)
    return (
      <p className="m-0 py-10 text-center text-sm text-si-muted">
        No pages match “{filterText.trim()}”.
      </p>
    );
  return (
    <ul aria-label={`${tab.label} pages`} className="m-0 flex list-none flex-col p-0">
      {pages.map((p) => (
        <PageRow key={p.id} page={p} />
      ))}
    </ul>
  );
}

export function WikiRoute() {
  const { show, showsLoading, canWriteShow } = useActive();
  const [tab, setTab] = useState<WikiKind>('person');
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const needle = fold(filter.trim());

  if (showsLoading) return <RouteLoadingState label="Loading wiki" />;

  return (
    <PageFrame className="max-md:px-3">
      <div data-slot="wiki-route" className="contents">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h1 className="m-0 text-[1.35rem] font-semibold text-si-fg">Wiki</h1>
            {show && <p className="m-0 truncate text-sm text-si-muted">{show.name}</p>}
          </div>
          {show && (
            <Button
              variant="outline"
              nativeButton={false}
              title="Wiki edits and deletes, with undo"
              render={<Link href="/changes?where=show&kind=wiki_page" />}
            >
              <HistoryIcon data-icon="inline-start" />
              Changes
            </Button>
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
              <EmptyDescription>Choose a show in the top bar to see its wiki.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
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
                  {TABS.map((t) => (
                    <TabsTrigger key={t.id} value={t.id}>
                      {t.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
              {TABS.map((t) => (
                <TabsContent key={t.id} value={t.id} className="pt-3">
                  <PageList showId={show.id} tab={t} needle={needle} filterText={filter} />
                </TabsContent>
              ))}
            </Tabs>
            <NewWikiPageDialog
              showId={show.id}
              open={creating}
              onOpenChange={setCreating}
              initialKind={tab}
            />
          </>
        )}
      </div>
    </PageFrame>
  );
}
