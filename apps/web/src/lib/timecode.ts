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
import { createStore, type Store, useStore } from './store';

export { FRAME_RATES, formatFrames, parseTimecode, secondsToClock } from '@autologger/contract';

export function transportOf(
  s: Pick<
    Session,
    'isRolling' | 'rollStartedAt' | 'elapsedFrames' | 'take' | 'frameRate' | 'startOffsetFrames'
  >,
): TransportState {
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

const ZERO_CLOCK: TransportClock = { frames: 0, elapsedSec: 0, timecode: '00:00:00:00' };

/**
 * Live transport clock for a session as an external store; ticks on requestAnimationFrame while
 * rolling. Only the components that read it (`useStore(clock)`) re-render each frame, not the
 * component that owns it.
 */
export function useTransportClockStore(session: Session | undefined | null): Store<TransportClock> {
  const t = session ? transportOf(session) : null;
  const [clock] = useState(() => createStore<TransportClock>(t ? compute(t) : ZERO_CLOCK));
  const key = t
    ? `${t.isRolling}|${t.rollStartedAt}|${t.elapsedFrames}|${t.frameRate}|${t.startOffsetFrames}`
    : '';

  // `key` captures every transport field `t` is built from; depending on it instead of the `t`
  // object keeps the animation loop from restarting when an identical session object arrives.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the transport fields above
  useEffect(() => {
    if (!t) return;
    clock.set(compute(t));
    if (!t.isRolling) return;
    let raf = 0;
    let last = '';
    const tick = () => {
      const c = compute(t);
      if (c.timecode !== last) {
        last = c.timecode;
        clock.set(c);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [key]);

  return clock;
}

/** Live transport clock for a session; re-renders the caller each frame while rolling. */
export function useTransportClock(session: Session | undefined | null): TransportClock {
  return useStore(useTransportClockStore(session));
}

/**
 * A session whose clock never rolled (imported media) but has audio: its runtime is the audio
 * length, not the zero on the clock.
 */
export const isMediaOnly = (
  s: Pick<Session, 'isRolling' | 'take' | 'elapsedFrames' | 'audioSeconds'>,
): boolean => !s.isRolling && s.take === 0 && s.elapsedFrames === 0 && s.audioSeconds > 0;

/** Session seconds for an event's stored frames (frames include the start offset). */
export function eventSec(
  timecodeFrames: number | null,
  session: Pick<Session, 'frameRate' | 'startOffsetFrames'>,
): number | null {
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
