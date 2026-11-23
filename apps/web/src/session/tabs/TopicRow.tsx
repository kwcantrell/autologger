// One Topics tab row (a chapter). Presentational: TopicsTab owns the data, saving and deleting,
// and the landing page mock renders the same row with sample data.

import type { OpInput, Topic } from '@autologger/contract';
import { Trash2 } from 'lucide-react';
import { fmtSec } from '@/lib/timecode';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import { cn } from '@/shared/lib/utils';
import {
  type Column,
  FEED_CELL,
  FEED_CELL_TEXT,
  FEED_INLINE_INPUT,
  FEED_ROW,
  FEED_TC,
  FEED_TEXTAREA,
  JUMP_COLUMN,
  JumpButton,
} from '../feed';
import { ChangedElsewhere, type ServerDraft, useServerDraft } from '../serverDraft';

export const TOPIC_COLUMNS: Column[] = [
  JUMP_COLUMN,
  { key: 'time', label: 'Session Time', className: 'w-[6.5rem]' },
  { key: 'dur', label: 'Duration (s)', className: 'w-24 max-md:hidden' },
  { key: 'level', label: 'Level', className: 'w-16 max-md:hidden' },
  { key: 'summary', label: 'Topic', className: 'min-w-56' },
  { key: 'actions', label: 'Actions', srOnly: true, className: 'w-8' },
];

function parseClock(s: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export function TopicRow({
  t,
  canWrite,
  rolling,
  onJump,
  onSave,
  onDelete,
}: {
  t: Topic;
  canWrite: boolean;
  rolling: boolean;
  onJump: (s: number) => void;
  /** Saves an edit; rejects when it failed (the caller reports why) and the row resets. */
  onSave: (patch: Omit<OpInput<'topics.update'>, 'topicId'>) => Promise<unknown>;
  onDelete: () => void;
}) {
  // Each field follows the server until the user edits it; remote changes then don't overwrite
  // the draft (#231).
  const start = useServerDraft(fmtSec(t.startSec));
  const dur = useServerDraft(String(Math.round(t.durationSec)));
  const level = useServerDraft(String(t.level));
  const title = useServerDraft(t.title);
  const summary = useServerDraft(t.summary);
  const conflicts = [start, dur, level, title, summary].filter((f) => f.conflict);
  const revertOnEsc = (f: ServerDraft) => (e: { key: string }) => {
    if (e.key === 'Escape') f.reset();
  };

  const ro = !canWrite;
  return (
    <tr className={cn(FEED_ROW, 'group')}>
      <td className={cn(FEED_CELL, 'align-top pt-1')}>
        <JumpButton
          sec={t.startSec}
          label={fmtSec(t.startSec)}
          onJump={onJump}
          unavailable={rolling ? 'Playback is off while timecode rolls.' : null}
        />
      </td>
      <td className={cn(FEED_CELL, FEED_TC, 'align-top')}>
        <input
          className={cn(FEED_INLINE_INPUT, 'tabular-nums')}
          aria-label="Start time"
          readOnly={ro}
          value={start.value}
          onChange={(e) => start.set(e.target.value)}
          onKeyDown={revertOnEsc(start)}
          onBlur={(e) => {
            if (start.keepOnWindowBlur(e.target)) return;
            const sec = parseClock(start.value);
            if (sec == null || sec === Math.floor(t.startSec)) return start.reset();
            void start.commit(fmtSec(sec), () => onSave({ startSec: sec }));
          }}
        />
        <span className="block px-[0.3rem] text-[0.68rem] text-si-dim md:hidden">
          Duration {Math.round(t.durationSec)}s · Level {t.level}
        </span>
      </td>
      <td className={cn(FEED_CELL, FEED_CELL_TEXT, 'align-top max-md:hidden')}>
        <input
          className={cn(FEED_INLINE_INPUT, 'tabular-nums')}
          type="number"
          min={0}
          aria-label="Duration in seconds"
          readOnly={ro}
          value={dur.value}
          onChange={(e) => dur.set(e.target.value)}
          onKeyDown={revertOnEsc(dur)}
          onBlur={(e) => {
            if (dur.keepOnWindowBlur(e.target)) return;
            const n = Number(dur.value);
            if (Number.isFinite(n) && n >= 0 && Math.round(n) !== Math.round(t.durationSec))
              void dur.commit(String(Math.round(n)), () => onSave({ durationSec: n }));
            else dur.reset();
          }}
        />
      </td>
      <td className={cn(FEED_CELL, FEED_CELL_TEXT, 'align-top max-md:hidden')}>
        <input
          className={cn(FEED_INLINE_INPUT, 'tabular-nums')}
          type="number"
          min={1}
          max={3}
          aria-label="Level"
          readOnly={ro}
          value={level.value}
          onChange={(e) => level.set(e.target.value)}
          onKeyDown={revertOnEsc(level)}
          onBlur={(e) => {
            if (level.keepOnWindowBlur(e.target)) return;
            const n = Number(level.value);
            if ([1, 2, 3].includes(n) && n !== t.level)
              void level.commit(String(n), () => onSave({ level: n }));
            else level.reset();
          }}
        />
      </td>
      <td className={cn(FEED_CELL, FEED_CELL_TEXT, 'align-top py-0.5')}>
        <span
          className={cn('flex items-center gap-1.5', conflicts.length > 0 && 'max-md:flex-wrap')}
        >
          <input
            className={cn(
              FEED_INLINE_INPUT,
              'font-semibold',
              conflicts.length > 0 && 'max-md:basis-full',
            )}
            aria-label="Title"
            readOnly={ro}
            value={title.value}
            onChange={(e) => title.set(e.target.value)}
            onKeyDown={revertOnEsc(title)}
            onBlur={(e) => {
              if (title.keepOnWindowBlur(e.target)) return;
              const v = title.value.trim();
              if (v && v !== t.title) void title.commit(v, () => onSave({ title: v }));
              else title.reset();
            }}
          />
          {conflicts.length > 0 && (
            <ChangedElsewhere
              remote={conflicts.map((f) => f.server).join(' · ')}
              onTakeTheirs={() => {
                for (const f of conflicts) f.reset();
              }}
            />
          )}
          {t.via === 'mcp' && (
            <Badge
              variant="outline"
              className="shrink-0 px-1 py-px text-[0.6rem]"
              title={`Written by an agent${t.createdBy ? ` acting as ${t.createdBy.name}` : ''}`}
            >
              agent
            </Badge>
          )}
        </span>
        <textarea
          className={cn(FEED_INLINE_INPUT, FEED_TEXTAREA, 'text-si-muted')}
          aria-label="Summary"
          placeholder={ro ? '' : 'Summary'}
          readOnly={ro}
          rows={1}
          value={summary.value}
          onChange={(e) => summary.set(e.target.value)}
          onKeyDown={revertOnEsc(summary)}
          onBlur={(e) => {
            if (summary.keepOnWindowBlur(e.target)) return;
            if (summary.value === t.summary) return summary.reset();
            void summary.commit(summary.value, (v) => onSave({ summary: v }));
          }}
        />
      </td>
      <td className={cn(FEED_CELL, 'align-top pt-1')}>
        {canWrite && (
          <Button
            variant="unstyled"
            aria-label="Delete topic"
            title="Delete topic"
            className="inline-flex size-6 items-center justify-center rounded-[0.35rem] text-si-dim opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover-always:text-si-danger max-md:opacity-100"
            onClick={onDelete}
          >
            <Trash2 className="size-3" aria-hidden="true" />
          </Button>
        )}
      </td>
    </tr>
  );
}
