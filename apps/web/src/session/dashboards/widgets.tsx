// Widget renderers for a declarative DashboardSpec. Every value is rendered as text or coerced to
// a number; nothing from a spec is executed.

import type { DashboardRows, ValueFormat, Widget } from '@autologger/contract';
import { TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useDashboardQuery } from '@/api/queries';
import { errorMessage } from '@/api/rpc';
import { fmtShort } from '@/lib/timecode';
import { useWorkspace } from '@/session/context';
import { FEED_CELL, FEED_TH } from '@/session/feed';
import { Skeleton } from '@/shared/components/ui/skeleton';
import { cn } from '@/shared/lib/utils';
import {
  fmtFormat,
  fmtNum,
  fmtValue,
  isSecondsKey,
  type Row,
  safeColor,
  sumBy,
  toNum,
  truncateLabel,
  useReducedMotion,
  VIZ,
} from './data';
import { SpecMarkdown } from './Markdown';

// Resolved --si-* values (dark only): recharts writes these as SVG presentation attributes.
const C = {
  dim: '#858c98',
  muted: '#a6acb7',
  line: '#272b33',
  panel2: '#1c1f25',
  fg: '#eceef2',
  accent: '#5b7cff',
};
const AXIS = { stroke: C.line, tick: { fill: C.dim, fontSize: 11 }, tickLine: false } as const;
const TOOLTIP = {
  contentStyle: {
    background: C.panel2,
    border: `1px solid ${C.line}`,
    borderRadius: 8,
    fontSize: 12,
    color: C.fg,
    boxShadow: '0 8px 32px rgba(0,0,0,0.35)',
  },
  labelStyle: { color: C.muted, marginBottom: 2 },
  itemStyle: { color: C.fg, padding: 0 },
  cursor: { fill: 'rgba(255,255,255,0.04)', stroke: C.line },
} as const;

const SPAN: Record<number, string> = {
  1: 'md:col-span-1',
  2: 'md:col-span-2',
  3: 'md:col-span-3',
  4: 'md:col-span-4',
};

const MAX_TABLE_ROWS = 200;
const CHART_H = 240;

export function WidgetGrid({ widgets, sessionId }: { widgets: Widget[]; sessionId: string }) {
  if (!widgets.length) {
    return (
      <p className="m-0 py-6 text-center text-[0.85rem] text-si-muted">
        This dashboard has no widgets.
      </p>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
      {widgets.map((w, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: widget ids are agent-written and may repeat
        <WidgetCard key={`${w.id}-${i}`} widget={w} sessionId={sessionId} />
      ))}
    </div>
  );
}

function WidgetFrame({ widget, children }: { widget: Widget; children: ReactNode }) {
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

function WidgetCard({ widget, sessionId }: { widget: Widget; sessionId: string }) {
  return (
    <WidgetFrame widget={widget}>
      {widget.type === 'markdown' ? (
        <SpecMarkdown source={widget.markdown} />
      ) : (
        <DataWidget widget={widget} sessionId={sessionId} />
      )}
    </WidgetFrame>
  );
}

type DataWidgetT = Exclude<Widget, { type: 'markdown' }>;

function DataWidget({ widget, sessionId }: { widget: DataWidgetT; sessionId: string }) {
  const q = useDashboardQuery(sessionId, widget.query);
  if (widget.query) {
    if (q.isPending) return <WidgetSkeleton type={widget.type} />;
    if (q.isError) return <WidgetError message={errorMessage(q.error)} />;
    return <WidgetBody widget={widget} rows={q.data} />;
  }
  if (widget.data) return <WidgetBody widget={widget} rows={widget.data} />;
  if (widget.type === 'stat' && widget.value != null)
    return <WidgetBody widget={widget} rows={[]} />;
  return <Note>This widget has no data.</Note>;
}

function WidgetSkeleton({ type }: { type: Widget['type'] }) {
  if (type === 'stat') return <Skeleton className="h-10 w-28" aria-label="Loading" />;
  return <Skeleton className="h-[160px] w-full" aria-label="Loading" />;
}

function WidgetError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-ctl border border-(--si-danger-line) bg-[color-mix(in_oklab,var(--si-danger)_6%,transparent)] p-2.5 text-[0.8rem] text-(--si-danger)"
    >
      <TriangleAlert className="mt-px size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0">Could not load this widget's data. {message}</span>
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="m-0 py-4 text-center text-[0.8rem] text-si-muted">{children}</p>;
}

function WidgetBody({ widget, rows }: { widget: DataWidgetT; rows: DashboardRows }) {
  if (widget.type !== 'stat' && rows.length === 0) return <Note>No data yet.</Note>;
  switch (widget.type) {
    case 'stat':
      return <StatWidget widget={widget} rows={rows} />;
    case 'bar':
      return <BarWidget widget={widget} rows={rows} />;
    case 'line':
      return <LineWidget widget={widget} rows={rows} />;
    case 'pie':
      return <PieWidget widget={widget} rows={rows} />;
    case 'table':
      return <TableWidget widget={widget} rows={rows} />;
    case 'timeline':
      return <TimelineWidget widget={widget} rows={rows} />;
  }
}

// ── stat ────────────────────────────────────────────────────────────

function StatWidget({ widget, rows }: { widget: Extract<Widget, { type: 'stat' }>; rows: Row[] }) {
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

// ── bar / line ──────────────────────────────────────────────────────

const tickFor = (key: string, format?: ValueFormat) => (v: unknown) => {
  const n = toNum(v);
  if (n != null && format) return fmtFormat(n, format);
  return n != null && isSecondsKey(key) ? fmtShort(n) : n != null ? fmtNum(n) : String(v);
};

function BarWidget({ widget, rows }: { widget: Extract<Widget, { type: 'bar' }>; rows: Row[] }) {
  const rm = useReducedMotion();
  const data = sumBy(rows, widget.x, widget.y);
  const xTick = tickFor(widget.x);
  const xLabel = (v: unknown) => truncateLabel(xTick(v), widget.labelMaxChars);
  const yTick = tickFor(widget.y, widget.format);
  const h = widget.horizontal ? Math.max(CHART_H, Math.min(data.length * 28 + 30, 600)) : CHART_H;
  return (
    <div style={{ height: h }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        {widget.horizontal ? (
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 4, right: 12, bottom: 4, left: 4 }}
          >
            <CartesianGrid stroke={C.line} horizontal={false} />
            <XAxis type="number" {...AXIS} tickFormatter={yTick} />
            <YAxis
              type="category"
              dataKey="x"
              {...AXIS}
              width={110}
              tickFormatter={xLabel}
              interval={0}
            />
            <Tooltip
              {...TOOLTIP}
              labelFormatter={(l) => xTick(l)}
              formatter={(v) => [yTick(v), widget.y]}
            />
            <Bar
              dataKey="y"
              name={widget.y}
              fill={C.accent}
              radius={[0, 3, 3, 0]}
              maxBarSize={22}
              isAnimationActive={!rm}
            />
          </BarChart>
        ) : (
          <BarChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
            <CartesianGrid stroke={C.line} vertical={false} />
            <XAxis dataKey="x" {...AXIS} tickFormatter={xLabel} />
            <YAxis {...AXIS} width={44} tickFormatter={yTick} />
            <Tooltip
              {...TOOLTIP}
              labelFormatter={(l) => xTick(l)}
              formatter={(v) => [yTick(v), widget.y]}
            />
            <Bar
              dataKey="y"
              name={widget.y}
              fill={C.accent}
              radius={[3, 3, 0, 0]}
              maxBarSize={40}
              isAnimationActive={!rm}
            />
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

function LineWidget({ widget, rows }: { widget: Extract<Widget, { type: 'line' }>; rows: Row[] }) {
  const rm = useReducedMotion();
  const summed = sumBy(rows, widget.x, widget.y);
  const numericX = summed.every((d) => toNum(d.raw) != null);
  const data = numericX
    ? summed.map((d) => ({ ...d, xn: toNum(d.raw) as number })).sort((a, b) => a.xn - b.xn)
    : summed.map((d) => ({ ...d, xn: 0 }));
  const xTick = tickFor(widget.x);
  const yTick = tickFor(widget.y, widget.format);
  return (
    <div style={{ height: CHART_H }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 6, right: 12, bottom: 4, left: 0 }}>
          <CartesianGrid stroke={C.line} vertical={false} />
          {numericX ? (
            <XAxis
              dataKey="xn"
              type="number"
              domain={['dataMin', 'dataMax']}
              {...AXIS}
              tickFormatter={xTick}
            />
          ) : (
            <XAxis dataKey="x" {...AXIS} tickFormatter={xTick} />
          )}
          <YAxis {...AXIS} width={44} tickFormatter={yTick} />
          <Tooltip
            {...TOOLTIP}
            labelFormatter={(l) => xTick(l)}
            formatter={(v) => [yTick(v), widget.y]}
          />
          <Line
            type="monotone"
            dataKey="y"
            name={widget.y}
            stroke={C.accent}
            strokeWidth={2}
            dot={data.length <= 40 ? { r: 2.5, fill: C.accent, strokeWidth: 0 } : false}
            activeDot={{ r: 4 }}
            isAnimationActive={!rm}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── pie ─────────────────────────────────────────────────────────────

const PIE_MAX = 7;

function PieWidget({ widget, rows }: { widget: Extract<Widget, { type: 'pie' }>; rows: Row[] }) {
  const rm = useReducedMotion();
  const colorOf = new Map<string, string | null>();
  for (const r of rows) {
    const label = r[widget.label] == null ? '—' : String(r[widget.label]);
    if (!colorOf.has(label)) colorOf.set(label, safeColor(r.color));
  }
  const all = sumBy(rows, widget.label, widget.value)
    .filter((d) => d.y > 0)
    .sort((a, b) => b.y - a.y);
  const head = all.slice(0, PIE_MAX);
  const rest = all.slice(PIE_MAX).reduce((s, d) => s + d.y, 0);
  const slices = head.map((d, i) => ({
    name: d.x,
    value: d.y,
    color: colorOf.get(d.x) ?? VIZ[i % VIZ.length]!,
  }));
  if (rest > 0) slices.push({ name: 'Other', value: rest, color: C.dim });
  const total = slices.reduce((s, d) => s + d.value, 0);
  if (!total) return <Note>No data yet.</Note>;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-4">
      <div style={{ height: 180, width: 180 }} className="shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="name"
              innerRadius="58%"
              outerRadius="96%"
              paddingAngle={slices.length > 1 ? 1.5 : 0}
              stroke="none"
              isAnimationActive={!rm}
            >
              {slices.map((s) => (
                <Cell key={s.name} fill={s.color} />
              ))}
            </Pie>
            <Tooltip {...TOOLTIP} formatter={(v, n) => [fmtValue(toNum(v)), String(n)]} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="m-0 flex min-w-[10rem] flex-1 list-none flex-col gap-1 p-0 text-[0.8rem]">
        {slices.map((s) => (
          <li key={s.name} className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden="true"
              className="size-2.5 shrink-0 rounded-[2px]"
              style={{ background: s.color }}
            />
            <span className="min-w-0 flex-1 truncate text-si-fg" title={s.name}>
              {s.name}
            </span>
            <span className="tabular-nums text-si-muted">{fmtNum(s.value)}</span>
            <span className="w-10 text-right tabular-nums text-si-dim">
              {Math.round((s.value / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── table ───────────────────────────────────────────────────────────

function TableWidget({
  widget,
  rows,
}: {
  widget: Extract<Widget, { type: 'table' }>;
  rows: Row[];
}) {
  let columns = widget.columns?.map((c) => ({ key: c.key, label: c.label ?? c.key }));
  if (!columns?.length) {
    const keys: string[] = [];
    for (const r of rows.slice(0, 50))
      for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
    columns = keys.slice(0, 12).map((k) => ({ key: k, label: k }));
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
                      {fmtValue(v, c.key)}
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

function TimelineWidget({
  widget,
  rows,
}: {
  widget: Extract<Widget, { type: 'timeline' }>;
  rows: Row[];
}) {
  const { seek } = useWorkspace();
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
            <button
              key={x.i}
              type="button"
              onClick={() => seek(x.at)}
              title={`${fmtShort(x.at)} · ${x.label}`}
              aria-label={`Jump to ${fmtShort(x.at)} ${x.label}`}
              className="absolute top-1.5 bottom-1.5 min-w-[3px] cursor-pointer rounded-[3px] border border-[color-mix(in_oklab,var(--si-accent)_55%,transparent)] bg-[color-mix(in_oklab,var(--si-accent)_22%,transparent)] p-0 hover:bg-[color-mix(in_oklab,var(--si-accent)_40%,transparent)] focus-visible:outline-2 focus-visible:outline-ring"
              style={{ left: pct(x.at), width: `calc(${pct(x.dur)} - 1px)` }}
            />
          ) : (
            <button
              key={x.i}
              type="button"
              onClick={() => seek(x.at)}
              title={`${fmtShort(x.at)} · ${x.label}`}
              aria-label={`Jump to ${fmtShort(x.at)} ${x.label}`}
              className="absolute top-1 bottom-1 w-[3px] -translate-x-1/2 cursor-pointer rounded-full border-0 p-0 opacity-85 hover:opacity-100 hover:[box-shadow:0_0_0_2px_rgba(255,255,255,0.25)] focus-visible:outline-2 focus-visible:outline-ring"
              style={{ left: pct(x.at), background: x.color ?? C.accent }}
            />
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
              onClick={() => seek(x.at)}
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
