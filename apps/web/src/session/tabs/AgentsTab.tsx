// Agents tab: how to connect an MCP agent, and the session's change log with undo.

import type { Change, Session, Via } from '@autologger/contract';
import type { QueryKey } from '@tanstack/react-query';
import { Copy, Undo2 } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import {
  qk,
  useCapabilities,
  useChanges,
  useEvents,
  useOpMutation,
  useTopics,
} from '@/api/queries';
import { errorMessage } from '@/api/rpc';
import { settingsOpen } from '@/lib/store';
import { eventSec } from '@/lib/timecode';
import { useWorkspace } from '@/session/context';
import {
  type Column,
  FEED_CELL,
  FEED_CELL_TEXT,
  FEED_ROW,
  FeedShell,
  FeedTable,
  IconFilter,
  JUMP_COLUMN,
  JumpButton,
  ToolbarCaption,
} from '@/session/feed';
import { showToast } from '@/shared/components/Toast';
import { Badge } from '@/shared/components/ui/badge';
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
import { cn } from '@/shared/lib/utils';
import { useConfirm } from '@/shared/ui/ConfirmDialog';

type Filter = 'all' | 'mcp' | 'operators';
const FILTER_LABEL: Record<Filter, string> = {
  all: 'All changes',
  mcp: 'Agents only',
  operators: 'Operators',
};
const EMPTY: Record<Filter, string> = {
  all: 'Nothing has changed in this session yet.',
  mcp: 'No agent has changed this session yet.',
  operators: 'No operator changes in this session yet.',
};
const VIA_LABEL: Record<Via, string> = {
  web: 'web',
  mcp: 'agent',
  companion: 'companion',
  worker: 'worker',
  system: 'system',
};
const ENTITY_LABEL: Record<Change['entity'], string> = {
  event: 'event',
  topic: 'topic',
  transcript_segment: 'transcript',
  dashboard: 'dashboard',
  wiki_page: 'wiki page',
  category: 'category',
};
const LIMIT = 300;

const COLUMNS: Column[] = [
  JUMP_COLUMN,
  { key: 'time', label: 'Time', className: 'w-24' },
  { key: 'who', label: 'Who', className: 'w-48' },
  { key: 'what', label: 'Change', className: 'w-36' },
  { key: 'summary', label: 'Summary' },
  { key: 'undo', label: 'Undo', className: 'w-28', srOnly: true },
];

// ── relative time ───────────────────────────────────────────────────

const RTF = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' });
function fmtRelative(iso: string, now: number): string {
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  const a = Math.abs(s);
  if (a < 45) return 'just now';
  if (a < 3600) return RTF.format(Math.round(s / 60), 'minute');
  if (a < 86_400) return RTF.format(Math.round(s / 3600), 'hour');
  if (a < 30 * 86_400) return RTF.format(Math.round(s / 86_400), 'day');
  return new Date(iso).toLocaleDateString();
}
function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// ── tab ─────────────────────────────────────────────────────────────

export function AgentsTab({ session }: { session: Session }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <ConnectCard />
      <ChangeFeed session={session} />
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="font-label text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-si-dim">
        {label}
      </span>
      <div className="flex min-w-0 items-center gap-2">
        <code
          className="min-w-0 flex-1 truncate rounded-ctl border border-si-line bg-si-bg px-2.5 py-1.5 font-tc text-[0.78rem] text-si-fg"
          title={value}
        >
          {value}
        </code>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Copy ${label}`}
          onClick={() => {
            navigator.clipboard.writeText(value).then(
              () => showToast('Copied.'),
              () => showToast('Could not copy to the clipboard.', true),
            );
          }}
        >
          <Copy aria-hidden="true" />
          Copy
        </Button>
      </div>
    </div>
  );
}

function ConnectCard() {
  const caps = useCapabilities();
  const base = caps.data?.publicUrl.replace(/\/+$/, '');
  const mcpUrl = base ? `${base}/mcp` : null;
  return (
    <section
      aria-labelledby="agents-connect-title"
      className="mx-4 flex min-w-0 flex-col gap-3 rounded-card border border-si-line bg-si-panel px-6 py-4 max-md:mx-3 max-md:px-3"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2
            id="agents-connect-title"
            className="m-0 font-ui text-[1.25rem] font-semibold leading-tight text-si-fg"
          >
            Connect an agent
          </h2>
          <p className="m-0 mt-1 max-w-[60ch] text-[0.85rem] leading-[1.45] text-si-muted">
            Agents like Claude Code, claude.ai or Claude Desktop connect over MCP and act as you.
            Every change they make appears below and can be undone.
          </p>
        </div>
        <Button variant="link" className="px-0" onClick={() => settingsOpen.set('agents')}>
          Settings → Agents
        </Button>
      </div>
      {mcpUrl ? (
        <div className="grid min-w-0 gap-3 md:grid-cols-2">
          <CopyRow label="MCP URL" value={mcpUrl} />
          <CopyRow
            label="Claude Code"
            value={`claude mcp add --transport http autologger ${mcpUrl}`}
          />
        </div>
      ) : caps.isError ? (
        <p role="alert" className="m-0 text-[0.85rem] text-(--si-danger)">
          Could not load the server address. {errorMessage(caps.error)}
        </p>
      ) : (
        <p className="m-0 text-[0.85rem] text-si-muted">Loading…</p>
      )}
    </section>
  );
}

function ChangeFeed({ session }: { session: Session }) {
  const { canWrite, seek } = useWorkspace();
  const [filter, setFilter] = useState<Filter>('all');
  const changes = useChanges(session.id, filter === 'mcp' ? 'mcp' : 'all');
  const events = useEvents(session.id);
  const topics = useTopics(session.id);
  const now = useNow();
  const { confirm, confirmElement } = useConfirm();
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const revert = useOpMutation('changes.revert', {
    invalidate: (c) => {
      const keys: QueryKey[] = [qk.changesAll(session.id)];
      if (c.entity === 'dashboard') keys.push(qk.dashboards(session.id));
      if (c.entity === 'event') keys.push(qk.events(session.id));
      if (c.entity === 'topic') keys.push(qk.topics(session.id));
      if (c.entity === 'transcript_segment') keys.push(qk.transcript(session.id));
      return keys;
    },
  });
  // A folded row stands for one op call; its changes may touch several kinds of content.
  const revertGroup = useOpMutation('changes.revertGroup', {
    invalidate: () => [
      qk.changesAll(session.id),
      qk.dashboards(session.id),
      qk.events(session.id),
      qk.topics(session.id),
      qk.transcript(session.id),
    ],
  });

  const rows = useMemo(() => {
    const all = changes.data ?? [];
    return filter === 'operators'
      ? all.filter((c) => c.via === 'web' || c.via === 'companion')
      : all;
  }, [changes.data, filter]);

  const secOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of events.data ?? []) {
      const s = eventSec(e.timecodeFrames, session);
      if (s != null) m.set(`event:${e.id}`, s);
    }
    for (const t of topics.data ?? []) m.set(`topic:${t.id}`, t.startSec);
    return m;
  }, [events.data, topics.data, session]);

  const undo = async (c: Change) => {
    const group = c.groupSize && c.groupId ? c.groupId : null;
    const left = (c.groupSize ?? 1) - (c.groupUndone ?? 0);
    const ok = await confirm({
      title: group ? `Undo all ${left} changes?` : 'Undo this change?',
      message: group ? (
        <>
          Everything this {c.op} call by {c.actor?.name ?? 'the system'} changed will be reverted in
          one step ({left} change{left === 1 ? '' : 's'}, e.g. “{c.summary}”). If any of it changed
          again since, nothing is undone. The undo is recorded too and can itself be undone.
        </>
      ) : (
        <>
          “{c.summary}” by {c.actor?.name ?? 'the system'} will be reverted. The undo is recorded
          too and can itself be undone.
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
  const n = `${rows.length}${capped ? '+' : ''}`;
  const countLabel = !changes.isSuccess
    ? 'Changes'
    : filter === 'mcp'
      ? `${n} agent action${rows.length === 1 ? '' : 's'}`
      : `${n} change${rows.length === 1 ? '' : 's'}`;

  const toolbar = (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="glass" title="Filter changes" />}>
        <ToolbarCaption label={FILTER_LABEL[filter]} icon={<IconFilter />} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Show</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={filter} onValueChange={(v: Filter) => setFilter(v)}>
            {(Object.keys(FILTER_LABEL) as Filter[]).map((f) => (
              <DropdownMenuRadioItem key={f} value={f}>
                {FILTER_LABEL[f]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <FeedShell countLabel={countLabel} toolbar={toolbar}>
      {changes.isError ? (
        <p role="alert" className="m-0 py-4 text-[0.85rem] text-(--si-danger)">
          Could not load the change log. {errorMessage(changes.error)}
        </p>
      ) : (
        <FeedTable
          columns={COLUMNS}
          loading={changes.isPending}
          empty={rows.length === 0}
          emptyMessage={EMPTY[filter]}
        >
          {rows.map((c) => (
            <ChangeRow
              key={c.id}
              change={c}
              now={now}
              sec={secOf.get(`${c.entity}:${c.entityId}`) ?? null}
              onJump={(s) => seek(s, true)}
              canWrite={canWrite}
              busy={
                (revert.isPending && revert.variables?.changeId === c.id) ||
                (revertGroup.isPending &&
                  !!c.groupSize &&
                  revertGroup.variables?.groupId === c.groupId)
              }
              error={rowErrors[c.id]}
              onUndo={() => void undo(c)}
            />
          ))}
        </FeedTable>
      )}
      {confirmElement}
    </FeedShell>
  );
}

function SmallBadge({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <Badge variant="outline" title={title} className={cn('px-1 py-0 text-[0.6rem]', className)}>
      {children}
    </Badge>
  );
}

function ChangeRow({
  change: c,
  now,
  sec,
  onJump,
  canWrite,
  busy,
  error,
  onUndo,
}: {
  change: Change;
  now: number;
  sec: number | null;
  onJump: (sec: number) => void;
  canWrite: boolean;
  busy: boolean;
  error: string | undefined;
  onUndo: () => void;
}) {
  const isAgent = c.via === 'mcp';
  return (
    <tr className={cn(FEED_ROW, c.revertedAt && 'opacity-60')}>
      <td className={cn(FEED_CELL, 'w-8')}>
        <JumpButton sec={sec} label={c.summary} onJump={onJump} />
      </td>
      <td className={cn(FEED_CELL, 'whitespace-nowrap text-si-muted tabular-nums')}>
        <time dateTime={c.at} title={c.at}>
          {fmtRelative(c.at, now)}
        </time>
      </td>
      <td className={cn(FEED_CELL, FEED_CELL_TEXT)}>
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <span className="truncate font-semibold">{c.actor?.name ?? 'System'}</span>
          {isAgent && c.clientName && (
            <SmallBadge
              className="border-[color-mix(in_oklab,var(--si-accent)_45%,var(--si-line))] text-(--si-accent-text)"
              title={`MCP client: ${c.clientName}`}
            >
              {c.clientName}
            </SmallBadge>
          )}
          <SmallBadge>{VIA_LABEL[c.via]}</SmallBadge>
        </div>
      </td>
      <td className={cn(FEED_CELL, 'whitespace-nowrap text-si-muted')}>
        <span className="font-semibold text-si-fg">{c.kind}</span>{' '}
        {ENTITY_LABEL[c.entity] ?? c.entity}
      </td>
      <td className={cn(FEED_CELL, FEED_CELL_TEXT, 'py-1')}>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {c.revertOf && <SmallBadge title="This change undid an earlier one">undo</SmallBadge>}
          {c.groupSize && (
            <SmallBadge
              title={`One ${c.op} call: ${c.groupSize} changes, newest shown${c.groupUndone ? `; ${c.groupUndone} already undone` : ''}`}
            >
              {c.groupSize} changes{c.groupUndone ? ` · ${c.groupUndone} undone` : ''}
            </SmallBadge>
          )}
          <span className="[overflow-wrap:anywhere]">
            {c.summary}
            {c.groupSize && <span className="text-si-muted"> and {c.groupSize - 1} more</span>}
          </span>
        </div>
        {error && (
          <p role="alert" className="m-0 mt-0.5 text-[0.75rem] text-(--si-danger)">
            {error}
          </p>
        )}
      </td>
      <td className={cn(FEED_CELL, 'whitespace-nowrap text-right')}>
        {c.revertedAt ? (
          <span className="text-[0.75rem] text-si-dim" title={c.revertedAt}>
            Undone {fmtRelative(c.revertedAt, now)}
          </span>
        ) : (
          // The wrapper carries the reason: a disabled button gets no pointer events (no title).
          <span
            className="inline-flex"
            title={canWrite ? undefined : "Read-only: you can't change this show's content"}
          >
            <Button
              variant="ghost"
              size="xs"
              onClick={onUndo}
              disabled={!canWrite || busy}
              title={
                !canWrite
                  ? undefined
                  : c.groupSize
                    ? 'Undo every change of this call'
                    : 'Undo this change'
              }
            >
              <Undo2 aria-hidden="true" />
              {busy ? 'Undoing…' : c.groupSize ? 'Undo all' : 'Undo'}
            </Button>
          </span>
        )}
      </td>
    </tr>
  );
}
