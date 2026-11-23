// One Transcript tab row (a speaker turn). Presentational: TranscriptTab owns the data and
// saving, and the landing page mock renders the same row with sample data.

import type { TranscriptSegment } from '@autologger/contract';
import { PencilIcon } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { fmtSec } from '@/lib/timecode';
import { Button } from '@/shared/components/ui/button';
import { TableCell, TableRow } from '@/shared/components/ui/table';
import { Textarea } from '@/shared/components/ui/textarea';
import { cn, TOUCH_HIT } from '@/shared/lib/utils';
import { Tooltip } from '@/shared/ui/Tooltip';
import {
  type Column,
  FEED_CELL,
  FEED_CELL_LABEL,
  FEED_CELL_TEXT,
  FEED_ROW,
  FEED_STACK_ROW,
  FEED_TC,
  FEED_TEXTAREA,
  JUMP_COLUMN,
  JumpButton,
} from '../feed';
import { ChangedElsewhere, useServerDraft } from '../serverDraft';

const WORD = 'cursor-pointer rounded-[2px] hover:bg-[rgba(255,255,255,0.06)]';

export const SEGMENT_COLUMNS: Column[] = [
  JUMP_COLUMN,
  { key: 'time', label: 'Session Time', className: 'w-[6.5rem]' },
  { key: 'speaker', label: 'Speaker', className: 'w-32' },
  { key: 'text', label: 'Words' },
];

export const SegmentRow = memo(function SegmentRow({
  s,
  active,
  playheadSec,
  canWrite,
  onSeek,
  onRenameSpeaker,
  onSaveText,
}: {
  s: TranscriptSegment;
  active: boolean;
  playheadSec: number | null;
  canWrite: boolean;
  /** Seeks and plays; the workspace refuses (with a toast) while timecode rolls. */
  onSeek: (sec: number) => void;
  onRenameSpeaker: () => void;
  /** Saves edited text; rejects when it failed (the caller reports why) and the row resets. */
  onSaveText: (text: string) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  // Remote changes don't overwrite what the user is typing (#231).
  const text = useServerDraft(s.text);
  const rowRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    if (active) rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const save = async () => {
    setEditing(false);
    if (text.value.trim() === s.text) return text.reset();
    await text.commit(text.value.trim(), onSaveText);
  };

  const useWords = s.words.length > 0 && !s.edited;
  const onWordClick = (e: React.MouseEvent) => {
    const i = (e.target as HTMLElement).closest('[data-i]')?.getAttribute('data-i');
    const word = i == null ? undefined : s.words[Number(i)];
    if (word) onSeek(word.s);
  };

  return (
    <TableRow
      ref={rowRef}
      className={cn(
        FEED_ROW,
        FEED_STACK_ROW.narrow,
        'group @max-md/feed:grid-cols-[auto_auto_minmax(0,1fr)]',
        active && 'bg-(--sel-bg)',
      )}
    >
      <TableCell className={cn(FEED_CELL, 'align-top pt-1 @max-md/feed:pt-[0.1rem]')}>
        <JumpButton sec={s.startSec} label={fmtSec(s.startSec)} onJump={onSeek} />
      </TableCell>
      <TableCell className={cn(FEED_CELL, FEED_TC, 'align-top pt-1.5 @max-md/feed:pt-[0.1rem]')}>
        {fmtSec(s.startSec)}
      </TableCell>
      <TableCell
        className={cn(
          FEED_CELL,
          FEED_CELL_LABEL,
          'align-top pt-1.5 @max-md/feed:pt-[0.1rem] @max-md/feed:[overflow-wrap:anywhere]',
        )}
      >
        {canWrite ? (
          <Tooltip shared content="Rename this speaker everywhere">
            <Button
              variant="link"
              size="inline"
              className="no-underline hover:underline"
              onClick={onRenameSpeaker}
            >
              {s.speaker || 'Unknown'}
            </Button>
          </Tooltip>
        ) : (
          s.speaker || 'Unknown'
        )}
      </TableCell>
      <TableCell
        className={cn(
          FEED_CELL,
          FEED_CELL_TEXT,
          'align-top py-1 leading-[1.5] [overflow-wrap:anywhere] @max-md/feed:col-[2/-1] @max-md/feed:pt-0',
        )}
      >
        {editing ? (
          <>
            <Textarea
              variant="unstyled"
              className={cn(
                FEED_TEXTAREA,
                'w-full rounded-[3px] border border-[color-mix(in_oklab,var(--si-accent)_55%,transparent)] bg-[color-mix(in_oklab,var(--si-accent)_8%,transparent)] px-1 py-0.5 text-inherit outline-none',
              )}
              // The user just chose Edit; focus moves into the field.
              autoFocus
              aria-label="Segment text"
              value={text.value}
              onChange={(e) => text.set(e.target.value)}
              onBlur={(e) => {
                if (!text.keepOnWindowBlur(e.target)) void save();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  text.reset();
                  setEditing(false);
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  (e.target as HTMLTextAreaElement).blur();
                }
              }}
            />
            {text.conflict && <ChangedElsewhere remote={text.server} onTakeTheirs={text.reset} />}
          </>
        ) : (
          <span className="flex items-start gap-1">
            {/* Words are plain spans (two nodes each, not a button apiece: a long transcript has
                tens of thousands); one handler on the text seeks to the clicked word. Keyboard
                users seek with the row's jump button. */}
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: word seeking is a pointer shortcut; the row's JumpButton is the keyboard path */}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: see above */}
            <span className="min-w-0 flex-1" onClick={useWords ? onWordClick : undefined}>
              {useWords
                ? s.words.map((w, i) => (
                    <span
                      key={`${w.s}:${w.w}`}
                      data-i={i}
                      title={fmtSec(w.s)}
                      className={cn(
                        WORD,
                        playheadSec != null &&
                          playheadSec >= w.s &&
                          playheadSec < w.e &&
                          'bg-si-accent/35 text-si-fg',
                      )}
                    >
                      {`${w.w} `}
                    </span>
                  ))
                : s.text}
              {s.edited && <span className="ml-1 text-[0.65rem] text-si-dim">(edited)</span>}
            </span>
            {canWrite && (
              <Button
                variant="ghost"
                size="icon-xs"
                className={cn(
                  'relative max-md:mr-1 pointer-coarse:mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100 pointer-coarse:opacity-100',
                  TOUCH_HIT,
                )}
                aria-label="Edit segment"
                onClick={() => setEditing(true)}
              >
                <PencilIcon aria-hidden="true" />
              </Button>
            )}
          </span>
        )}
      </TableCell>
    </TableRow>
  );
});
