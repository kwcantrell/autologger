// SMPTE timecode math. Pure functions shared by server, web and companion.
// Non-drop-frame counting at round(fps); 29.97 renders with a ';' separator.

export interface Timecode {
  hours: number;
  minutes: number;
  seconds: number;
  frames: number;
}

export const FRAME_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60] as const;

export function fpsInt(frameRate: number): number {
  return Math.max(1, Math.round(frameRate));
}

export function fromFrames(total: number, frameRate: number): Timecode {
  const fps = fpsInt(frameRate);
  const t = Math.max(0, Math.floor(total));
  const frames = t % fps;
  let s = Math.floor(t / fps);
  const seconds = s % 60;
  s = Math.floor(s / 60);
  const minutes = s % 60;
  const hours = Math.floor(s / 60) % 24;
  return { hours, minutes, seconds, frames };
}

export function toFrames(tc: Timecode, frameRate: number): number {
  const fps = fpsInt(frameRate);
  return ((tc.hours * 60 + tc.minutes) * 60 + tc.seconds) * fps + tc.frames;
}

const p2 = (n: number) => String(n).padStart(2, '0');

export function formatFrames(total: number, frameRate: number): string {
  const tc = fromFrames(total, frameRate);
  const sep = Math.abs(frameRate - 29.97) < 0.01 || Math.abs(frameRate - 59.94) < 0.01 ? ';' : ':';
  return `${p2(tc.hours)}:${p2(tc.minutes)}:${p2(tc.seconds)}${sep}${p2(tc.frames)}`;
}

/** Parses `HH:MM:SS`, `HH:MM:SS:FF` or `HH:MM:SS;FF` into a frame count, or null. */
export function parseTimecode(text: string, frameRate: number): number | null {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})(?:[:;.](\d{2}))?$/.exec(text.trim());
  if (!m) return null;
  const [hours, minutes, seconds, frames] = [m[1], m[2], m[3], m[4] ?? '0'].map(Number) as [
    number,
    number,
    number,
    number,
  ];
  if (hours > 23 || minutes > 59 || seconds > 59 || frames >= fpsInt(frameRate)) return null;
  return toFrames({ hours, minutes, seconds, frames }, frameRate);
}

export interface TransportState {
  isRolling: boolean;
  /** ISO instant the current roll started, when rolling. */
  rollStartedAt: string | null;
  /** Frames accumulated by previous rolls. */
  elapsedFrames: number;
  take: number;
  frameRate: number;
  startOffsetFrames: number;
}

/** Elapsed frames of the transport at `nowMs` (excludes the start offset). */
export function transportElapsed(t: TransportState, nowMs: number = Date.now()): number {
  if (!t.isRolling || !t.rollStartedAt) return t.elapsedFrames;
  const ms = Math.max(0, nowMs - Date.parse(t.rollStartedAt));
  return t.elapsedFrames + Math.floor((ms / 1000) * t.frameRate);
}

/** Absolute timecode frames shown on the clock at `nowMs`. */
export function transportFrames(t: TransportState, nowMs: number = Date.now()): number {
  return t.startOffsetFrames + transportElapsed(t, nowMs);
}

/** Session seconds (from transport zero) for a frame count, ignoring the start offset. */
export function framesToSeconds(frames: number, frameRate: number): number {
  return frames / frameRate;
}

/**
 * Seconds from the session start for a stored event frame count (frames include the start
 * offset), rounded to milliseconds. Inverse of placing an event with `atSec`; negative when the
 * frame count is before the start offset.
 */
export function framesToAtSec(
  frames: number,
  clock: { frameRate: number; startOffsetFrames: number },
): number {
  return Math.round(((frames - clock.startOffsetFrames) / clock.frameRate) * 1000) / 1000;
}

export function secondsToClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${p2(h)}:${p2(m)}:${p2(s % 60)}`;
}
