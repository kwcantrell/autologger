// The scrub lane shown in the transport card while timecode is stopped: current-marker chip,
// track with the audio waveform and clips, event markers and the playhead, ticks, and the zoom rail.

import type { Session, SessionEvent } from '@autologger/contract';
import { type CSSProperties, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isTypingTarget } from '@/lib/keys';
import { eventSec, fmtSec } from '@/lib/timecode';
import { cn, TOUCH_HIT } from '@/shared/lib/utils';
import { isOverlayOpen } from '@/shared/ui/overlayOpen';
import type { PlayerSegment } from './audio/usePlayer';
import { indexAt, usePlayhead, usePlayheadSource } from './context';
import { TimelineWaveform } from './TimelineWaveform';
import { useWaveform } from './waveform';

/** Minimum spacing between ruler labels in px (an "00:00:00" label plus a gap). */
const RULER_LABEL_PX = 90;
const MIN_ZOOM = 1;
const MAX_ZOOM = 40;

const MARKER =
  'timelineMarker absolute top-1/2 left-0 size-[0.92rem] m-0 p-0 border-0 rounded-full bg-(--mcol) [transform:translate(-50%,-50%)] cursor-pointer opacity-95 pointer-events-auto [box-shadow:0_0_16px_color-mix(in_srgb,var(--mcol)_26%,transparent)] hover-always:opacity-100 hover-always:[transform:translate(-50%,-50%)_scale(1.06)] hover-always:[box-shadow:0_0_20px_color-mix(in_srgb,var(--mcol)_32%,transparent)] focus-visible:outline-2 focus-visible:outline-si-accent focus-visible:outline-offset-[3px] motion-reduce:transition-none';
const MARKER_SELECTED =
  'opacity-100 [transform:translate(-50%,-50%)_scale(1.1)] [box-shadow:0_0_22px_color-mix(in_srgb,var(--mcol)_36%,transparent)]';
const TRACK_H =
  'h-[calc(var(--v5-timeline-lane-h)*0.88)] md:h-[calc(var(--v5-timeline-lane-h)*0.88-1.7rem)]';
const PLAYHEAD =
  'absolute top-1/2 left-0 w-0.5 h-[calc(100%-0.85rem)] rounded-full -translate-x-1/2 -translate-y-1/2 z-[6] pointer-events-none bg-(--tx-playhead) [box-shadow:0_0_10px_1px_var(--tx-playhead-glow),0_0_4px_1px_var(--tx-playhead-glow)] [transition:background-color_var(--tx-dur)_var(--tx-ease)] motion-reduce:transition-none';
const ZOOM_VALUE =
  'appearance-none box-border m-0 w-[3.65rem] shrink-0 text-center rounded-[6px] border border-si-line bg-si-bg text-si-muted font-tc text-[0.6875rem] font-medium tabular-nums px-[0.2rem] py-[0.15rem] outline-none focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1';
const ZOOM_HANDLE =
  'absolute top-1/2 size-[calc(var(--v4-zoom-handle-h)*1.2)] -translate-x-1/2 -translate-y-1/2 rounded-full z-[2] cursor-grab touch-none bg-si-fg border-2 border-si-accent hover-always:bg-white active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2';

interface Marker {
  event: SessionEvent;
  sec: number;
}

/** The playhead line; follows the playhead on its own. */
function PlayheadLine({ totalSec }: { totalSec: number }) {
  // Hundredths of a percent: smooth even zoomed in, without a render per unchanged position.
  const pos = usePlayhead((sec) => Math.round(Math.max(0, Math.min(1e4, (sec / totalSec) * 1e4))));
  return <span className={PLAYHEAD} style={{ left: `${pos / 100}%` }} aria-hidden="true" />;
}

/** The playhead as clock time, re-rendered once per second. */
function PlayheadTime() {
  return <>{fmtSec(usePlayhead((sec) => Math.floor(sec)))}</>;
}

/** Memoized; the playhead is followed by PlayheadLine, PlayheadTime and coarse selectors. */
export const Timeline = memo(function Timeline({
  session,
  events,
  segments,
  totalSec,
  onSeek,
  onSelectEvent,
  locked,
}: {
  session: Session;
  events: SessionEvent[];
  segments: PlayerSegment[];
  totalSec: number;
  onSeek: (sec: number) => void;
  onSelectEvent: (eventId: string) => void;
  locked?: boolean;
}) {
  const [zoom, setZoom] = useState(1);
  const [zoomText, setZoomText] = useState('100%');
  // Enter/Escape set the zoom text themselves; the blur they trigger must not reset it from the
  // zoom captured in this render, which is still the old value.
  const zoomTextSet = useRef(false);
  const [hover, setHover] = useState<{ sec: number; x: number; y: number } | null>(null);
  const [tip, setTip] = useState<{ m: Marker; x: number; y: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState({ left: 0, width: 1 });
  /** Width of the whole (zoomed) track in px, for spacing the ruler labels. */
  const [trackPx, setTrackPx] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const segmentList = useMemo(() => segments.map((p) => p.seg), [segments]);
  const waveform = useWaveform(session.id, segmentList);
  // Audio without a drawn waveform says why instead of looking like silence.
  const waveformNote =
    segmentList.length === 0
      ? null
      : waveform.isError
        ? 'Waveform unavailable'
        : !segmentList.some((s) => s.hasWaveform)
          ? 'No waveform yet'
          : null;

  const markers: Marker[] = useMemo(
    () =>
      events
        .map((e) => ({ event: e, sec: eventSec(e.timecodeFrames, session) }))
        .filter((m): m is Marker => m.sec != null)
        .sort((a, b) => a.sec - b.sec),
    [events, session],
  );

  const pct = (sec: number) => `${Math.max(0, Math.min(100, (sec / totalSec) * 100))}%`;

  // Current marker: the last one at or before the playhead, lit for 3 s after it. Selected
  // coarsely so the timeline re-renders when they change, not on every frame of playback.
  const playhead = usePlayheadSource();
  const starts = useMemo(() => markers.map((m) => m.sec), [markers]);
  const currentIdx = usePlayhead((sec) => indexAt(starts, sec + 0.05));
  const current = currentIdx >= 0 ? (markers[currentIdx] as Marker) : null;
  const currentLit = usePlayhead((sec) => current != null && sec - current.sec < 3);
  /** Whole seconds (as the readout shows them), for the scrubber's accessible value. */
  const playheadWhole = usePlayhead((sec) => Math.floor(sec));

  const secAt = useCallback(
    (clientX: number) => {
      const r = trackRef.current!.getBoundingClientRect();
      return Math.max(0, Math.min(totalSec, ((clientX - r.left) / r.width) * totalSec));
    },
    [totalSec],
  );

  const applyZoom = useCallback((z: number, anchorFrac = 0.5) => {
    const vp = viewportRef.current;
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    setZoom((prev) => {
      if (vp) {
        const anchorPx = vp.scrollLeft + vp.clientWidth * anchorFrac;
        const frac = anchorPx / (vp.scrollWidth || 1);
        requestAnimationFrame(() => {
          vp.scrollLeft = frac * vp.scrollWidth - vp.clientWidth * anchorFrac;
        });
      }
      return prev === next ? prev : next;
    });
    setZoomText(`${Math.round(next * 100)}%`);
  }, []);

  // Visible window for the zoom rail.
  const syncView = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    setView({
      left: vp.scrollLeft / (vp.scrollWidth || 1),
      width: vp.clientWidth / (vp.scrollWidth || 1),
    });
    setTrackPx(vp.scrollWidth);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: zoom is the trigger — re-sync the view after zooming
  useEffect(() => {
    syncView();
  }, [zoom, syncView]);
  // …and whenever the timeline changes size without scrolling (window resize, sidebar toggle,
  // layout shifts): otherwise the stored window goes stale and the waveform is drawn for the
  // wrong stretch, out of line with the markers and ruler.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const ro = new ResizeObserver(syncView);
    ro.observe(vp);
    if (vp.firstElementChild) ro.observe(vp.firstElementChild);
    return () => ro.disconnect();
  }, [syncView]);

  // + / − zoom keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target) || isOverlayOpen()) return;
      if (e.code === 'Equal' || e.code === 'NumpadAdd') applyZoom(zoom * 1.25);
      else if (e.code === 'Minus' || e.code === 'NumpadSubtract') applyZoom(zoom / 1.25);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom, applyZoom]);

  // Wheel over the track zooms around the pointer.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      applyZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), (e.clientX - r.left) / r.width);
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, [zoom, applyZoom]);

  // Keep the playhead in view while playing (scrolls without re-rendering).
  useEffect(() => {
    if (zoom === 1) return;
    const follow = () => {
      const vp = viewportRef.current;
      if (!vp || dragging.current) return;
      const x = (playhead.get() / totalSec) * vp.scrollWidth;
      if (x < vp.scrollLeft || x > vp.scrollLeft + vp.clientWidth)
        vp.scrollLeft = x - vp.clientWidth * 0.2;
    };
    follow();
    return playhead.subscribe(follow);
  }, [playhead, totalSec, zoom]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (locked || (e.target as HTMLElement).closest('.timelineMarker')) return;
    dragging.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    onSeek(secAt(e.clientX));
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const sec = secAt(e.clientX);
    setHover({ sec, x: e.clientX, y: (trackRef.current?.getBoundingClientRect().top ?? 0) - 8 });
    if (dragging.current) onSeek(sec);
  };
  const onPointerUp = () => {
    dragging.current = false;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft') onSeek(Math.max(0, playhead.get() - step));
    else if (e.key === 'ArrowRight') onSeek(Math.min(totalSec, playhead.get() + step));
    else if (e.key === 'Home') onSeek(0);
    else return;
    e.preventDefault();
  };

  const selectMarker = useCallback(
    (m: Marker) => {
      setSelected(m.event.id);
      onSeek(m.sec);
      onSelectEvent(m.event.id);
    },
    [onSeek, onSelectEvent],
  );

  // The marker buttons don't depend on the playhead: build them only when the markers, the
  // selection or the scale change, not on every frame of playback.
  const markerButtons = useMemo(
    () =>
      markers.map((m) => (
        <button
          key={m.event.id}
          type="button"
          className={cn(MARKER, selected === m.event.id && MARKER_SELECTED)}
          data-cat={m.event.category}
          style={
            {
              left: `${Math.max(0, Math.min(100, (m.sec / totalSec) * 100))}%`,
              '--mcol': m.event.color,
            } as CSSProperties
          }
          aria-label={`${m.event.category}${m.event.message ? `: ${m.event.message}` : ''} at ${fmtSec(m.sec)}`}
          onPointerEnter={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setTip({ m, x: r.left + r.width / 2, y: r.top });
          }}
          onPointerLeave={() => setTip(null)}
          onClick={() => selectMarker(m)}
        />
      )),
    [markers, selected, totalSec, selectMarker],
  );

  // Zoom rail drag: the bar scrolls, the handles resize the window.
  const railRef = useRef<HTMLDivElement>(null);
  const railDrag = (kind: 'bar' | 'start' | 'end') => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rail = railRef.current!.getBoundingClientRect();
    const vp = viewportRef.current!;
    const start = { x: e.clientX, left: view.left, width: view.width };
    const move = (ev: PointerEvent) => {
      const d = (ev.clientX - start.x) / rail.width;
      if (kind === 'bar') {
        vp.scrollLeft = Math.max(0, Math.min(1 - start.width, start.left + d)) * vp.scrollWidth;
      } else {
        const left =
          kind === 'start'
            ? Math.max(0, Math.min(start.left + start.width - 0.025, start.left + d))
            : start.left;
        const right =
          kind === 'end'
            ? Math.min(1, Math.max(start.left + 0.025, start.left + start.width + d))
            : start.left + start.width;
        const width = right - left;
        const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, 1 / width));
        setZoom(z);
        setZoomText(`${Math.round(z * 100)}%`);
        requestAnimationFrame(() => {
          vp.scrollLeft = left * vp.scrollWidth;
          syncView();
        });
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Ruler labels, each placed at its own time (like markers, the playhead and the waveform) —
  // not spread with justify-between, which drifts from the time it names. As many as fit with
  // ~90px per "00:00:00" label at the track's measured (zoomed) width.
  const ticks = useMemo(() => {
    const count = Math.min(61, Math.max(2, Math.floor(trackPx / RULER_LABEL_PX) + 1));
    return Array.from({ length: count }, (_, i) => {
      const sec = (i * totalSec) / (count - 1);
      return { sec, label: fmtSec(sec) };
    });
  }, [trackPx, totalSec]);

  const chipColor = current?.event.color ?? 'var(--si-dim)';

  return (
    <div
      className={cn(
        'flex w-full min-w-0 flex-col gap-[0.3rem]',
        locked && 'pointer-events-none opacity-[0.48]',
      )}
    >
      {/* Current-marker chip */}
      <div
        className={cn(
          'relative flex h-[1.7rem] w-full min-w-0 items-stretch overflow-hidden rounded-t-[6px] [transition:opacity_0.45s_ease,background_0.3s_ease] motion-reduce:transition-none',
          currentLit ? 'opacity-100' : 'opacity-[0.52]',
        )}
        style={{ background: `color-mix(in oklab, ${chipColor} 14%, var(--si-panel-2))` }}
        aria-live="polite"
      >
        <span
          className="absolute inset-y-0 left-0 w-1"
          style={{ background: chipColor }}
          aria-hidden="true"
        />
        <span className="relative flex min-w-0 flex-1 items-center gap-[0.4rem] rounded-t-[6px] border border-si-line py-0 pr-[0.45rem] pl-[calc(0.25rem+0.45rem)]">
          <span className="sr-only">Current marker: </span>
          <span className="shrink-0 font-label text-[0.6875rem] font-semibold uppercase leading-none tracking-[0.12em] text-si-fg">
            {current ? current.event.category : 'No marker'}
          </span>
          {current && (current.event.message || current.event.value) && (
            <>
              <span className="shrink-0 text-si-dim" aria-hidden="true">
                ·
              </span>
              <span className="min-w-0 truncate text-[0.8125rem] font-medium leading-snug text-si-muted">
                {[current.event.value, current.event.message].filter(Boolean).join(' — ')}
              </span>
            </>
          )}
        </span>
      </div>

      {/* Track */}
      <div
        ref={viewportRef}
        className="timeline-hide-scrollbar w-full max-w-full overflow-x-auto overflow-y-hidden rounded-b-[0.65rem]"
        onScroll={syncView}
      >
        <div className="relative" style={{ width: `${zoom * 100}%` }}>
          <div
            ref={trackRef}
            id="timeline-track"
            role="slider"
            tabIndex={0}
            aria-label="Timeline scrubber"
            aria-valuemin={0}
            aria-valuemax={Math.round(totalSec)}
            aria-valuenow={playheadWhole}
            aria-valuetext={fmtSec(playheadWhole)}
            className={cn(
              'relative isolate w-full shrink-0 cursor-ew-resize touch-none overflow-hidden rounded-b-[6px] border border-t-0 border-si-line bg-[rgba(0,0,0,0.28)] outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
              TRACK_H,
            )}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => setHover(null)}
            onKeyDown={onKeyDown}
          >
            {waveform.data && waveform.data.length > 0 && (
              <TimelineWaveform peaks={waveform.data} totalSec={totalSec} view={view} />
            )}
            {waveformNote && (
              <span className="pointer-events-none absolute top-1 right-2 z-[1] font-label text-[0.625rem] font-semibold uppercase tracking-[0.12em] text-si-dim">
                {waveformNote}
              </span>
            )}
            <div className="pointer-events-none absolute inset-0 z-[1] before:absolute before:top-1/2 before:right-[0.4rem] before:left-[0.4rem] before:h-px before:-translate-y-1/2 before:bg-[rgba(148,163,184,0.38)] before:content-['']" />
            {/* Audio clips */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[2] h-1.5">
              {segments.map((p) => (
                <span
                  key={p.seg.id}
                  title={`Audio ${fmtSec(p.start)}–${fmtSec(p.end)}`}
                  className="absolute bottom-0 h-full rounded-[2px] bg-[color-mix(in_oklab,var(--color-legacy-accent)_40%,transparent)]"
                  style={{
                    left: pct(p.start),
                    width: `${Math.max(0.15, ((p.end - p.start) / totalSec) * 100)}%`,
                  }}
                />
              ))}
            </div>
            {/* Hover playhead */}
            {hover && (
              <span
                className="pointer-events-none absolute top-1/2 z-[3] h-[calc(100%-0.85rem)] w-px -translate-x-1/2 -translate-y-1/2 rounded-full bg-[rgba(229,238,252,0.28)]"
                style={{ left: pct(hover.sec) }}
              />
            )}
            {/* Markers */}
            <div className="pointer-events-none absolute inset-0 z-[5]">{markerButtons}</div>
            <PlayheadLine totalSec={totalSec} />
          </div>
          {/* Ticks */}
          <div
            className="pointer-events-none relative h-[1.15rem] w-full font-tc text-[0.6875rem] font-medium leading-none tabular-nums text-si-dim [text-shadow:0_1px_2px_var(--si-bg)]"
            aria-hidden="true"
          >
            {ticks.map((t, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: ticks are fixed positional labels
                key={i}
                className="absolute top-0"
                style={{ left: pct(t.sec) }}
              >
                {/* Tick mark exactly at the time; the label is centred on it, except the first
                    and last, which stay inside the track. */}
                <span
                  className={cn(
                    'absolute top-0 h-[0.3rem] w-px bg-si-line',
                    i === ticks.length - 1 && '-translate-x-full',
                  )}
                />
                <span
                  className="absolute top-[0.45rem] whitespace-nowrap"
                  style={{
                    transform:
                      i === 0
                        ? 'translateX(0.2rem)'
                        : i === ticks.length - 1
                          ? 'translateX(calc(-100% - 0.2rem))'
                          : 'translateX(-50%)',
                  }}
                >
                  {t.label}
                </span>
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Zoom rail */}
      <div
        className="flex w-full min-w-0 flex-row items-center gap-[0.3rem] pt-1"
        role="toolbar"
        aria-label="Timeline zoom"
      >
        {/* The label carries the touch hit area (an input draws no ::after); a tap on it
            focuses the field, which sits above it. */}
        <label className={cn('relative flex shrink-0', TOUCH_HIT)}>
          <input
            className={cn(ZOOM_VALUE, 'relative z-[1]')}
            aria-label="Timeline zoom percent"
            value={zoomText}
            onChange={(e) => setZoomText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const n = Number.parseFloat(zoomText);
                if (Number.isFinite(n)) applyZoom(n / 100);
                else setZoomText(`${Math.round(zoom * 100)}%`);
                zoomTextSet.current = true;
                (e.target as HTMLInputElement).blur();
              } else if (e.key === 'Escape') {
                setZoomText(`${Math.round(zoom * 100)}%`);
                zoomTextSet.current = true;
                (e.target as HTMLInputElement).blur();
              }
            }}
            onBlur={() => {
              if (zoomTextSet.current) zoomTextSet.current = false;
              else setZoomText(`${Math.round(zoom * 100)}%`);
            }}
          />
        </label>
        <div
          ref={railRef}
          // Touch: room either side so the handles' 44px hit areas stay off the zoom field.
          className="relative isolate h-(--v4-zoom-handle-h) min-w-0 flex-1 rounded-full border border-si-line bg-si-panel-2 max-md:mx-4 pointer-coarse:mx-4"
        >
          <div
            className="absolute top-1/2 z-[1] h-[120%] -translate-y-1/2 cursor-grab touch-none rounded-full bg-[color-mix(in_oklab,var(--si-accent)_55%,var(--si-panel-2))] active:cursor-grabbing"
            style={{ left: `${view.left * 100}%`, width: `${view.width * 100}%` }}
            onPointerDown={railDrag('bar')}
          />
          <button
            type="button"
            aria-label="Increase timeline zoom"
            className={cn(ZOOM_HANDLE, TOUCH_HIT)}
            style={{ left: `${view.left * 100}%` }}
            onPointerDown={railDrag('start')}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'Enter') applyZoom(zoom * 1.25);
              else if (e.key === 'ArrowLeft') applyZoom(zoom / 1.25);
            }}
          />
          <button
            type="button"
            aria-label="Reduce timeline zoom"
            className={cn(ZOOM_HANDLE, TOUCH_HIT)}
            style={{ left: `${(view.left + view.width) * 100}%` }}
            onPointerDown={railDrag('end')}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft' || e.key === 'Enter') applyZoom(zoom / 1.25);
              else if (e.key === 'ArrowRight') applyZoom(zoom * 1.25);
            }}
          />
        </div>
        <div className="flex shrink-0 flex-row items-baseline gap-[0.15rem] whitespace-nowrap pl-1 tabular-nums">
          <span className="font-tc text-[0.8125rem] font-semibold text-si-fg">
            <PlayheadTime />
          </span>
          <span className="font-tc text-[0.6875rem] font-medium text-si-dim">
            / {fmtSec(totalSec)}
          </span>
        </div>
      </div>

      {tip && (
        <div
          role="tooltip"
          className="pointer-events-none fixed z-[10060] max-w-[min(72vw,440px)] -translate-x-1/2 -translate-y-[calc(100%+8px)] rounded-[0.5rem] border border-si-line bg-si-panel px-[0.55rem] py-[0.4rem] text-[0.76rem] leading-[1.35] text-si-fg [overflow-wrap:anywhere]"
          style={{ left: tip.x, top: tip.y }}
        >
          <span className="mb-[0.12rem] block font-semibold text-si-muted">
            {tip.m.event.category} · {fmtSec(tip.m.sec)}
          </span>
          <span className="block">
            {[tip.m.event.value, tip.m.event.message].filter(Boolean).join(' — ') || '—'}
          </span>
        </div>
      )}
      {hover && !tip && (
        <div
          role="tooltip"
          className="pointer-events-none fixed z-[10055] -translate-x-1/2 -translate-y-full rounded-[0.5rem] border border-si-line bg-si-panel px-2 py-1 font-tc text-[0.78rem] tabular-nums text-si-fg"
          style={{ left: hover.x, top: hover.y }}
        >
          {fmtSec(hover.sec)}
        </div>
      )}
    </div>
  );
});
