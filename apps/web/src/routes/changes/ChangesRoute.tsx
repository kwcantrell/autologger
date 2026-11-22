// `/changes`: the active show's change log — every change in any of its sessions plus the
// show-level ones no session's Agents tab lists (wiki pages, event buttons) — with the same
// Undo / Undo all flow. Filters live in the URL (?where=show|<sessionId>&kind=<entity>&who=…), so
// the Wiki links here with show-level wiki changes preselected. New entries arrive as show-socket
// hints (liveShow.ts).

import type { Change, ChangeEntity, Session } from '@autologger/contract';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useSearch as useLocationSearch } from 'wouter';
import { type ShowChangesFilter, useOpMutation, useSessions, useShowChanges } from '@/api/queries';
import { errorMessage } from '@/api/rpc';
import { useActive } from '@/app/useActive';
import { PageFrame, RouteLoadingState } from '@/components/RouteState';
import { settingsOpen } from '@/lib/store';
import { FeedShell, FeedTable, IconFilter } from '@/session/feed';
import { CHANGE_COLUMNS, ChangeRow } from '@/session/tabs/ChangeRow';
import { showToast } from '@/shared/components/Toast';
import { Button } from '@/shared/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/shared/components/ui/empty';
import { useConfirm } from '@/shared/ui/ConfirmDialog';
import { wikiHref } from '../wiki/wikiShared';

const LIMIT = 300;

type Who = 'all' | 'mcp' | 'operators';
const WHO_LABEL: Record<Who, string> = {
  all: 'Everyone',
  mcp: 'Agents only',
  operators: 'Operators',
};

type Kind = ChangeEntity | 'all';
const KIND_LABEL: Record<Kind, string> = {
  all: 'All kinds',
  wiki_page: 'Wiki pages',
  category: 'Event buttons',
  event: 'Events',
  topic: 'Topics',
  transcript_segment: 'Transcript',
  dashboard: 'Dashboards',
  session: 'Session clock',
};

/** `all`: the whole show; `show`: only show-level changes; otherwise a session id. */
type Where = 'all' | 'show' | (string & {});

interface Filters {
  where: Where;
  kind: Kind;
  who: Who;
}

function readFilters(search: string): Filters {
  const p = new URLSearchParams(search);
  const kind = p.get('kind');
  const who = p.get('who');
  return {
    where: p.get('where') || 'all',
    kind: kind && kind in KIND_LABEL ? (kind as Kind) : 'all',
    who: who && who in WHO_LABEL ? (who as Who) : 'all',
  };
}

function filtersUrl(f: Filters): string {
  const p = new URLSearchParams();
  if (f.where !== 'all') p.set('where', f.where);
  if (f.kind !== 'all') p.set('kind', f.kind);
  if (f.who !== 'all') p.set('who', f.who);
  const q = p.toString();
  return q ? `/changes?${q}` : '/changes';
}

function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** A toolbar dropdown with one radio group. */
function FilterMenu<T extends string>({
  title,
  label,
  value,
  options,
  onChange,
}: {
  title: string;
  label: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="glass" title={`${title}: ${label}`} />}>
        {/* Three filters side by side: phones keep the labels too, or the icons look alike. */}
        <IconFilter />
        <span className="max-w-[11rem] truncate max-md:max-w-[8rem]">{label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[60dvh] w-60 overflow-y-auto">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{title}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={value} onValueChange={(v: T) => onChange(v)}>
            {options.map(([v, l]) => (
              <DropdownMenuRadioItem key={v} value={v}>
                <span className="truncate">{l}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Where a change happened: its session, or the show-level item. */
function ChangeContext({ c, sessions }: { c: Change; sessions: Map<string, Session> }) {
  const link = 'text-si-muted underline-offset-2 hover:text-si-fg hover:underline';
  if (c.sessionId) {
    const s = sessions.get(c.sessionId);
    return s ? (
      <Link href={`/sessions/${encodeURIComponent(s.id)}`} className={link}>
        {s.title || 'Untitled session'}
      </Link>
    ) : (
      <span>A deleted session</span>
    );
  }
  if (c.entity === 'category')
    return (
      <span>
        Show ·{' '}
        <button
          type="button"
          className={`${link} cursor-pointer border-0 bg-transparent p-0`}
          onClick={() => settingsOpen.set('event-buttons')}
        >
          Event buttons
        </button>
      </span>
    );
  // A deleted page has no view until the delete is undone.
  const gone = c.entity === 'wiki_page' && c.kind === 'delete' && !c.revertedAt;
  return (
    <span>
      Show wiki
      {c.entity === 'wiki_page' && !gone && (
        <>
          {' · '}
          <Link href={wikiHref(c.entityId)} className={link}>
            Open page
          </Link>
        </>
      )}
    </span>
  );
}

function ChangeLog({
  showId,
  canWrite,
  filters,
  setFilters,
}: {
  showId: string;
  canWrite: boolean;
  filters: Filters;
  setFilters: (f: Filters) => void;
}) {
  const sessionsQ = useSessions(showId);
  const sessions = useMemo(
    () => new Map((sessionsQ.data ?? []).map((s) => [s.id, s] as const)),
    [sessionsQ.data],
  );
  const query: ShowChangesFilter = {
    ...(filters.where === 'all'
      ? {}
      : { sessionId: filters.where === 'show' ? null : filters.where }),
    ...(filters.kind === 'all' ? {} : { entity: filters.kind }),
    ...(filters.who === 'mcp' ? { via: 'mcp' as const } : {}),
  };
  const changes = useShowChanges(showId, query);
  const now = useNow();
  const { confirm, confirmElement } = useConfirm();
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  // An undo may touch any content of the show: refetch whatever of it is on screen.
  const touched = () => [
    ['show-changes', showId],
    ['changes'],
    ['wiki', showId],
    ['wiki-page'],
    ['wiki-revisions'],
    ['categories', showId],
    ['events'],
    ['topics'],
    ['dashboards'],
    ['transcript'],
    ['session'],
  ];
  const revert = useOpMutation('changes.revert', { invalidate: touched });
  const revertGroup = useOpMutation('changes.revertGroup', { invalidate: touched });

  const rows = useMemo(() => {
    const all = changes.data ?? [];
    return filters.who === 'operators'
      ? all.filter((c) => c.via === 'web' || c.via === 'companion')
      : all;
  }, [changes.data, filters.who]);

  const undo = async (c: Change) => {
    const group = c.groupSize && c.groupId ? c.groupId : null;
    const left = (c.groupSize ?? 1) - (c.groupUndone ?? 0);
    const elsewhere = (c.groupTotal ?? 0) - (c.groupSize ?? 0);
    const ok = await confirm({
      title: !group
        ? 'Undo this change?'
        : elsewhere > 0
          ? `Undo all ${c.groupTotal} changes of this call?`
          : `Undo all ${left} changes?`,
      message: group ? (
        <>
          Everything this {c.op} call by {c.actor?.name ?? 'the system'} changed will be reverted in
          one step ({left} change{left === 1 ? '' : 's'} shown here, e.g. “{c.summary}”
          {elsewhere > 0 && <>, and {elsewhere} more outside this filter</>}). Changes already
          undone are skipped. If any of it changed again since, nothing is undone. The undo is
          recorded too and can itself be undone.
        </>
      ) : (
        <>
          “{c.summary}” by {c.actor?.name ?? 'the system'} will be reverted
          {c.entity === 'wiki_page' && c.kind === 'delete'
            ? ', bringing the page back with its revisions'
            : ''}
          . The undo is recorded too and can itself be undone.
        </>
      ),
      confirmLabel: group ? 'Undo all' : 'Undo',
    });
    if (!ok) return;
    setRowErrors(({ [c.id]: _, ...rest }) => rest);
    const onError = (e: unknown) => {
      const msg = errorMessage(e);
      setRowErrors((m) => ({ ...m, [c.id]: msg }));
      showToast(`Undo failed: ${msg}`, true);
    };
    if (group)
      revertGroup.mutate(
        { groupId: group },
        {
          onSuccess: (r) => showToast(`${r.reverted} change${r.reverted === 1 ? '' : 's'} undone.`),
          onError,
        },
      );
    else
      revert.mutate({ changeId: c.id }, { onSuccess: () => showToast('Change undone.'), onError });
  };

  const capped = (changes.data?.length ?? 0) >= LIMIT;
  const countLabel = changes.isSuccess
    ? `${rows.length}${capped ? '+' : ''} change${rows.length === 1 ? '' : 's'}`
    : 'Changes';

  const sessionOptions: [Where, string][] = [
    ['all', 'Whole show'],
    ['show', 'Show-level only (wiki, event buttons)'],
    ...(sessionsQ.data ?? []).map((s): [Where, string] => [s.id, s.title || 'Untitled session']),
  ];
  // A session filter from a link may name a session that is not in the list (yet).
  if (!sessionOptions.some(([v]) => v === filters.where))
    sessionOptions.push([filters.where, 'Another session']);
  const whereLabel = sessionOptions.find(([v]) => v === filters.where)?.[1] ?? 'Whole show';

  const toolbar = (
    <>
      <FilterMenu
        title="Where"
        label={filters.where === 'show' ? 'Show-level only' : whereLabel}
        value={filters.where}
        options={sessionOptions}
        onChange={(where) => setFilters({ ...filters, where })}
      />
      <FilterMenu
        title="Kind"
        label={KIND_LABEL[filters.kind]}
        value={filters.kind}
        options={Object.entries(KIND_LABEL) as [Kind, string][]}
        onChange={(kind) => setFilters({ ...filters, kind })}
      />
      <FilterMenu
        title="Who"
        label={WHO_LABEL[filters.who]}
        value={filters.who}
        options={Object.entries(WHO_LABEL) as [Who, string][]}
        onChange={(who) => setFilters({ ...filters, who })}
      />
    </>
  );

  const filtered = filters.where !== 'all' || filters.kind !== 'all' || filters.who !== 'all';
  return (
    <FeedShell countLabel={countLabel} toolbar={toolbar} className="mx-0 max-md:mx-0">
      {changes.isError ? (
        <div role="alert" className="flex flex-col items-start gap-2 py-4 text-[0.85rem]">
          <p className="m-0 text-(--si-danger)">
            Could not load the change log. {errorMessage(changes.error)}
          </p>
          <Button variant="outline" onClick={() => void changes.refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <FeedTable
          columns={CHANGE_COLUMNS}
          loading={changes.isPending}
          empty={rows.length === 0}
          emptyMessage={
            filtered ? (
              <>
                No changes match these filters.{' '}
                <Button
                  variant="link"
                  className="h-auto p-0"
                  onClick={() => setFilters({ where: 'all', kind: 'all', who: 'all' })}
                >
                  Show all changes
                </Button>
              </>
            ) : (
              'Nothing has changed in this show yet.'
            )
          }
          maxHeight="md:max-h-[calc(100dvh-var(--topbar-h)-14rem)] max-md:max-h-[70dvh]"
        >
          {rows.map((c) => (
            <ChangeRow
              key={c.id}
              change={c}
              now={now}
              sec={null}
              onJump={() => {}}
              canWrite={canWrite}
              busy={
                (revert.isPending && revert.variables?.changeId === c.id) ||
                (revertGroup.isPending &&
                  !!c.groupSize &&
                  revertGroup.variables?.groupId === c.groupId)
              }
              error={rowErrors[c.id]}
              onUndo={() => void undo(c)}
              context={<ChangeContext c={c} sessions={sessions} />}
            />
          ))}
        </FeedTable>
      )}
      {capped && (
        <p className="m-0 mt-2 text-xs text-si-dim">
          Showing the newest {LIMIT}. Narrow the filters to reach older changes.
        </p>
      )}
      {confirmElement}
    </FeedShell>
  );
}

export function ChangesRoute() {
  const { show, showsLoading, canWriteShow } = useActive();
  const search = useLocationSearch();
  const [, navigate] = useLocation();
  const filters = useMemo(() => readFilters(search), [search]);

  if (showsLoading) return <RouteLoadingState label="Loading changes" />;

  return (
    <PageFrame className="max-w-[72rem] max-md:px-3">
      <div data-slot="changes-route" className="contents">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h1 className="m-0 text-[1.35rem] font-semibold text-si-fg">Changes</h1>
          {show && <p className="m-0 truncate text-sm text-si-muted">{show.name}</p>}
          <p className="m-0 mt-1 max-w-[62ch] text-[0.85rem] leading-[1.45] text-si-muted">
            Every change to this show by operators and agents, newest first — including wiki pages
            and event buttons, which belong to no session. Undo any of them; an undo is recorded
            too.
          </p>
        </div>
        {!show ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No show chosen</EmptyTitle>
              <EmptyDescription>Choose a show in the top bar to see its changes.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ChangeLog
            key={show.id}
            showId={show.id}
            canWrite={canWriteShow}
            filters={filters}
            setFilters={(f) => navigate(filtersUrl(f), { replace: true })}
          />
        )}
      </div>
    </PageFrame>
  );
}
