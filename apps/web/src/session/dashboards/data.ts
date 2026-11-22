// Value helpers for dashboard widgets. Spec values are plain data: they are only ever coerced to
// numbers or rendered as text, never executed or injected as markup.

import type { DashboardRows, ValueFormat } from '@autologger/contract';
import { useSyncExternalStore } from 'react';
import { fmtShort } from '@/lib/timecode';

export type Row = DashboardRows[number];
export type Scalar = Row[string];

/** Calm categorical series colours (dark ground). Accent first. */
export const VIZ = [
  '#5b7cff',
  '#3fb5a3',
  '#d9a441',
  '#d9677a',
  '#9a7be0',
  '#5fa8d3',
  '#8fae5a',
  '#8b93a1',
];

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
/** A row-supplied colour, only when it is a plain hex literal (never a CSS expression). */
export function safeColor(v: unknown): string | null {
  return typeof v === 'string' && HEX.test(v) ? v : null;
}

export function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const NUM = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
export const fmtNum = (n: number) => NUM.format(n);

/** Seconds-like field names (`atSec`, `seconds`, `audioSec`, `durationSec`). */
export const isSecondsKey = (key: string) => /sec(onds)?$/i.test(key);

/** Any scalar as display text. */
export function fmtValue(v: Scalar | undefined, key?: string): string {
  if (v == null) return '—';
  if (typeof v === 'number') return key && isSecondsKey(key) && v >= 60 ? fmtShort(v) : fmtNum(v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return v;
}

const MIN = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const PCT = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 });

/** A number in an explicit spec `format`; non-numeric values fall back to plain text. */
export function fmtFormat(v: Scalar | undefined, format: ValueFormat): string {
  const n = toNum(v);
  if (n == null) return fmtValue(v);
  switch (format) {
    case 'duration':
      return (n < 0 ? '-' : '') + fmtShort(Math.abs(n));
    case 'minutes':
      return MIN.format(n / 60);
    case 'percent':
      return PCT.format(n);
    case 'number':
      return fmtNum(n);
  }
}

/** A cell or slice value: the spec `format` when given, else the default for its field name. */
export function fmtField(v: Scalar | undefined, key: string, format?: ValueFormat): string {
  return format ? fmtFormat(v, format) : fmtValue(v, key);
}

/** Shorten a label to at most `max` characters, ending in an ellipsis when cut. */
export function truncateLabel(s: string, max?: number): string {
  if (!max || s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/** Group rows by `x` (as text) and sum `y`; keeps first-seen order. */
export function sumBy(rows: Row[], x: string, y: string): { x: string; y: number; raw: Scalar }[] {
  const out = new Map<string, { x: string; y: number; raw: Scalar }>();
  for (const r of rows) {
    const raw = r[x] ?? null;
    const label = raw == null ? '—' : String(raw);
    const n = toNum(r[y]) ?? 0;
    const prev = out.get(label);
    if (prev) prev.y += n;
    else out.set(label, { x: label, y: n, raw });
  }
  return [...out.values()];
}

const RM = '(prefers-reduced-motion: reduce)';
function subscribeRM(cb: () => void) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia(RM);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeRM,
    () =>
      typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(RM).matches : false,
    () => false,
  );
}
