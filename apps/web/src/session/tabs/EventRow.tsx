// One Event feed row. Presentational: EventsTab owns the data, saving and deleting, and the
// landing page mock renders the same row with sample data.

import type { Category, OpInput, Session, SessionEvent } from '@autologger/contract';
import { Trash2 } from 'lucide-react';
import { eventSec, formatFrames, parseTimecode } from '@/lib/timecode';
import { showToast } from '@/shared/components/Toast';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import { cn } from '@/shared/lib/utils';
import { formatWallUtcYmdHms } from '@/shared/utils/timecode';
import {
  type Column,
  FEED_CELL,
  FEED_CELL_LABEL,
  FEED_CELL_TEXT,
  FEED_INLINE_INPUT,
  FEED_ROW,
  FEED_TC,
  JUMP_COLUMN,
  JumpButton,
} from '../feed';
import { ChangedElsewhere, useServerDraft } from '../serverDraft';

export type TimeMode = 'session' | 'world';

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

  return (
    <tr ref={rowRef} className={cn(FEED_ROW, 'group')} data-event-id={e.id}>
      <td className={cn(FEED_CELL, 'align-middle')}>
        <JumpButton
          sec={sec}
          label={timeText}
          onJump={onJump}
          unavailable={session.isRolling ? 'Playback is off while timecode rolls.' : null}
        />
      </td>
      <td className={cn(FEED_CELL, FEED_TC, 'align-middle')}>
        {editable && timeMode === 'session' ? (
          <input
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
        <span className="block text-[0.68rem] font-semibold md:hidden" style={{ color: e.color }}>
          {e.category}
        </span>
      </td>
      <td
        className={cn(FEED_CELL, FEED_CELL_LABEL, 'align-middle whitespace-nowrap max-md:hidden')}
        style={{ color: e.color }}
      >
        {editable ? (
          <select
            className={cn(FEED_INLINE_INPUT, 'bg-si-panel')}
            aria-label="Category"
            value={e.categoryId ?? ''}
            style={{ color: e.color }}
            onChange={(ev) =>
              void onSave({
                eventId: e.id,
                categoryId: ev.target.value || null,
                ...(ev.target.value ? {} : { category: e.category }),
              }).catch(() => {})
            }
          >
            {!e.categoryId && <option value="">{e.category}</option>}
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        ) : (
          e.category
        )}
      </td>
      <td
        className={cn(
          FEED_CELL,
          FEED_CELL_TEXT,
          'max-w-[min(28rem,38vw)] align-middle max-md:max-w-none',
        )}
      >
        <span
          className={cn('flex items-center gap-1.5', conflicts.length > 0 && 'max-md:flex-wrap')}
        >
          {editable ? (
            <input
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
            <span className="min-w-0 break-words">{messageText}</span>
          )}
          {editable && conflicts.length > 0 && (
            <ChangedElsewhere
              remote={conflicts.map((f) => f.server).join(' · ')}
              onTakeTheirs={() => {
                for (const f of conflicts) f.reset();
              }}
            />
          )}
          {agent && (
            <Badge
              variant="outline"
              className="shrink-0 px-1 py-px text-[0.6rem]"
              title={`Logged by an agent${e.createdBy ? ` acting as ${e.createdBy.name}` : ''}`}
            >
              agent
            </Badge>
          )}
          {e.source === 'companion' && (
            <Badge
              variant="outline"
              className="shrink-0 px-1 py-px text-[0.6rem]"
              title="Logged from a Companion device"
            >
              deck
            </Badge>
          )}
        </span>
      </td>
      <td className={cn(FEED_CELL, 'align-middle')}>
        {canWrite && (
          <Button
            variant="unstyled"
            aria-label="Delete row"
            title="Delete row"
            className="inline-flex size-6 items-center justify-center rounded-[0.35rem] text-si-dim opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover-always:bg-[color-mix(in_oklab,var(--si-danger)_12%,transparent)] hover-always:text-si-danger max-md:opacity-100"
            onClick={onDelete}
          >
            <Trash2 className="size-3" aria-hidden="true" />
          </Button>
        )}
      </td>
    </tr>
  );
}
