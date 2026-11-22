import type { Category, Session, SessionEvent } from '@autologger/contract';
import type { UseQueryResult } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage, type RpcError, rpc } from '@/api/rpc';
import { eventSec, formatFrames, parseTimecode } from '@/lib/timecode';
import { showToast } from '@/shared/components/Toast';
import { Badge } from '@/shared/components/ui/badge';
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
import { cn } from '@/shared/lib/utils';
import { useConfirm } from '@/shared/ui/ConfirmDialog';
import { formatWallUtcYmdHms } from '@/shared/utils/timecode';
import { useWorkspace } from '../context';
import {
  FEED_CELL,
  FEED_CELL_LABEL,
  FEED_CELL_TEXT,
  FEED_INLINE_INPUT,
  FEED_ROW,
  FEED_TC,
  FeedShell,
  FeedTable,
  feedCountLabel,
  IconCheck,
  IconClock,
  IconFilter,
  IconPencil,
  JUMP_COLUMN,
  JumpButton,
  ToolbarCaption,
} from '../feed';

type TimeMode = 'session' | 'world';

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
          columns={[
            JUMP_COLUMN,
            {
              key: 'time',
              label: timeMode === 'session' ? 'Session Time' : 'World Clock',
              className: 'w-[6.5rem]',
            },
            { key: 'event', label: 'Event', className: 'w-32 max-md:hidden' },
            { key: 'message', label: 'Message' },
            { key: 'actions', label: 'Actions', srOnly: true, className: 'w-8' },
          ]}
          loading={events.isPending}
          empty={shown.length === 0}
          emptyMessage={
            list.length === 0
              ? session.isRolling
                ? 'No events yet. Press an event button (or 1–9) to log one.'
                : '— No logged items yet. Roll timecode to log, or let an agent add events over MCP.'
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
              onDelete={() => void remove(e)}
            />
          ))}
        </FeedTable>
      )}
      {confirmElement}
    </FeedShell>
  );
}

function EventRow({
  e,
  session,
  categories,
  timeMode,
  editable,
  canWrite,
  rowRef,
  onJump,
  onDelete,
}: {
  e: SessionEvent;
  session: Session;
  categories: Category[];
  timeMode: TimeMode;
  editable: boolean;
  canWrite: boolean;
  rowRef: (el: HTMLTableRowElement | null) => void;
  onJump: (sec: number) => void;
  onDelete: () => void;
}) {
  const sec = eventSec(e.timecodeFrames, session);
  const tc = e.timecodeFrames != null ? formatFrames(e.timecodeFrames, session.frameRate) : '—';
  const timeText =
    timeMode === 'session' ? tc.replace(/[:;]\d{2}$/, '') : formatWallUtcYmdHms(e.wallTime);
  const [msg, setMsg] = useState(e.message);
  const [tcText, setTcText] = useState(tc);
  useEffect(() => setMsg(e.message), [e.message]);
  useEffect(() => setTcText(tc), [tc]);

  const save = async (patch: Parameters<typeof rpc<'events.update'>>[1]) => {
    try {
      await rpc('events.update', patch);
    } catch (err) {
      showToast(`Update failed. ${errorMessage(err)}`, true);
      setMsg(e.message);
      setTcText(tc);
    }
  };

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
            value={tcText}
            onChange={(ev) => setTcText(ev.target.value)}
            onBlur={() => {
              if (tcText === tc) return;
              if (parseTimecode(tcText, session.frameRate) == null) {
                showToast('Enter a timecode like 00:12:03:07.', true);
                setTcText(tc);
                return;
              }
              void save({ eventId: e.id, timecode: tcText.trim() });
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
              void save({
                eventId: e.id,
                categoryId: ev.target.value || null,
                ...(ev.target.value ? {} : { category: e.category }),
              })
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
        <span className="flex items-center gap-1.5">
          {editable ? (
            <input
              className={FEED_INLINE_INPUT}
              aria-label="Message"
              value={msg}
              placeholder={e.value ?? ''}
              onChange={(ev) => setMsg(ev.target.value)}
              onBlur={() => {
                if (msg !== e.message) void save({ eventId: e.id, message: msg });
              }}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur();
                if (ev.key === 'Escape') setMsg(e.message);
              }}
            />
          ) : (
            <span className="min-w-0 break-words">{messageText}</span>
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
