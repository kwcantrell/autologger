// The dashboard widgets that need no chart library: the card frame, stat, table and timeline,
// rendered from a widget spec and its rows (props in, markup out: no query, workspace context or
// socket). The session's Dashboards tab and the landing page mock both render them; the recharts
// widgets (bar, line, pie) stay in widgets.tsx so the landing page doesn't load recharts.

import type { ValueFormat, Widget } from '@autologger/contract';
import type { ReactNode } from 'react';
import { fmtShort } from '@/lib/timecode';
import { FEED_CELL, FEED_TH } from '@/session/feed';
import { cn } from '@/shared/lib/utils';
import { Tooltip } from '@/shared/ui/Tooltip';
import { fmtField, fmtFormat, fmtNum, fmtValue, type Row, safeColor, toNum } from './data';

// Resolved --si-* values (dark only): recharts writes these as SVG presentation attributes; the
// timeline widget uses the accent for rows without a colour.
export const C = {
  dim: '#858c98',
  muted: '#a6acb7',
  line: '#272b33',
  panel2: '#1c1f25',
  fg: '#eceef2',
  accent: '#5b7cff',
};

const SPAN: Record<number, string> = {
  1: 'md:col-span-1',
  2: 'md:col-span-2',
  3: 'md:col-span-3',
  4: 'md:col-span-4',
};

export const MAX_TABLE_ROWS = 200;

/** A widget's card: title, description and grid span from the spec. */
export function WidgetFrame({ widget, children }: { widget: Widget; children: ReactNode }) {
  return (
    <section
      aria-label={widget.title || widget.type}
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-card border border-si-line bg-si-bg/40 p-3',
        SPAN[widget.span] ?? SPAN[2],
      )}
    >
      {(widget.title || widget.description) && (
        <header className="min-w-0">
          {widget.title && (
            <h3 className="m-0 font-label text-[0.75rem] font-semibold uppercase tracking-[0.12em] text-si-dim">
              {widget.title}
            </h3>
          )}
          {widget.description && (
            <p className="m-0 mt-0.5 text-[0.78rem] text-si-muted">{widget.description}</p>
          )}
        </header>
      )}
      <div className="min-w-0 flex-1">{children}</div>
    </section>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="m-0 py-4 text-center text-[0.8rem] text-si-muted">{children}</p>;
}

// ── stat ────────────────────────────────────────────────────────────

export function StatWidget({
  widget,
  rows,
}: {
  widget: Extract<Widget, { type: 'stat' }>;
  rows: Row[];
}) {
  let text: string;
  if (widget.value != null) {
    text = widget.format
      ? fmtFormat(widget.value, widget.format)
      : typeof widget.value === 'number'
        ? fmtNum(widget.value)
        : widget.value;
  } else {
    const first = rows[0];
    const key = widget.field ?? (first ? Object.keys(first)[0] : undefined);
    text =
      !first || !key
        ? '—'
        : widget.format
          ? fmtFormat(first[key], widget.format)
          : fmtValue(first[key], key);
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-baseline gap-1.5">
        <span
          className="truncate font-ui text-[2rem] font-semibold leading-none tabular-nums text-si-fg"
          title={text}
        >
          {text}
        </span>
        {widget.unit && <span className="text-[0.85rem] text-si-muted">{widget.unit}</span>}
      </div>
      {widget.caption && <p className="m-0 text-[0.78rem] text-si-muted">{widget.caption}</p>}
    </div>
  );
}

// ── table ───────────────────────────────────────────────────────────

export function TableWidget({
  widget,
  rows,
}: {
  widget: Extract<Widget, { type: 'table' }>;
  rows: Row[];
}) {
  let columns: { key: string; label: string; format?: ValueFormat }[] | undefined =
    widget.columns?.map((c) => ({ key: c.key, label: c.label ?? c.key, format: c.format }));
  if (!columns?.length) {
    const keys: string[] = [];
    for (const r of rows.slice(0, 50))
      for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
    // Without explicit columns, session times read as durations (12:05), not raw seconds.
    columns = keys.slice(0, 12).map((k) => ({
      key: k,
      label: k,
      format: k === 'atSec' ? ('duration' as const) : undefined,
    }));
  }
  const shown = rows.slice(0, MAX_TABLE_ROWS);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="max-h-[360px] min-w-0 overflow-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col" className={cn(FEED_TH, 'bg-si-panel')}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity
              <tr key={i}>
                {columns.map((c) => {
                  const v = r[c.key];
                  return (
                    <td
                      key={c.key}
                      className={cn(
                        FEED_CELL,
                        'max-w-[24rem] py-1 align-top text-si-fg',
                        typeof v === 'number' && 'text-right tabular-nums',
                      )}
                    >
                      {fmtField(v, c.key, c.format)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > MAX_TABLE_ROWS && (
        <p className="m-0 text-[0.75rem] text-si-dim">
          Showing {MAX_TABLE_ROWS} of {rows.length}
        </p>
      )}
    </div>
  );
}

// ── timeline ────────────────────────────────────────────────────────

/** Bars and points along the session; every item seeks the audio (`onSeek`, session seconds). */
export function TimelineWidget({
  widget,
  rows,
  onSeek,
}: {
  widget: Extract<Widget, { type: 'timeline' }>;
  rows: Row[];
  onSeek: (sec: number) => void;
}) {
  const items = rows
    .map((r, i) => {
      const at = toNum(r[widget.at]);
      const dur = widget.duration ? toNum(r[widget.duration]) : null;
      const raw = r[widget.label];
      return at == null
        ? null
        : {
            i,
            at: Math.max(0, at),
            dur: dur && dur > 0 ? dur : 0,
            label: raw == null ? '' : String(raw),
            color: safeColor(r.color),
          };
    })
    .filter((x): x is NonNullable<typeof x> => x != null)
    .sort((a, b) => a.at - b.at);
  if (!items.length) return <Note>No rows have a time in “{widget.at}”.</Note>;
  const end = Math.max(1, ...items.map((x) => x.at + x.dur));
  const pct = (s: number) => `${Math.min(100, (s / end) * 100)}%`;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="relative h-9 w-full rounded-ctl border border-si-line bg-si-bg">
        {items.map((x) =>
          x.dur ? (
            <Tooltip key={x.i} shared content={`${fmtShort(x.at)} · ${x.label}`}>
              <button
                type="button"
                onClick={() => onSeek(x.at)}
                aria-label={`Jump to ${fmtShort(x.at)} ${x.label}`}
                className="absolute top-1.5 bottom-1.5 min-w-[3px] cursor-pointer rounded-[3px] border border-[color-mix(in_oklab,var(--si-accent)_55%,transparent)] bg-[color-mix(in_oklab,var(--si-accent)_22%,transparent)] p-0 hover:bg-[color-mix(in_oklab,var(--si-accent)_40%,transparent)] focus-visible:outline-2 focus-visible:outline-ring"
                style={{ left: pct(x.at), width: `calc(${pct(x.dur)} - 1px)` }}
              />
            </Tooltip>
          ) : (
            <Tooltip key={x.i} shared content={`${fmtShort(x.at)} · ${x.label}`}>
              <button
                type="button"
                onClick={() => onSeek(x.at)}
                aria-label={`Jump to ${fmtShort(x.at)} ${x.label}`}
                className="absolute top-1 bottom-1 w-[3px] -translate-x-1/2 cursor-pointer rounded-full border-0 p-0 opacity-85 hover:opacity-100 hover:[box-shadow:0_0_0_2px_rgba(255,255,255,0.25)] focus-visible:outline-2 focus-visible:outline-ring"
                style={{ left: pct(x.at), background: x.color ?? C.accent }}
              />
            </Tooltip>
          ),
        )}
      </div>
      <div
        className="flex justify-between font-tc text-[0.7rem] tabular-nums text-si-dim"
        aria-hidden="true"
      >
        <span>0:00</span>
        <span>{fmtShort(end)}</span>
      </div>
      <ul className="m-0 flex max-h-[220px] list-none flex-col overflow-auto p-0">
        {items.slice(0, MAX_TABLE_ROWS).map((x) => (
          <li key={x.i}>
            <button
              type="button"
              onClick={() => onSeek(x.at)}
              className="flex w-full min-w-0 cursor-pointer items-baseline gap-2.5 rounded-[5px] border-0 bg-transparent px-1.5 py-1 text-left text-[0.8rem] text-si-fg hover:bg-white/[0.04] focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span className="w-14 shrink-0 font-tc text-[0.75rem] tabular-nums text-(--si-accent)">
                {fmtShort(x.at)}
              </span>
              <span className="min-w-0 flex-1 truncate" title={x.label}>
                {x.label || '—'}
              </span>
              {x.dur > 0 && (
                <span className="shrink-0 text-[0.72rem] tabular-nums text-si-dim">
                  {fmtShort(x.dur)}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      {items.length > MAX_TABLE_ROWS && (
        <p className="m-0 text-[0.75rem] text-si-dim">
          Showing {MAX_TABLE_ROWS} of {items.length}
        </p>
      )}
    </div>
  );
}
