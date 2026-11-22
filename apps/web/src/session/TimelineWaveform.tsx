// The timeline's waveform: a canvas covering only the visible window of the (zoomed) track,
// redrawn on scroll, zoom, resize and playhead moves. Unplayed bars use --si-wave-body, played
// ones --tx-wave-progress (DESIGN.md "Timeline").

import { useEffect, useMemo, useRef, useState } from 'react';
import { columnPeaks, type SegmentPeaks } from './waveform';

/** Column width in CSS pixels (a 1px gap included). */
const BAR_PX = 3;

export function TimelineWaveform({
  peaks,
  totalSec,
  view,
  playheadSec,
}: {
  peaks: SegmentPeaks[];
  totalSec: number;
  /** Visible window as fractions of the track (Timeline's zoom view). */
  view: { left: number; width: number };
  playheadSec: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bodyRef = useRef<HTMLSpanElement>(null);
  const playedRef = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ro = new ResizeObserver(() => setSize({ w: c.clientWidth, h: c.clientHeight }));
    ro.observe(c);
    return () => ro.disconnect();
  }, []);

  const fromSec = view.left * totalSec;
  const toSec = (view.left + view.width) * totalSec;
  const columns = Math.floor(size.w / BAR_PX);
  const heights = useMemo(
    () => columnPeaks(peaks, fromSec, toSec, columns),
    [peaks, fromSec, toSec, columns],
  );

  useEffect(() => {
    const c = canvasRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx || !size.w || !size.h) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(size.w * dpr);
    const h = Math.round(size.h * dpr);
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    ctx.clearRect(0, 0, w, h);
    // Resolved theme colours (the played one follows data-transport).
    const body = bodyRef.current ? getComputedStyle(bodyRef.current).color : 'gray';
    const played = playedRef.current ? getComputedStyle(playedRef.current).color : 'white';
    const colW = (size.w / Math.max(1, heights.length)) * dpr;
    const barW = Math.max(1, colW - dpr);
    const mid = h / 2;
    const playX = toSec > fromSec ? ((playheadSec - fromSec) / (toSec - fromSec)) * w : 0;
    for (let x = 0; x < heights.length; x++) {
      // sqrt: speech sits far below full scale; this keeps quiet passages visible.
      const amp = Math.sqrt(heights[x]!) * (h * 0.44);
      if (amp < 0.5) continue;
      const left = x * colW;
      ctx.fillStyle = left + barW / 2 <= playX ? played : body;
      ctx.fillRect(left, mid - amp, barW, amp * 2);
    }
  }, [heights, size, playheadSec, fromSec, toSec]);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-y-0 z-0 h-full"
        style={{ left: `${view.left * 100}%`, width: `${view.width * 100}%` }}
      />
      <span ref={bodyRef} className="hidden text-(--si-wave-body)" />
      <span ref={playedRef} className="hidden text-(--tx-wave-progress)" />
    </>
  );
}
