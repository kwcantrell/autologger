// Wire types of the /ws/companion protocol and the pure state → variables/feedback mapping.
// Mirrors packages/contract (CompanionState, timecode.ts) so this module builds standalone.

export type CategoryKind = 'button' | 'dropdown' | 'text' | 'toggle';

export interface Category {
  id: string;
  showId: string;
  /** 0-based; positions 0–8 map to hotkeys 1–9. */
  position: number;
  name: string;
  color: string;
  kind: CategoryKind;
  options: string[];
  onLabel: string;
  offLabel: string;
}

export interface SessionTransport {
  id: string;
  title: string;
  isRolling: boolean;
  rollStartedAt: string | null;
  elapsedFrames: number;
  take: number;
  frameRate: number;
  startOffsetFrames: number;
  eventCount: number;
}

export interface CompanionState {
  device: { id: string; name: string };
  show: { id: string; name: string } | null;
  session: SessionTransport | null;
  categories: Category[];
  lastEvent: { id: string; category: string; message: string; timecodeFrames: number } | null;
}

export interface RpcError {
  code: string;
  message: string;
}

export type ServerMessage =
  | { type: 'state'; state: CompanionState; serverTime: string }
  | { type: 'result'; reqId: string; ok: true; data: unknown }
  | { type: 'result'; reqId: string; ok: false; error: RpcError }
  | { type: 'pong' };

export type CompanionOp =
  | 'companion.state'
  | 'transport.start'
  | 'transport.stop'
  | 'events.create';

// ── timecode (copy of packages/contract/src/timecode.ts essentials) ─────

export function fpsInt(frameRate: number): number {
  return Math.max(1, Math.round(frameRate));
}

const p2 = (n: number) => String(n).padStart(2, '0');

export function formatFrames(total: number, frameRate: number): string {
  const fps = fpsInt(frameRate);
  const t = Math.max(0, Math.floor(total));
  const frames = t % fps;
  let s = Math.floor(t / fps);
  const seconds = s % 60;
  s = Math.floor(s / 60);
  const minutes = s % 60;
  const hours = Math.floor(s / 60) % 24;
  const sep = Math.abs(frameRate - 29.97) < 0.01 || Math.abs(frameRate - 59.94) < 0.01 ? ';' : ':';
  return `${p2(hours)}:${p2(minutes)}:${p2(seconds)}${sep}${p2(frames)}`;
}

/** Absolute clock frames of the transport at server time `nowMs`. */
export function transportFrames(s: SessionTransport, nowMs: number): number {
  let elapsed = s.elapsedFrames;
  if (s.isRolling && s.rollStartedAt) {
    const ms = Math.max(0, nowMs - Date.parse(s.rollStartedAt));
    elapsed += Math.floor((ms / 1000) * s.frameRate);
  }
  return s.startOffsetFrames + elapsed;
}

/**
 * The module's view of the server: the last state plus the offset between the server clock and
 * ours, so the timecode keeps ticking locally between pushes.
 */
export interface LiveState {
  state: CompanionState;
  /** serverTime − localTime at receipt, in ms. */
  clockOffsetMs: number;
}

export function liveState(
  state: CompanionState,
  serverTime: string,
  localNowMs: number,
): LiveState {
  const server = Date.parse(serverTime);
  return { state, clockOffsetMs: Number.isFinite(server) ? server - localNowMs : 0 };
}

export function timecodeAt(live: LiveState | null, localNowMs: number): string {
  const s = live?.state.session;
  if (!s) return '--:--:--:--';
  return formatFrames(transportFrames(s, localNowMs + live.clockOffsetMs), s.frameRate);
}

// ── variables ──────────────────────────────────────────────

export const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export type VariableValues = Record<string, string | number | undefined>;

export function categoryAtSlot(
  state: CompanionState | null | undefined,
  slot: number,
): Category | undefined {
  return state?.categories.find((c) => c.position === slot - 1);
}

export function lastEventText(state: CompanionState | null | undefined): string {
  const e = state?.lastEvent;
  if (!e) return '';
  return e.message ? `${e.category}: ${e.message}` : e.category;
}

export function toVariableValues(live: LiveState | null, localNowMs: number): VariableValues {
  const st = live?.state ?? null;
  const s = st?.session ?? null;
  const out: VariableValues = {
    device_name: st?.device.name ?? '',
    show_name: st?.show?.name ?? '',
    session_title: s?.title ?? '(no session)',
    timecode: timecodeAt(live, localNowMs),
    take: s ? s.take : '',
    event_count: s ? s.eventCount : '',
    rolling: s?.isRolling ? 'ROLLING' : 'STOPPED',
    frame_rate: s ? s.frameRate : '',
    last_event: lastEventText(st),
    last_event_timecode:
      st?.lastEvent && s ? formatFrames(st.lastEvent.timecodeFrames, s.frameRate) : '',
  };
  for (const slot of SLOTS) out[`cat_${slot}`] = categoryAtSlot(st, slot)?.name ?? '';
  return out;
}

// ── colors ─────────────────────────────────────────────────

/** `#rrggbb` → Companion's packed RGB number (same as combineRgb). */
export function hexToRgb(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  return m ? Number.parseInt(m[1]!, 16) : null;
}

/** Black or white text, whichever reads better on `bg`. */
export function textColorFor(bg: number): number {
  const r = (bg >> 16) & 255;
  const g = (bg >> 8) & 255;
  const b = bg & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? 0x000000 : 0xffffff;
}

/** Button style for the category in a hotkey slot, or null when the slot is empty. */
export function categoryStyle(
  state: CompanionState | null | undefined,
  slot: number,
): { bgcolor: number; color: number } | null {
  const cat = categoryAtSlot(state, slot);
  const bg = cat ? hexToRgb(cat.color) : null;
  return bg === null ? null : { bgcolor: bg, color: textColorFor(bg) };
}

// ── URL ────────────────────────────────────────────────────

/** `http(s)://host[/…]` or `ws(s)://…` → the companion socket URL. */
export function socketUrl(raw: string): string {
  let base = raw.trim().replace(/\/+$/, '');
  if (!/^[a-z]+:\/\//i.test(base)) base = `http://${base}`;
  const u = new URL(base);
  if (u.protocol === 'http:') u.protocol = 'ws:';
  else if (u.protocol === 'https:') u.protocol = 'wss:';
  if (!u.pathname.endsWith('/ws/companion'))
    u.pathname = `${u.pathname.replace(/\/+$/, '')}/ws/companion`;
  return u.toString();
}
