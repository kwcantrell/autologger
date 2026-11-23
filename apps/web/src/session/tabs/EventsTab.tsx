import type { Category, Session, SessionEvent } from '@autologger/contract';
import type { UseQueryResult } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage, type RpcError, rpc } from '@/api/rpc';
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

export function EventsTab({
  session,
  events,
  categories,
  flash,
}: {
  session: Session;
  events: UseQueryResult<SessionEvent[], RpcError>;
  categories: Category[];
  flash: { id: string; n: number } | null;
  playheadSec: number;
}) {
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

  // Reveal + flash a row (timeline marker clicks, search deep links).
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: list.length retries the flash once the target row has loaded
  useEffect(() => {
    if (!flash) return;
    const el = rowRefs.current.get(flash.id);
    if (!el) return;
    el.scrollIntoView({
      block: 'center',
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
    el.classList.remove('event-row-flash');
    void el.offsetWidth;
    el.classList.add('event-row-flash');
  }, [flash, list.length]);

  const remove = async (e: SessionEvent) => {
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
  };

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
          <button type="button" className="underline" onClick={() => void events.refetch()}>
            Try again
          </button>
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
            <EventRow
              key={e.id}
              e={e}
              session={session}
              categories={categories}
              timeMode={timeMode}
              editable={editable}
              canWrite={canWrite}
              rowRef={(el) => {
                if (el) rowRefs.current.set(e.id, el);
                else rowRefs.current.delete(e.id);
              }}
              onJump={(sec) => seek(sec, true)}
              onSave={(patch) =>
                rpc('events.update', patch).catch((err) => {
                  showToast(`Update failed. ${errorMessage(err)}`, true);
                  throw err;
                })
              }
              onDelete={() => void remove(e)}
            />
          ))}
        </FeedTable>
      )}
      {confirmElement}
    </FeedShell>
  );
}
