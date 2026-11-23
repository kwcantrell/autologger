import type { Category, OpInput, Session, SessionEvent } from '@autologger/contract';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCategories, useEvents } from '@/api/queries';
import { errorMessage, rpc } from '@/api/rpc';
import { showToast } from '@/shared/components/Toast';
import { Button } from '@/shared/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu';
import { useConfirm } from '@/shared/ui/ConfirmDialog';
import { useWorkspace } from '../context';
import {
  FeedShell,
  FeedTable,
  feedCountLabel,
  IconCheck,
  IconClock,
  IconFilter,
  IconPencil,
  ToolbarCaption,
} from '../feed';
import { EventRow, eventColumns, type TimeMode } from './EventRow';

const NO_CATEGORIES: Category[] = [];

type EventTiming = Pick<Session, 'frameRate' | 'startOffsetFrames' | 'isRolling'>;

const saveEvent = (patch: OpInput<'events.update'>) =>
  rpc('events.update', patch).catch((err) => {
    showToast(`Update failed. ${errorMessage(err)}`, true);
    throw err;
  });

/** An EventRow memoized on stable, id-based handlers: a session push doesn't re-render every row. */
const FeedEventRow = memo(function FeedEventRow({
  e,
  timing,
  categories,
  timeMode,
  editable,
  canWrite,
  setRowRef,
  onJump,
  onDelete,
}: {
  e: SessionEvent;
  timing: EventTiming;
  categories: Category[];
  timeMode: TimeMode;
  editable: boolean;
  canWrite: boolean;
  setRowRef: (id: string, el: HTMLTableRowElement | null) => void;
  onJump: (sec: number) => void;
  onDelete: (e: SessionEvent) => void;
}) {
  return (
    <EventRow
      e={e}
      session={timing}
      categories={categories}
      timeMode={timeMode}
      editable={editable}
      canWrite={canWrite}
      rowRef={(el) => setRowRef(e.id, el)}
      onJump={onJump}
      onSave={saveEvent}
      onDelete={() => onDelete(e)}
    />
  );
});

export function EventsTab({
  session,
  flash,
}: {
  session: Session;
  flash: { id: string; n: number } | null;
}) {
  const events = useEvents(session.id);
  const categories = useCategories(session.showId).data ?? NO_CATEGORIES;
  const { canWrite, seek } = useWorkspace();
  const [timeMode, setTimeMode] = useState<TimeMode>('session');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState(false);
  const { confirm, confirmElement } = useConfirm();
  const editable = canWrite && (editing || session.isRolling);

  const list = events.data ?? [];
  const labels = useMemo(
    () => [...new Set([...categories.map((c) => c.name), ...list.map((e) => e.category)])],
    [categories, list],
  );
  const shown = list.filter((e) => !hidden.has(e.category));

  // Reveal + flash a row (timeline marker clicks, search deep links), once per request: retried
  // as events load or filters change until the row exists, then never again for that `n`.
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const flashedN = useRef(0);
  useEffect(() => {
    if (!flash || flashedN.current === flash.n) return;
    // A row filtered out by category: show that category again rather than flash nothing.
    const category = events.data?.find((e) => e.id === flash.id)?.category;
    if (category != null && hidden.has(category)) {
      setHidden((h) => {
        const n = new Set(h);
        n.delete(category);
        return n;
      });
      return;
    }
    const el = rowRefs.current.get(flash.id);
    if (!el) return;
    flashedN.current = flash.n;
    el.scrollIntoView({
      block: 'center',
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
    el.classList.remove('event-row-flash');
    void el.offsetWidth;
    el.classList.add('event-row-flash');
  }, [flash, events.data, hidden]);

  const setRowRef = useCallback((id: string, el: HTMLTableRowElement | null) => {
    if (el) rowRefs.current.set(id, el);
    else rowRefs.current.delete(id);
  }, []);
  const seekAndPlay = useCallback((sec: number) => seek(sec, true), [seek]);
  const { frameRate, startOffsetFrames, isRolling } = session;
  const timing = useMemo(
    () => ({ frameRate, startOffsetFrames, isRolling }),
    [frameRate, startOffsetFrames, isRolling],
  );

  const remove = useCallback(
    async (e: SessionEvent) => {
      const ok = await confirm({
        title: 'Delete log row',
        message: 'Delete this log row? It can be restored from the Agents tab change log.',
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      try {
        await rpc('events.delete', { eventId: e.id });
      } catch (err) {
        showToast(`Delete failed. ${errorMessage(err)}`, true);
      }
    },
    [confirm],
  );

  const toolbar = (
    <>
      {canWrite && !session.isRolling && (
        <Button
          variant={editing ? 'glass-primary' : 'glass'}
          onClick={() => setEditing((v) => !v)}
          aria-pressed={editing}
        >
          <ToolbarCaption
            label={editing ? 'Done' : 'Edit'}
            icon={editing ? <IconCheck /> : <IconPencil />}
          />
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="glass" />}>
          <ToolbarCaption label="Time display" icon={<IconClock />} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Time display</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={timeMode}
              onValueChange={(v: string) => setTimeMode(v as TimeMode)}
            >
              <DropdownMenuRadioItem value="session">Session Time</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="world">World Clock (UTC)</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="glass" />}>
          <ToolbarCaption
            label={hidden.size ? `Filter (${hidden.size} hidden)` : 'Filter'}
            icon={<IconFilter />}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Show categories</DropdownMenuLabel>
            {labels.map((l) => (
              <DropdownMenuCheckboxItem
                key={l}
                checked={!hidden.has(l)}
                onCheckedChange={(c: boolean) =>
                  setHidden((h) => {
                    const n = new Set(h);
                    if (c) n.delete(l);
                    else n.add(l);
                    return n;
                  })
                }
              >
                {l}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  return (
    <FeedShell
      countLabel={feedCountLabel(list.length, 'event')}
      toolbar={toolbar}
      id="v4-log-sheet"
    >
      {events.isError ? (
        <p className="m-0 text-sm text-si-danger">
          Couldn't load the events. {errorMessage(events.error)}{' '}
          <Button variant="link" size="inline" onClick={() => void events.refetch()}>
            Try again
          </Button>
        </p>
      ) : (
        <FeedTable
          columns={eventColumns(timeMode)}
          loading={events.isPending}
          empty={shown.length === 0}
          emptyMessage={
            list.length === 0
              ? session.isRolling
                ? 'No events yet. Press an event button (or 1–9) to log one.'
                : 'No logged items yet. Roll timecode to log, or let an agent add events over MCP.'
              : 'No events match the filter.'
          }
        >
          {shown.map((e) => (
            <FeedEventRow
              key={e.id}
              e={e}
              timing={timing}
              categories={categories}
              timeMode={timeMode}
              editable={editable}
              canWrite={canWrite}
              setRowRef={setRowRef}
              onJump={seekAndPlay}
              onDelete={remove}
            />
          ))}
        </FeedTable>
      )}
      {confirmElement}
    </FeedShell>
  );
}
