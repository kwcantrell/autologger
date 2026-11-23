// One Agents tab change-log row: who changed what, with jump and undo. Presentational: the change
// feed owns the data and the undo, and the landing page mock renders the same row with sample data.

import type { Change, Via } from '@autologger/contract';
import { Undo2 } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  type Column,
  FEED_CELL,
  FEED_CELL_TEXT,
  FEED_ROW,
  FEED_STACK_ROW,
  type FeedStack,
  JUMP_COLUMN,
  JumpButton,
} from '@/session/feed';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import { cn, TOUCH_HIT } from '@/shared/lib/utils';

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
  session: 'session clock',
};

export const CHANGE_COLUMNS: Column[] = [
  JUMP_COLUMN,
  { key: 'time', label: 'Time', className: 'w-24' },
  { key: 'who', label: 'Who', className: 'w-48' },
  { key: 'what', label: 'Change', className: 'w-36' },
  { key: 'summary', label: 'Summary' },
  { key: 'undo', label: 'Undo', className: 'w-28', srOnly: true },
];
/** FeedTable `stack` for ChangeRow: its meta columns need ~30rem, so it stacks below 48rem. */
export const CHANGE_STACK: FeedStack = 'wide';

const RTF = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' });
export function fmtRelative(iso: string, now: number): string {
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  const a = Math.abs(s);
  if (a < 45) return 'just now';
  if (a < 3600) return RTF.format(Math.round(s / 60), 'minute');
  if (a < 86_400) return RTF.format(Math.round(s / 3600), 'hour');
  if (a < 30 * 86_400) return RTF.format(Math.round(s / 86_400), 'day');
  return new Date(iso).toLocaleDateString();
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

export function ChangeRow({
  change: c,
  now,
  sec,
  onJump,
  canWrite,
  busy,
  error,
  onUndo,
  context,
}: {
  change: Change;
  now: number;
  sec: number | null;
  onJump: (sec: number) => void;
  canWrite: boolean;
  busy: boolean;
  error: string | undefined;
  onUndo: () => void;
  /** Where the change happened (the show change log names the session or wiki page). */
  context?: ReactNode;
}) {
  const isAgent = c.via === 'mcp';
  return (
    // Stacked: time, change kind and undo on the meta line, then who, then the summary.
    <tr
      className={cn(
        FEED_ROW,
        FEED_STACK_ROW.wide,
        '@max-3xl/feed:grid-cols-[2rem_auto_minmax(0,1fr)_auto]',
        c.revertedAt && 'opacity-60',
      )}
    >
      <td
        className={cn(
          FEED_CELL,
          'w-8 @max-3xl/feed:col-start-1 @max-3xl/feed:row-span-3 @max-3xl/feed:row-start-1 @max-3xl/feed:self-start',
        )}
      >
        <JumpButton sec={sec} label={c.summary} onJump={onJump} />
      </td>
      <td
        className={cn(
          FEED_CELL,
          'whitespace-nowrap text-si-muted tabular-nums @max-3xl/feed:col-start-2 @max-3xl/feed:row-start-1',
        )}
      >
        <time dateTime={c.at} title={c.at}>
          {fmtRelative(c.at, now)}
        </time>
      </td>
      <td
        className={cn(
          FEED_CELL,
          FEED_CELL_TEXT,
          '@max-3xl/feed:col-[2/-1] @max-3xl/feed:row-start-2',
        )}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <span className="truncate font-semibold">{c.actor?.name ?? 'System'}</span>
          {isAgent && c.clientName && (
            <SmallBadge
              className="border-[color-mix(in_oklab,var(--si-accent)_45%,var(--si-line))] text-(--si-accent-text) @max-3xl/feed:max-w-full @max-3xl/feed:whitespace-normal @max-3xl/feed:[overflow-wrap:anywhere]"
              title={`MCP client: ${c.clientName}`}
            >
              {c.clientName}
            </SmallBadge>
          )}
          <SmallBadge>{VIA_LABEL[c.via]}</SmallBadge>
        </div>
      </td>
      <td
        className={cn(
          FEED_CELL,
          'whitespace-nowrap text-si-muted @max-3xl/feed:col-start-3 @max-3xl/feed:row-start-1 @max-3xl/feed:whitespace-normal',
        )}
      >
        <span className="font-semibold text-si-fg">{c.kind}</span>{' '}
        {ENTITY_LABEL[c.entity] ?? c.entity}
      </td>
      <td
        className={cn(
          FEED_CELL,
          FEED_CELL_TEXT,
          'py-1 @max-3xl/feed:col-[2/-1] @max-3xl/feed:row-start-3 @max-3xl/feed:pt-0',
        )}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {c.revertOf && <SmallBadge title="This change undid an earlier one">undo</SmallBadge>}
          {c.groupSize && (
            <SmallBadge
              title={`One ${c.op} call: ${c.groupSize} changes here${c.groupTotal ? ` (${c.groupTotal} in all sessions)` : ''}, newest shown${c.groupUndone ? `; ${c.groupUndone} already undone` : ''}`}
            >
              {c.groupTotal ? `${c.groupSize} of ${c.groupTotal}` : c.groupSize} changes
              {c.groupUndone ? ` · ${c.groupUndone} undone` : ''}
            </SmallBadge>
          )}
          <span className="[overflow-wrap:anywhere]">
            {c.summary}
            {(c.groupSize ?? 0) > 1 && (
              <span className="text-si-muted"> and {(c.groupSize ?? 1) - 1} more</span>
            )}
          </span>
        </div>
        {context && <div className="mt-0.5 text-[0.72rem] text-si-muted">{context}</div>}
        {error && (
          <p role="alert" className="m-0 mt-0.5 text-[0.75rem] text-(--si-danger)">
            {error}
          </p>
        )}
      </td>
      <td
        className={cn(
          FEED_CELL,
          'whitespace-nowrap text-right @max-3xl/feed:col-start-4 @max-3xl/feed:row-start-1',
        )}
      >
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
              className={cn('relative', TOUCH_HIT)}
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
