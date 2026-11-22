// Widget renderers for a declarative DashboardSpec. Every value is rendered as text or coerced to
// a number; nothing from a spec is executed.

import type { DashboardRows, ValueFormat, Widget } from '@autologger/contract';
import { TriangleAlert } from 'lucide-react';
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
import { Skeleton } from '@/shared/components/ui/skeleton';
import {
  fmtFormat,
  fmtNum,
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
import { C, Note, StatWidget, TableWidget, TimelineWidget, WidgetFrame } from './WidgetParts';

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

function WidgetBody({ widget, rows }: { widget: DataWidgetT; rows: DashboardRows }) {
  const { seek } = useWorkspace();
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
      return <TimelineWidget widget={widget} rows={rows} onSeek={seek} />;
  }
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
      <ResponsiveContainer width="100%" height={h}>
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
      <ResponsiveContainer width="100%" height={CHART_H}>
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
  // Legend and tooltip share the spec format (e.g. talk-time seconds as minutes).
  const fmt = (v: unknown) => {
    const n = toNum(v);
    if (n == null) return '—';
    return widget.format ? fmtFormat(n, widget.format) : fmtNum(n);
  };
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-4">
      <div style={{ height: 180, width: 180 }} className="shrink-0">
        <ResponsiveContainer width="100%" height={180}>
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
            <Tooltip {...TOOLTIP} formatter={(v, n) => [fmt(v), String(n)]} />
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
            <span className="tabular-nums text-si-muted">{fmt(s.value)}</span>
            <span className="w-10 text-right tabular-nums text-si-dim">
              {Math.round((s.value / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
