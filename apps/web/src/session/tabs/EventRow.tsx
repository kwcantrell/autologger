// One Event feed row. Presentational: EventsTab owns the data, saving and deleting, and the
// landing page mock renders the same row with sample data.

import type { Category, OpInput, Session, SessionEvent } from '@autologger/contract';
import { Trash2 } from 'lucide-react';
import { eventSec, formatFrames, parseTimecode } from '@/lib/timecode';
import { showToast } from '@/shared/components/Toast';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/shared/components/ui/native-select';
import { TableCell, TableRow } from '@/shared/components/ui/table';
import { cn, TOUCH_HIT } from '@/shared/lib/utils';
import { Tooltip } from '@/shared/ui/Tooltip';
import { formatWallUtcYmdHms } from '@/shared/utils/timecode';
import {
  type Column,
  FEED_CELL,
  FEED_CELL_LABEL,
  FEED_CELL_TEXT,
  FEED_INLINE_INPUT,
  FEED_ROW,
  FEED_STACK_ROW,
  FEED_TC,
  JUMP_COLUMN,
  JumpButton,
} from '../feed';
import { ChangedElsewhere, useServerDraft } from '../serverDraft';

export type TimeMode = 'session' | 'world';

const SOURCE_BADGE = 'shrink-0 px-1 py-px align-[0.1em] text-[0.6875rem]';

/** The category's colour on its own channel (DESIGN.md: a 2px swatch, never the label). */
function CategorySwatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="size-2 shrink-0 rounded-[2px]"
      style={{ backgroundColor: color }}
    />
  );
}

export function eventColumns(timeMode: TimeMode): Column[] {
  return [
    JUMP_COLUMN,
    {
      key: 'time',
      label: timeMode === 'session' ? 'Session Time' : 'World Clock',
      className: 'w-[6.5rem]',
    },
    { key: 'event', label: 'Event', className: 'w-32 max-md:hidden' },
    { key: 'message', label: 'Message' },
    { key: 'actions', label: 'Actions', srOnly: true, className: 'w-8' },
  ];
}

export function EventRow({
  e,
  session,
  categories,
  timeMode,
  editable,
  canWrite,
  rowRef,
  onJump,
  onSave,
  onDelete,
}: {
  e: SessionEvent;
  session: Pick<Session, 'frameRate' | 'startOffsetFrames' | 'isRolling'>;
  categories: Category[];
  timeMode: TimeMode;
  editable: boolean;
  canWrite: boolean;
  rowRef?: (el: HTMLTableRowElement | null) => void;
  onJump: (sec: number) => void;
  /** Saves an edit; rejects when it failed (the caller reports why) and the row resets. */
  onSave: (patch: OpInput<'events.update'>) => Promise<unknown>;
  onDelete: () => void;
}) {
  const sec = eventSec(e.timecodeFrames, session);
  const tc = e.timecodeFrames != null ? formatFrames(e.timecodeFrames, session.frameRate) : '—';
  const timeText =
    timeMode === 'session' ? tc.replace(/[:;]\d{2}$/, '') : formatWallUtcYmdHms(e.wallTime);
  // Remote changes don't overwrite what the user is typing (#231).
  const msg = useServerDraft(e.message);
  const tcText = useServerDraft(tc);
  const conflicts = [tcText, msg].filter((f) => f.conflict);

  const agent = e.source === 'agent';
  const messageText = [e.value && e.value !== e.message ? e.value : null, e.message]
    .filter(Boolean)
    .join(' — ');
  const sourceBadge = agent ? (
    <Badge
      variant="outline"
      className={SOURCE_BADGE}
      title={`Logged by an agent${e.createdBy ? ` acting as ${e.createdBy.name}` : ''}`}
    >
      agent
    </Badge>
  ) : e.source === 'companion' ? (
    <Badge variant="outline" className={SOURCE_BADGE} title="Logged from a Companion device">
      deck
    </Badge>
  ) : null;

  return (
    <TableRow
      ref={rowRef}
      className={cn(
        FEED_ROW,
        FEED_STACK_ROW.narrow,
        'group @max-md/feed:grid-cols-[auto_minmax(0,1fr)_auto]',
      )}
      data-event-id={e.id}
    >
      <TableCell className={cn(FEED_CELL, 'align-middle')}>
        <JumpButton
          sec={sec}
          label={timeText}
          onJump={onJump}
          unavailable={session.isRolling ? 'Playback is off while timecode rolls.' : null}
        />
      </TableCell>
      {/* Stacked: the time and the event label share the meta line. */}
      <TableCell
        className={cn(
          FEED_CELL,
          FEED_TC,
          'align-middle @max-md/feed:flex @max-md/feed:flex-wrap @max-md/feed:items-baseline @max-md/feed:gap-x-2',
        )}
      >
        {editable && timeMode === 'session' ? (
          <Input
            variant="unstyled"
            className={cn(FEED_INLINE_INPUT, 'min-w-[calc(11ch+0.6rem+2px)] tabular-nums')}
            aria-label="Timecode"
            value={tcText.value}
            onChange={(ev) => tcText.set(ev.target.value)}
            onBlur={(ev) => {
              if (tcText.keepOnWindowBlur(ev.target)) return;
              if (tcText.value === tc) return tcText.reset();
              if (parseTimecode(tcText.value, session.frameRate) == null) {
                showToast('Enter a timecode like 00:12:03:07.', true);
                tcText.reset();
                return;
              }
              void tcText.commit(tcText.value.trim(), (timecode) =>
                onSave({ eventId: e.id, timecode }),
              );
            }}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur();
              if (ev.key === 'Escape') tcText.reset();
            }}
          />
        ) : (
          <span
            title={timeMode === 'session' ? `${tc} · ${formatWallUtcYmdHms(e.wallTime)} UTC` : tc}
          >
            {timeText}
          </span>
        )}
        <span className="flex items-center gap-1.5 whitespace-normal font-ui text-[0.68rem] font-semibold text-si-fg md:@min-md/feed:hidden">
          <CategorySwatch color={e.color} />
          {e.category}
        </span>
      </TableCell>
      <TableCell
        className={cn(
          FEED_CELL,
          FEED_CELL_LABEL,
          'align-middle whitespace-nowrap max-md:hidden @max-md/feed:hidden',
        )}
      >
        {editable ? (
          <span className="flex items-center gap-1.5">
            <CategorySwatch color={e.color} />
            <NativeSelect
              variant="unstyled"
              className={cn(FEED_INLINE_INPUT, 'min-w-0 flex-1 bg-si-panel')}
              aria-label="Category"
              value={e.categoryId ?? ''}
              onChange={(ev) =>
                void onSave({
                  eventId: e.id,
                  categoryId: ev.target.value || null,
                  ...(ev.target.value ? {} : { category: e.category }),
                }).catch(() => {})
              }
            >
              {!e.categoryId && <NativeSelectOption value="">{e.category}</NativeSelectOption>}
              {categories.map((c) => (
                <NativeSelectOption key={c.id} value={c.id}>
                  {c.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            <CategorySwatch color={e.color} />
            {e.category}
          </span>
        )}
      </TableCell>
      <TableCell
        className={cn(
          FEED_CELL,
          FEED_CELL_TEXT,
          'max-w-[min(28rem,38vw)] align-middle max-md:max-w-none @max-md/feed:col-[2/-1] @max-md/feed:row-start-2 @max-md/feed:max-w-none',
        )}
      >
        <span
          className={cn('flex items-center gap-1.5', conflicts.length > 0 && 'max-md:flex-wrap')}
        >
          {editable ? (
            <Input
              variant="unstyled"
              className={cn(FEED_INLINE_INPUT, conflicts.length > 0 && 'max-md:basis-full')}
              aria-label="Message"
              value={msg.value}
              placeholder={e.value ?? ''}
              onChange={(ev) => msg.set(ev.target.value)}
              onBlur={(ev) => {
                if (msg.keepOnWindowBlur(ev.target)) return;
                if (msg.value === e.message) return msg.reset();
                void msg.commit(msg.value, (message) => onSave({ eventId: e.id, message }));
              }}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur();
                if (ev.key === 'Escape') msg.reset();
              }}
            />
          ) : (
            // `anywhere`, not `break-word`: only it lets a long token (a URL) shrink the cell.
            // The source badge flows inline after the text, so it stays beside the last word
            // when the message wraps instead of drifting to the cell's far edge.
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {messageText}
              {sourceBadge && <> {sourceBadge}</>}
            </span>
          )}
          {editable && conflicts.length > 0 && (
            <ChangedElsewhere
              remote={conflicts.map((f) => f.server).join(' · ')}
              onTakeTheirs={() => {
                for (const f of conflicts) f.reset();
              }}
            />
          )}
          {editable && sourceBadge}
        </span>
      </TableCell>
      <TableCell
        className={cn(FEED_CELL, 'align-middle @max-md/feed:col-start-3 @max-md/feed:row-start-1')}
      >
        {canWrite && (
          <Tooltip shared content="Delete row">
            <Button
              variant="unstyled"
              aria-label="Delete row"
              className={cn(
                'relative inline-flex size-6 max-md:mr-1 pointer-coarse:mr-1 items-center justify-center rounded-[0.35rem] text-si-dim opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover-always:bg-[color-mix(in_oklab,var(--si-danger)_12%,transparent)] hover-always:text-si-danger max-md:opacity-100 pointer-coarse:opacity-100',
                TOUCH_HIT,
              )}
              onClick={onDelete}
            >
              <Trash2 className="size-3" aria-hidden="true" />
            </Button>
          </Tooltip>
        )}
      </TableCell>
    </TableRow>
  );
}
