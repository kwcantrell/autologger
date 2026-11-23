// `/changes`: the active show's change log — every change in any of its sessions plus the
// show-level ones no session's Agents tab lists (wiki pages, event buttons) — with the same
// Undo / Undo all flow. Filters live in the URL (?where=show|<sessionId>&kind=<entity>&who=…, who
// being all / mcp / operators / mcp:<clientName> / companion:<device name>), so the Wiki links here with show-level wiki
// changes preselected. All filters run on the server. Session content rows jump to their moment
// (changes.list atSec). New entries arrive as show-socket hints (liveShow.ts).

import type { Change, ChangeEntity, Session } from '@autologger/contract';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useSearch as useLocationSearch } from 'wouter';
import {
  type ShowChangesFilter,
  useOpMutation,
  useSessions,
  useShow,
  useShowChanges,
} from '@/api/queries';
import { errorMessage } from '@/api/rpc';
import { useActive } from '@/app/useActive';
import { PageFrame, RouteLoadingState } from '@/components/RouteState';
import { settingsOpen } from '@/lib/store';
import { FeedShell, FeedTable, IconFilter } from '@/session/feed';
import { CHANGE_COLUMNS, CHANGE_STACK, ChangeRow } from '@/session/tabs/ChangeRow';
import { useRowErrors } from '@/session/tabs/rowErrors';
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
import { LoadErrorAlert } from '@/shared/ui/LoadErrorAlert';
import { Tooltip } from '@/shared/ui/Tooltip';
import { wikiHref } from '../wiki/wikiShared';

const LIMIT = 300;

/** `mcp:<clientName>`: one MCP client; `companion:<name>`: one Companion device. */
type Who = 'all' | 'mcp' | 'operators' | `mcp:${string}` | `companion:${string}`;
const WHO_LABEL: Record<'all' | 'mcp' | 'operators', string> = {
  all: 'Everyone',
  mcp: 'Agents only',
  operators: 'Operators',
};
const CLIENT_PREFIX = 'mcp:';
const DEVICE_PREFIX = 'companion:';
const whoLabel = (who: Who) =>
  who.startsWith(CLIENT_PREFIX)
    ? `Agent: ${who.slice(CLIENT_PREFIX.length)}`
    : who.startsWith(DEVICE_PREFIX)
      ? `Device: ${who.slice(DEVICE_PREFIX.length)}`
      : WHO_LABEL[who as keyof typeof WHO_LABEL];
const isNamed = (who: string, prefix: string) =>
  who.startsWith(prefix) && who.length > prefix.length;

function whoFilter(who: Who): Pick<ShowChangesFilter, 'via' | 'clientName'> {
  if (who === 'mcp') return { via: 'mcp' };
  if (who === 'operators') return { via: ['web', 'companion'] };
  if (who.startsWith(CLIENT_PREFIX))
    return { via: 'mcp', clientName: who.slice(CLIENT_PREFIX.length) };
  if (who.startsWith(DEVICE_PREFIX))
    return { via: 'companion', clientName: who.slice(DEVICE_PREFIX.length) };
  return {};
}

const sessionHref = (id: string, sec?: number) =>
  `/sessions/${encodeURIComponent(id)}${sec == null ? '' : `?t=${Math.round(sec * 100) / 100}`}`;

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
  audio_segment: 'Recording status',
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
    who:
      who && (who in WHO_LABEL || isNamed(who, CLIENT_PREFIX) || isNamed(who, DEVICE_PREFIX))
        ? (who as Who)
        : 'all',
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
      <Tooltip content={`${title}: ${label}`}>
        <DropdownMenuTrigger render={<Button variant="glass" />}>
          {/* Three filters side by side: phones keep the labels too, or the icons look alike. */}
          <IconFilter />
          <span className="max-w-[11rem] truncate max-md:max-w-[8rem]">{label}</span>
        </DropdownMenuTrigger>
      </Tooltip>
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
      <Link href={sessionHref(s.id, c.atSec)} className={link}>
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
        <Button
          variant="link"
          size="inline"
          className={`${link} no-underline`}
          onClick={() => settingsOpen.set('event-buttons')}
        >
          Event buttons
        </Button>
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
  const showQ = useShow(showId);
  const [, navigate] = useLocation();
  const query: ShowChangesFilter = {
    ...(filters.where === 'all'
      ? {}
      : { sessionId: filters.where === 'show' ? null : filters.where }),
    ...(filters.kind === 'all' ? {} : { entity: filters.kind }),
    ...whoFilter(filters.who),
  };
  const changes = useShowChanges(showId, query);
  // The change hint refetches the list, not the show: when a new agent or device turns up in it,
  // refetch shows.get so the Who filter lists it.
  const refetchShow = showQ.refetch;
  useEffect(() => {
    const show = showQ.data;
    if (!show || !changes.data) return;
    const unknown = changes.data.some(
      (c) =>
        c.clientName != null &&
        ((c.via === 'mcp' && !show.mcpClients.includes(c.clientName)) ||
          (c.via === 'companion' && !show.companionDevices.includes(c.clientName))),
    );
    if (unknown) void refetchShow();
  }, [changes.data, showQ.data, refetchShow]);
  const now = useNow();
  const { confirm, confirmElement } = useConfirm();
  const [rowErrors, setRowError] = useRowErrors(changes.data);
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

  const rows = changes.data ?? [];

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
    setRowError(c.id, undefined);
    const onError = (e: unknown) => {
      const msg = errorMessage(e);
      setRowError(c.id, msg);
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
  const whoOptions: [Who, string][] = [
    ...(Object.entries(WHO_LABEL) as [Who, string][]),
    ...(showQ.data?.mcpClients ?? []).map((n): [Who, string] => [`mcp:${n}`, `Agent: ${n}`]),
    ...(showQ.data?.companionDevices ?? []).map((n): [Who, string] => [
      `companion:${n}`,
      `Device: ${n}`,
    ]),
  ];
  // A client from a link may have no changes in this show (yet).
  if (!whoOptions.some(([v]) => v === filters.who))
    whoOptions.push([filters.who, whoLabel(filters.who)]);

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
        label={whoLabel(filters.who)}
        value={filters.who}
        options={whoOptions}
        onChange={(who) => setFilters({ ...filters, who })}
      />
    </>
  );

  const filtered = filters.where !== 'all' || filters.kind !== 'all' || filters.who !== 'all';
  return (
    <FeedShell countLabel={countLabel} toolbar={toolbar} className="mx-0 max-md:mx-0">
      {changes.isError ? (
        <LoadErrorAlert
          title="Couldn’t load the change log"
          onRetry={() => void changes.refetch()}
          retrying={changes.isRefetching}
        >
          {errorMessage(changes.error)}
        </LoadErrorAlert>
      ) : (
        <FeedTable
          columns={CHANGE_COLUMNS}
          stack={CHANGE_STACK}
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
              sec={c.sessionId && sessions.has(c.sessionId) ? (c.atSec ?? null) : null}
              onJump={(sec) => c.sessionId && navigate(sessionHref(c.sessionId, sec))}
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
