// The transport card (#v5-maximize-log-strip): session meta + status, the hero timecode,
// transport/marker/keyboard controls, and the lane — timeline when stopped, log buttons live.

import type { Capabilities, Category, Session, SessionEvent } from '@autologger/contract';
import { KeyboardIcon, RotateCcw } from 'lucide-react';
import { useMemo } from 'react';
import { TRANSPORT_LABEL, shortcutsOpen, type TransportTint } from '@/lib/store';
import { eventSec, fmtSec, type TransportClock } from '@/lib/timecode';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import { cn } from '@/shared/lib/utils';
import { useConfirm } from '@/shared/ui/ConfirmDialog';
import { Tooltip } from '@/shared/ui/Tooltip';
import type { Player } from './audio/usePlayer';
import { recorderSupport, type useRecorder } from './audio/useRecorder';
import { CategoryStrip } from './CategoryStrip';
import { Timeline } from './Timeline';

type Recorder = ReturnType<typeof useRecorder>;

function Glyph({ icon, size }: { icon: 'play' | 'pause' | 'record' | 'mic' | 'stop' | 'prev' | 'next'; size: number }) {
  switch (icon) {
    case 'play':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8 5.5L18.5 12L8 18.5Z" fill="currentColor" />
        </svg>
      );
    case 'pause':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <rect x="7" y="5.5" width="3.4" height="13" rx="1" fill="currentColor" />
          <rect x="13.6" y="5.5" width="3.4" height="13" rx="1" fill="currentColor" />
        </svg>
      );
    case 'record':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="5.5" fill="currentColor" />
          <circle cx="12" cy="12" r="8.25" stroke="currentColor" strokeWidth="1.5" fill="none" opacity="0.45" />
        </svg>
      );
    case 'mic':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="9.25" y="3.5" width="5.5" height="10" rx="2.75" fill="currentColor" />
          <path d="M6 11.5C6 14.8137 8.68629 17.5 12 17.5C15.3137 17.5 18 14.8137 18 11.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M12 17.5V21" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case 'stop':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <rect x="6.5" y="6.5" width="11" height="11" rx="1.75" fill="currentColor" />
        </svg>
      );
    case 'prev':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12.5 6.5L7 12L12.5 17.5M18 6.5L12.5 12L18 17.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'next':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M11.5 6.5L17 12L11.5 17.5M6 6.5L11.5 12L6 17.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
  }
}

interface Ctl {
  id: string;
  icon: Parameters<typeof Glyph>[0]['icon'];
  label: string;
  enabled: boolean;
  active?: boolean;
  rec?: boolean;
  reason?: string | null;
  onClick: () => void;
  dot?: string;
  dotSide?: 'left' | 'right';
}

function CtlButton({ c }: { c: Ctl }) {
  return (
    <Tooltip content={c.enabled ? c.label : (c.reason ?? c.label)}>
      <Button
        variant="transport"
        size="icon"
        id={c.id}
        className={cn('relative md:w-auto md:min-w-(--h-ctl) md:flex-1', !c.enabled && 'max-md:hidden')}
        data-active={c.active || undefined}
        disabled={!c.enabled}
        aria-label={c.label}
        onClick={c.onClick}
      >
        <span className={cn('pointer-events-none inline-flex items-center justify-center', c.rec && !c.active && c.enabled && 'text-(--si-rec)')}>
          <Glyph icon={c.icon} size={18} />
        </span>
        {c.dot && (
          <span
            aria-hidden="true"
            className={cn('absolute top-1/2 size-1.5 -translate-y-1/2 rounded-full', c.dotSide === 'left' ? 'left-1.5' : 'right-1.5')}
            style={{ background: c.dot }}
          />
        )}
        {!c.enabled && c.reason && <span className="sr-only">{c.reason}</span>}
      </Button>
    </Tooltip>
  );
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()}`;
}

export function TransportStrip({
  session,
  clock,
  tint,
  busy,
  canWrite,
  caps,
  categories,
  categoriesError,
  events,
  player,
  recorder,
  totalSec,
  playheadSec,
  onTransport,
  onSeek,
  onRevealEvent,
}: {
  session: Session;
  clock: TransportClock;
  tint: TransportTint;
  busy: boolean;
  canWrite: boolean;
  caps: Capabilities | undefined;
  categories: Category[];
  categoriesError: string | null;
  events: SessionEvent[];
  player: Player;
  recorder: Recorder;
  totalSec: number;
  playheadSec: number;
  onTransport: (a: 'start' | 'stop' | 'reset') => void;
  onSeek: (sec: number) => void;
  onRevealEvent: (id: string) => void;
}) {
  const { confirm, confirmElement } = useConfirm();
  const rolling = session.isRolling;
  const recording = recorder.state === 'recording' || recorder.state === 'starting' || recorder.state === 'stopping';
  const live = rolling || recording;
  const readOnly = canWrite ? null : 'Read-only: you can view this show but not log in it.';
  const hasAudio = player.segments.length > 0;

  const micReason = !canWrite
    ? readOnly
    : caps && !caps.storage
      ? "Audio storage isn't configured on this server (S3 settings), so recordings can't be saved."
      : (recorderSupport() ?? (!rolling ? 'Roll timecode first; recording follows the session clock.' : null));

  const markerSecs = useMemo(
    () =>
      events
        .map((e) => ({ id: e.id, color: e.color, sec: eventSec(e.timecodeFrames, session) }))
        .filter((m): m is { id: string; color: string; sec: number } => m.sec != null)
        .sort((a, b) => a.sec - b.sec),
    [events, session],
  );
  const prev = [...markerSecs].reverse().find((m) => m.sec < playheadSec - 0.25);
  const next = markerSecs.find((m) => m.sec > playheadSec + 0.25);

  const controls: Ctl[] = [
    player.isPlaying
      ? { id: 'btn-ctl-1', icon: 'pause', label: 'Pause audio', enabled: true, active: true, onClick: () => void player.toggle() }
      : {
          id: 'btn-ctl-1',
          icon: 'play',
          label: 'Play or pause audio',
          enabled: !live && hasAudio,
          reason: live
            ? 'Playback is off while timecode rolls.'
            : caps && !caps.storage
              ? "Audio storage isn't configured on this server."
              : 'This session has no playable audio yet. Record, import a file or a YouTube link.',
          onClick: () => void player.toggle(),
        },
    {
      id: 'btn-ctl-2',
      icon: 'record',
      label: rolling ? 'Timecode rolling' : 'Roll timecode',
      enabled: !rolling && !player.isPlaying && canWrite && !busy,
      active: rolling,
      rec: true,
      reason: readOnly ?? (player.isPlaying ? 'Pause playback to roll timecode.' : null),
      onClick: () => onTransport('start'),
    },
    {
      id: 'btn-ctl-3',
      icon: 'mic',
      label: recording ? 'Stop recording audio' : 'Record audio',
      enabled: recording || (!micReason && !busy),
      active: recording,
      reason: micReason,
      onClick: () => void (recording ? recorder.stop() : recorder.start()),
    },
    {
      id: 'btn-ctl-4',
      icon: 'stop',
      label: 'Stop timecode',
      enabled: rolling && canWrite && !busy,
      reason: readOnly ?? 'Timecode is already stopped.',
      onClick: () => onTransport('stop'),
    },
  ];
  const markerCtls: Ctl[] = [
    {
      id: 'btn-marker-prev',
      icon: 'prev',
      label: 'Previous marker',
      enabled: !live && !!prev,
      reason: live ? 'Marker jumps are off while live.' : 'No earlier marker.',
      dot: prev?.color,
      dotSide: 'left',
      onClick: () => prev && (onSeek(prev.sec), onRevealEvent(prev.id)),
    },
    {
      id: 'btn-marker-next',
      icon: 'next',
      label: 'Next marker',
      enabled: !live && !!next,
      reason: live ? 'Marker jumps are off while live.' : 'No later marker.',
      dot: next?.color,
      dotSide: 'right',
      onClick: () => next && (onSeek(next.sec), onRevealEvent(next.id)),
    },
  ];

  const elapsed = session.elapsedFrames > 0 || rolling;
  const recDur = recorder.startedAt ? fmtSec((Date.now() - recorder.startedAt) / 1000) : '00:00:00';

  return (
    <section
      id="v5-maximize-log-strip"
      aria-label="Session transport"
      className="mx-3 box-border w-[calc(100%-1.5rem)] min-w-0 overflow-visible rounded-card border border-si-line bg-si-panel p-3 md:mx-4 md:w-[calc(100%-2rem)] md:px-3.5 md:py-3"
    >
      <div className="flex w-full min-w-0 flex-col gap-4 md:flex-row md:items-end md:gap-5">
        <aside className="flex w-full min-w-0 flex-col items-stretch gap-2.5 self-stretch md:w-[min(100%,19.25rem)] md:shrink-0 md:justify-center" aria-label="Session info and transport">
          <div className="flex min-w-0 flex-row flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
            <Tooltip content={`Date ${fmtDate(session.episodeDate ?? session.createdAt)}${session.episode ? ` · Episode ${session.episode}` : ''}`} side="right" align="start">
              <p
                id="session-deck-title"
                tabIndex={0}
                className="m-0 flex min-w-0 flex-1 cursor-default flex-row items-baseline gap-x-1.5 overflow-hidden rounded-[4px] font-ui text-[0.8125rem] leading-tight text-si-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <span className="min-w-0 truncate font-semibold">{session.showName || '—'}</span>
                {session.title && session.title !== session.showName && (
                  <>
                    <span className="shrink-0 select-none text-si-dim" aria-hidden="true">
                      &middot;
                    </span>
                    <span className="min-w-0 truncate text-si-muted">{session.title}</span>
                  </>
                )}
              </p>
            </Tooltip>
            <h2 className="m-0 flex min-w-0 shrink-0 flex-row items-center gap-2 font-ui text-[0.75rem] leading-none" aria-live="polite">
              <span className="sr-only">Status:</span>
              <Badge variant="transport">
                {tint === 'recording' && <span data-slot="live-dot" className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />}
                <span>{TRANSPORT_LABEL[tint]}</span>
              </Badge>
              {recording && (
                <>
                  <span id="top-bar-mic-level" className="items-center" aria-hidden="true" title="Microphone level">
                    <span className="block h-2 w-12 overflow-hidden rounded-[3px] border border-si-line bg-si-bg">
                      <span className="block h-full origin-left bg-si-accent transition-[width] duration-75 ease-linear" style={{ width: `${Math.round(recorder.level * 100)}%` }} />
                    </span>
                  </span>
                  <span id="top-bar-recording-dur" className="font-tc text-[0.75rem] font-medium tabular-nums text-si-fg" aria-hidden="true">
                    {recDur}
                  </span>
                </>
              )}
            </h2>
          </div>

          <div className="flex min-w-0 items-center" aria-live="off">
            <span className={cn('flex min-w-0 items-center gap-2.5 whitespace-nowrap', live ? 'text-si-fg' : 'text-si-muted')}>
              <span className="inline-flex shrink-0 items-center gap-1" aria-hidden="true">
                <span className={cn('inline-flex', recording ? 'text-(--si-rec)' : rolling ? 'text-si-fg' : 'text-si-dim')}>
                  <Glyph icon="mic" size={16} />
                </span>
                <span className={cn('inline-flex', live ? 'text-(--si-rec)' : 'text-si-dim')}>
                  {rolling ? (
                    <svg width={16} height={16} viewBox="0 0 24 24" aria-hidden="true">
                      <circle cx="12" cy="12" r="6" fill="currentColor" />
                    </svg>
                  ) : (
                    <Glyph icon="stop" size={16} />
                  )}
                </span>
              </span>
              <span
                id="session-tc-display"
                role="timer"
                aria-label={`Timecode ${clock.timecode}${rolling ? ', rolling' : ''}${session.take > 1 ? `, take ${session.take}` : ''}`}
                className="font-tc text-[1.625rem] font-semibold leading-none tracking-[-0.01em] tabular-nums max-md:text-[1.5rem]"
              >
                {clock.timecode}
              </span>
              {session.take > 1 && <span className="font-label text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-si-dim">Take {session.take}</span>}
            </span>
          </div>

          <div className="flex w-full min-w-0 flex-row flex-wrap items-center gap-1.5 md:flex-nowrap" role="toolbar" aria-label="Session transport controls">
            {controls.map((c) => (
              <CtlButton key={c.id} c={c} />
            ))}
            {markerCtls.map((c) => (
              <CtlButton key={c.id} c={c} />
            ))}
            {canWrite && !rolling && elapsed && (
              <Tooltip content="Reset timecode to the start">
                <Button
                  variant="transport"
                  size="icon"
                  className="md:w-auto md:min-w-(--h-ctl) md:flex-1"
                  aria-label="Reset timecode"
                  disabled={busy || player.isPlaying}
                  onClick={async () => {
                    const ok = await confirm({
                      title: 'Reset timecode',
                      message: `Set the clock back to the session start? The next roll starts take ${session.take + 1}; logged events keep their times.`,
                      confirmLabel: 'Reset',
                    });
                    if (ok) onTransport('reset');
                  }}
                >
                  <RotateCcw className="size-4" aria-hidden="true" />
                </Button>
              </Tooltip>
            )}
            <Tooltip content="Keyboard shortcuts (?)">
              <Button variant="transport" size="icon" className="max-md:hidden md:w-auto md:min-w-(--h-ctl) md:flex-1" aria-label="Keyboard shortcuts" onClick={() => shortcutsOpen.set(true)}>
                <KeyboardIcon aria-hidden="true" />
              </Button>
            </Tooltip>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col justify-end gap-2.5">
          {live ? (
            <div id="cat-strip-live-slot" className="box-border flex min-h-(--v4-cat-btn-h) w-full min-w-0 items-center">
              {categoriesError ? (
                <p className="m-0 text-[0.85rem] text-si-danger">Couldn't load the event buttons. {categoriesError}</p>
              ) : (
                <CategoryStrip
                  session={session}
                  categories={categories}
                  events={events}
                  enabled={rolling && canWrite}
                  disabledReason={readOnly ?? (!rolling ? 'Roll timecode to log events.' : null)}
                  elapsedSec={() => clock.elapsedSec}
                />
              )}
            </div>
          ) : (
            <Timeline
              session={session}
              events={events}
              segments={player.segments}
              totalSec={totalSec}
              playheadSec={playheadSec}
              onSeek={onSeek}
              onSelectEvent={onRevealEvent}
            />
          )}
        </div>
      </div>
      {confirmElement}
    </section>
  );
}
