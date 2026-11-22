// Timecode on the client: all math comes from the contract; the clock is derived from the
// server's transport state (never a client-owned counter) and re-rendered each animation frame.

import {
  formatFrames,
  type Session,
  secondsToClock,
  type TransportState,
  transportElapsed,
  transportFrames,
} from '@autologger/contract';
import { useEffect, useState } from 'react';

export { formatFrames, parseTimecode, FRAME_RATES, secondsToClock } from '@autologger/contract';

export function transportOf(s: Pick<Session, 'isRolling' | 'rollStartedAt' | 'elapsedFrames' | 'take' | 'frameRate' | 'startOffsetFrames'>): TransportState {
  return {
    isRolling: s.isRolling,
    rollStartedAt: s.rollStartedAt,
    elapsedFrames: s.elapsedFrames,
    take: s.take,
    frameRate: s.frameRate,
    startOffsetFrames: s.startOffsetFrames,
  };
}

/**
 * Server clock skew: the socket's hello carries serverTime; Date.now() + skew ≈ server now.
 * Kept module-level so every clock agrees.
 */
let skewMs = 0;
export function setServerTime(iso: string) {
  const t = Date.parse(iso);
  if (Number.isFinite(t)) skewMs = t - Date.now();
}
export const serverNow = () => Date.now() + skewMs;

export interface TransportClock {
  /** Absolute frames on the clock (includes start offset). */
  frames: number;
  /** Session seconds since transport zero. */
  elapsedSec: number;
  /** Formatted SMPTE timecode. */
  timecode: string;
}

function compute(t: TransportState): TransportClock {
  const now = serverNow();
  const frames = transportFrames(t, now);
  return {
    frames,
    elapsedSec: transportElapsed(t, now) / t.frameRate,
    timecode: formatFrames(frames, t.frameRate),
  };
}

/** Live transport clock for a session; ticks on requestAnimationFrame while rolling. */
export function useTransportClock(session: Session | undefined | null): TransportClock {
  const t = session ? transportOf(session) : null;
  const [clock, setClock] = useState<TransportClock>(() =>
    t ? compute(t) : { frames: 0, elapsedSec: 0, timecode: '00:00:00:00' },
  );
  const key = t ? `${t.isRolling}|${t.rollStartedAt}|${t.elapsedFrames}|${t.frameRate}|${t.startOffsetFrames}` : '';

  useEffect(() => {
    if (!t) return;
    setClock(compute(t));
    if (!t.isRolling) return;
    let raf = 0;
    let last = '';
    const tick = () => {
      const c = compute(t);
      if (c.timecode !== last) {
        last = c.timecode;
        setClock(c);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [key]);

  return clock;
}

/** Session seconds for an event's stored frames (frames include the start offset). */
export function eventSec(timecodeFrames: number | null, session: Pick<Session, 'frameRate' | 'startOffsetFrames'>): number | null {
  if (timecodeFrames == null) return null;
  return Math.max(0, (timecodeFrames - session.startOffsetFrames) / session.frameRate);
}

export function fmtSec(sec: number): string {
  return secondsToClock(sec);
}

/** h:mm:ss without leading hour zero (search/moment labels). */
export function fmtShort(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(r)}` : `${m}:${p(r)}`;
}
