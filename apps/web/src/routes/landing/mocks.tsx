// Static, decorative product mocks for the landing page. They reuse the app's primitives (Kbd,
// Badge) and its Show Ignition classes, hold sample data only and are hidden from assistive tech
// (each feature row says the same thing in text). Category colours are sample user data and stay
// on their own channel: a 2px swatch, never a label colour.

import { Download, Undo2 } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { Badge } from '@/shared/components/ui/badge';
import { Kbd } from '@/shared/components/ui/kbd';
import { cn } from '@/shared/lib/utils';

const CATS = [
  { name: 'Laugh', color: '#f59e0b' },
  { name: 'Guest intro', color: '#3b82f6' },
  { name: 'Ad read', color: '#22c55e' },
  { name: 'Audio issue', color: '#ef4444' },
  { name: 'Clip it', color: '#a855f7' },
  { name: 'Note', color: '#a3a3a3' },
];

const LABEL =
  'font-label text-[0.6875rem] font-semibold uppercase leading-none tracking-[0.12em] text-si-dim';
const TC = 'font-tc text-[0.75rem] font-medium tabular-nums text-si-dim';
const LIVE_PILL =
  'border-[color-mix(in_oklab,var(--si-accent)_88%,#000)] bg-[color-mix(in_oklab,var(--si-accent)_88%,#000)] text-white tracking-[0.14em] shadow-[0_0_18px_-4px_color-mix(in_oklab,var(--si-accent)_46%,transparent)]';
const SEL = 'bg-(--sel-bg) shadow-[inset_0_0_0_1px_var(--sel-line)]';
const ACCENT_TEXT = 'text-[color-mix(in_oklab,var(--si-accent)_72%,#ffffff)]';

/** A mock surface: the app's card, with an optional label row. */
export function MockFrame({
  title,
  aside,
  className,
  children,
}: {
  title?: string;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'pointer-events-none w-full min-w-0 select-none overflow-hidden rounded-card border border-si-line bg-si-panel p-4 text-left sm:p-5',
        className,
      )}
    >
      {(title || aside) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {title && <span className={LABEL}>{title}</span>}
          {aside}
        </div>
      )}
      {children}
    </div>
  );
}

function Swatch({ color }: { color: string }) {
  return (
    <span
      className="size-2 shrink-0 rounded-[2px] bg-(--cat)"
      style={{ '--cat': color } as CSSProperties}
    />
  );
}

function LogButton({
  n,
  name,
  color,
  pressed,
}: {
  n?: number;
  name: string;
  color: string;
  pressed?: boolean;
}) {
  return (
    <span
      className={cn(
        'inline-flex min-h-(--h-ctl) min-w-0 items-center gap-2 rounded-ctl border border-si-line bg-si-panel py-1.5 pr-3 pl-2 text-[0.875rem] font-semibold leading-tight text-si-fg',
        pressed && 'border-(--cat) bg-[color-mix(in_oklab,var(--cat)_22%,var(--si-panel))]',
      )}
      style={{ '--cat': color } as CSSProperties}
    >
      {n !== undefined && <Kbd>{n}</Kbd>}
      <Swatch color={color} />
      <span className="truncate">{name}</span>
    </span>
  );
}

// Deterministic waveform heights (no randomness between renders).
const WAVE = Array.from({ length: 72 }, (_, i) => {
  const v = Math.abs(Math.sin(i * 1.7) * 0.6 + Math.sin(i * 0.37) * 0.4);
  return 18 + Math.round(v * 82);
});

function Waveform({
  played,
  markers,
}: {
  played: number;
  markers: { at: number; color: string }[];
}) {
  return (
    <div className="relative h-12 w-full rounded-ctl border border-si-line bg-si-bg px-1">
      <div className="flex h-full items-center gap-px">
        {WAVE.map((h, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: static decorative bars
            key={i}
            className={cn(
              'min-w-0 flex-1 rounded-full',
              i / WAVE.length < played
                ? 'bg-[color-mix(in_oklab,var(--si-accent)_76%,transparent)]'
                : 'bg-(--si-wave-body)',
            )}
            style={{ height: `${h}%` }}
          />
        ))}
      </div>
      {markers.map((m) => (
        <span
          key={m.at}
          className="absolute top-0.5 size-2 -translate-x-1/2 rounded-[2px] bg-(--cat)"
          style={{ left: `${m.at * 100}%`, '--cat': m.color } as CSSProperties}
        />
      ))}
      <span
        className="absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-si-accent shadow-[0_0_10px_1px_color-mix(in_oklab,var(--si-accent)_75%,transparent)]"
        style={{ left: `${played * 100}%` }}
      />
    </div>
  );
}

/** Hero: the session workspace, rolling. */
export function WorkspaceMock() {
  const feed = [
    { tc: '00:42:11:02', cat: CATS[0], note: 'Dana on the parking ticket' },
    { tc: '00:39:48:17', cat: CATS[4], note: 'Cold open candidate' },
    { tc: '00:36:05:09', cat: CATS[3], note: 'Mic 2 crackle' },
    { tc: '00:31:20:00', cat: CATS[2], note: 'Sponsor read, take 2' },
  ];
  return (
    <MockFrame className="p-0 sm:p-0">
      <div className="flex items-center gap-3 border-b border-[color-mix(in_oklab,var(--si-accent)_70%,var(--si-line))] bg-[color-mix(in_oklab,var(--si-accent)_25%,#0a0b0e)] px-4 py-3 shadow-[0_12px_36px_-18px_color-mix(in_oklab,var(--si-accent)_46%,transparent)]">
        <Badge className={LIVE_PILL}>Rolling</Badge>
        <span className="min-w-0 truncate text-[0.875rem] font-semibold text-si-fg">
          Ep. 112 · The long table
        </span>
        <span className="ml-auto font-label text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-si-muted max-sm:hidden">
          Take 2
        </span>
      </div>
      <div className="flex flex-col gap-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <span
            className={cn(
              'font-tc text-[1.5rem] font-semibold leading-none tracking-[-0.01em] tabular-nums sm:text-[2.125rem]',
              ACCENT_TEXT,
              '[text-shadow:0_0_20px_color-mix(in_oklab,var(--si-accent)_46%,transparent)]',
            )}
          >
            00:42:17:08
          </span>
          <span className={TC}>29.97 fps · 128 events</span>
        </div>
        <Waveform
          played={0.62}
          markers={[
            { at: 0.1, color: CATS[1].color },
            { at: 0.28, color: CATS[2].color },
            { at: 0.41, color: CATS[3].color },
            { at: 0.53, color: CATS[4].color },
            { at: 0.6, color: CATS[0].color },
          ]}
        />
        <div className="flex flex-wrap gap-1.5">
          {CATS.slice(0, 5).map((c, i) => (
            <LogButton key={c.name} n={i + 1} name={c.name} color={c.color} pressed={i === 0} />
          ))}
        </div>
        <div className="overflow-hidden rounded-ctl border border-si-line">
          <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 border-b border-si-line bg-si-panel px-3 py-2 sm:grid-cols-[7rem_8rem_minmax(0,1fr)]">
            <span className={LABEL}>Timecode</span>
            <span className={cn(LABEL, 'max-sm:hidden')}>Event</span>
            <span className={LABEL}>Note</span>
          </div>
          {feed.map((r, i) => (
            <div
              key={r.tc}
              className={cn(
                'grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-3 border-b border-si-line px-3 py-2 text-[0.84rem] last:border-b-0 sm:grid-cols-[7rem_8rem_minmax(0,1fr)]',
                i === 0 && 'bg-[color-mix(in_oklab,var(--si-accent)_18%,transparent)]',
              )}
            >
              <span className={TC}>{r.tc}</span>
              <span className="flex min-w-0 items-center gap-2 max-sm:hidden">
                <Swatch color={r.cat.color} />
                <span className="truncate">{r.cat.name}</span>
              </span>
              <span className="truncate text-si-muted">{r.note}</span>
            </div>
          ))}
        </div>
      </div>
    </MockFrame>
  );
}

/** Live logging: the logging strip plus a Stream Deck page driven by Companion. */
export function LoggingMock() {
  const keys: { label: string; sub?: string; color?: string; lit?: boolean }[] = [
    { label: 'Roll', lit: true },
    { label: 'Stop' },
    { label: '00:42:17', sub: 'TC' },
    { label: 'Take 2', sub: 'Take' },
    { label: 'Laugh', sub: 'Last' },
    ...CATS.slice(0, 5).map((c, i) => ({ label: c.name, sub: String(i + 1), color: c.color })),
  ];
  return (
    <MockFrame title="Logging strip · Stream Deck">
      <div className="grid grid-cols-2 gap-1.5">
        {CATS.map((c, i) => (
          <LogButton key={c.name} n={i + 1} name={c.name} color={c.color} pressed={i === 1} />
        ))}
      </div>
      <div className="mt-5 rounded-card border border-(--si-line-strong) bg-(--si-ink) p-2.5">
        <div className="grid grid-cols-5 gap-1.5">
          {keys.map((k) => (
            <span
              key={`${k.sub}-${k.label}`}
              className={cn(
                'flex aspect-square min-w-0 flex-col items-center justify-center gap-1 rounded-ctl border border-si-line bg-si-panel-2 px-0.5 text-center',
                k.lit && LIVE_PILL,
              )}
            >
              {k.color && <Swatch color={k.color} />}
              {k.sub && !k.color && (
                <span className="font-label text-[0.55rem] font-semibold uppercase tracking-[0.12em] text-si-dim">
                  {k.sub}
                </span>
              )}
              <span
                className={cn(
                  'w-full truncate text-[0.62rem] font-semibold leading-tight sm:text-[0.7rem]',
                  k.sub === 'TC' && 'font-tc tabular-nums',
                )}
              >
                {k.label}
              </span>
            </span>
          ))}
        </div>
      </div>
    </MockFrame>
  );
}

/** Transcript tab: speaker turns on the session clock, the current line selected. */
export function TranscriptMock() {
  const lines = [
    {
      at: '00:41:52',
      who: 'Dana',
      text: 'So the meter maid is standing there, and I have a parking ticket in each hand.',
    },
    { at: '00:42:03', who: 'Marcus', text: 'Two tickets. For one car.' },
    {
      at: '00:42:09',
      who: 'Dana',
      text: 'Two tickets, one car, zero minutes over. I checked.',
      current: true,
    },
    { at: '00:42:15', who: 'Priya', text: "This is going in the cold open, isn't it?" },
  ];
  return (
    <MockFrame title="Transcript" aside={<span className={TC}>3 speakers · 58:12</span>}>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {lines.map((l) => (
          <li
            key={l.at}
            className={cn(
              'grid grid-cols-[4.25rem_minmax(0,1fr)] gap-3 rounded-ctl px-2.5 py-2',
              l.current && SEL,
            )}
          >
            <span className={cn(TC, 'pt-0.5')}>{l.at}</span>
            <span className="min-w-0">
              <span className="block font-label text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-si-muted">
                {l.who}
              </span>
              <span className="mt-0.5 block text-[0.875rem] leading-[1.45] text-si-fg">
                {l.text}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap items-center gap-1.5 border-t border-si-line pt-3">
        <span className={cn(LABEL, 'mr-1')}>Key terms</span>
        {['Dana Ruiz', 'Priya Nair', 'Long Table'].map((t) => (
          <Badge key={t} variant="outline">
            {t}
          </Badge>
        ))}
      </div>
    </MockFrame>
  );
}

/** Topics tab: chapters with start and length, over a proportional strip. */
export function TopicsMock() {
  const topics = [
    { title: 'Cold open: the double ticket', start: '00:00:00', len: 4 },
    { title: 'Listener mail', start: '00:04:12', len: 11 },
    { title: 'Guest: Priya on touring', start: '00:15:30', len: 23, current: true },
    { title: 'Ad break', start: '00:38:41', len: 2 },
    { title: 'Lightning round', start: '00:41:02', len: 17 },
  ];
  const total = topics.reduce((s, t) => s + t.len, 0);
  return (
    <MockFrame title="Topics" aside={<span className={TC}>5 chapters</span>}>
      <div className="mb-4 flex h-2.5 gap-0.5 overflow-hidden rounded-full">
        {topics.map((t) => (
          <span
            key={t.title}
            className={t.current ? 'bg-si-accent' : 'bg-(--si-line-strong)'}
            style={{ flexGrow: t.len }}
          />
        ))}
      </div>
      <ol className="m-0 flex list-none flex-col gap-1 p-0">
        {topics.map((t, i) => (
          <li
            key={t.title}
            className={cn(
              'grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-3 rounded-ctl px-2.5 py-2',
              t.current && SEL,
            )}
          >
            <span className={TC}>{i + 1}</span>
            <span className={cn('truncate text-[0.875rem]', t.current && 'font-semibold')}>
              {t.title}
            </span>
            <span className={TC}>
              {t.start} · {t.len}m
            </span>
          </li>
        ))}
      </ol>
      <p className="m-0 mt-3 text-[0.78rem] text-si-dim">
        {Math.round((23 / total) * 100)}% of the episode is the guest segment.
      </p>
    </MockFrame>
  );
}

/** Dashboards tab: stat tiles, events by category, speaker talk time. */
export function DashboardMock() {
  const byCat = [
    { ...CATS[0], n: 41 },
    { ...CATS[4], n: 18 },
    { ...CATS[1], n: 12 },
    { ...CATS[3], n: 6 },
    { ...CATS[2], n: 4 },
  ];
  const max = Math.max(...byCat.map((c) => c.n));
  const talk = [
    { who: 'Dana', pct: 44 },
    { who: 'Marcus', pct: 31 },
    { who: 'Priya', pct: 25 },
  ];
  const tones = [
    'bg-si-accent',
    'bg-[color-mix(in_oklab,var(--si-accent)_55%,var(--si-panel))]',
    'bg-(--si-line-strong)',
  ];
  return (
    <MockFrame title="Dashboard · Episode stats">
      <div className="grid grid-cols-3 gap-2">
        {[
          ['Events', '128'],
          ['Talk time', '58:12'],
          ['Laughs / min', '0.7'],
        ].map(([k, v]) => (
          <div key={k} className="min-w-0 rounded-ctl border border-si-line bg-si-bg p-2.5 sm:p-3">
            <span className={cn(LABEL, 'block truncate')}>{k}</span>
            <span className="mt-2 block font-tc text-[1.05rem] font-semibold tabular-nums sm:text-[1.25rem]">
              {v}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-4 rounded-ctl border border-si-line bg-si-bg p-3">
        <span className={LABEL}>Events by category</span>
        <div className="mt-3 flex flex-col gap-2">
          {byCat.map((c) => (
            <div
              key={c.name}
              className="grid grid-cols-[6.5rem_minmax(0,1fr)_2rem] items-center gap-2"
            >
              <span className="flex min-w-0 items-center gap-2 text-[0.8rem] text-si-muted">
                <Swatch color={c.color} />
                <span className="truncate">{c.name}</span>
              </span>
              <span
                className="h-2.5 rounded-r-[3px] bg-si-accent"
                style={{ width: `${(c.n / max) * 100}%` }}
              />
              <span className={cn(TC, 'text-right')}>{c.n}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-3 rounded-ctl border border-si-line bg-si-bg p-3">
        <span className={LABEL}>Speaker talk time</span>
        <div className="mt-3 flex h-3 gap-0.5 overflow-hidden rounded-full">
          {talk.map((t, i) => (
            <span key={t.who} className={tones[i]} style={{ width: `${t.pct}%` }} />
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {talk.map((t, i) => (
            <span key={t.who} className="flex items-center gap-1.5 text-[0.78rem] text-si-muted">
              <span className={cn('size-2 rounded-full', tones[i])} />
              {t.who} <span className={TC}>{t.pct}%</span>
            </span>
          ))}
        </div>
      </div>
    </MockFrame>
  );
}

/** Wiki: a person page with [[links]] and backlinks. */
export function WikiMock() {
  const link = cn(
    ACCENT_TEXT,
    'underline decoration-[color-mix(in_oklab,var(--si-accent)_45%,transparent)] underline-offset-2',
  );
  return (
    <MockFrame title="Show wiki" aside={<span className={TC}>r14</span>}>
      <h3 className="m-0 text-[1.375rem] font-semibold leading-tight">Dana Ruiz</h3>
      <p className="m-0 mt-1 text-[0.8rem] text-si-dim">Co-host · since Ep. 1</p>
      <div className="mt-4 flex flex-col gap-2.5 text-[0.875rem] leading-[1.55] text-si-muted">
        <p className="m-0">
          Runs the <span className={link}>Lightning Round</span> and keeps the running tally for the{' '}
          <span className={link}>Parking Ticket Saga</span>.
        </p>
        <p className="m-0">
          Toured with <span className={link}>Priya Nair</span> in 2024; first told the double-ticket
          story in <span className={link}>Ep. 112 recap</span>.
        </p>
      </div>
      <div className="mt-4 border-t border-si-line pt-3">
        <span className={LABEL}>Linked from</span>
        <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
          {['Ep. 112 recap', 'Ep. 109 recap', 'Lightning Round', 'Recurring bits'].map((t, i) => (
            <li
              key={t}
              className={cn(
                'flex items-center justify-between rounded-ctl px-2.5 py-1.5 text-[0.84rem]',
                i === 0 && SEL,
              )}
            >
              <span>{t}</span>
              <span className={TC}>{i < 2 ? 'Recap' : 'Page'}</span>
            </li>
          ))}
        </ul>
      </div>
    </MockFrame>
  );
}

/** Agents tab: attributed change log with per-change and per-call undo. */
export function AgentsMock() {
  const rows = [
    { op: 'topics.replace', what: '5 chapters', when: '2 min ago' },
    { op: 'dashboards.save', what: 'Episode stats', when: '3 min ago' },
    { op: 'wiki.upsert', what: 'Dana Ruiz', when: '4 min ago' },
  ];
  return (
    <MockFrame title="Agents · Change log">
      <div className="rounded-ctl border border-si-line bg-si-bg px-3 py-2.5 font-tc text-[0.72rem] leading-[1.5] text-si-muted">
        <span className="text-si-dim">$ </span>
        <span className="break-all">
          claude mcp add --transport http autologger https://autologger.example.com/mcp
        </span>
      </div>
      <div className="mt-4 overflow-hidden rounded-ctl border border-si-line">
        <div className="flex flex-wrap items-center gap-2 border-b border-si-line bg-[color-mix(in_oklab,var(--si-accent)_8%,var(--si-panel))] px-3 py-2.5">
          <Badge variant="outline">Claude Code</Badge>
          <span className="font-tc text-[0.75rem] text-si-fg">events.createMany</span>
          <span className="text-[0.8rem] text-si-muted">24 laughs logged</span>
          <span className="ml-auto inline-flex h-(--h-sm) items-center gap-1.5 rounded-ctl border border-si-line bg-si-panel-2 px-3 text-[0.8125rem] font-semibold">
            <Undo2 className="size-3.5" />
            Undo all 24
          </span>
        </div>
        {rows.map((r) => (
          <div
            key={r.op}
            className="flex items-center gap-3 border-b border-si-line px-3 py-2.5 last:border-b-0"
          >
            <span className="min-w-0 flex-1">
              <span className="block font-tc text-[0.75rem] text-si-fg">{r.op}</span>
              <span className="block truncate text-[0.8rem] text-si-muted">
                Claude · {r.what} · {r.when}
              </span>
            </span>
            <span className="inline-flex size-(--h-sm) shrink-0 items-center justify-center rounded-ctl border border-si-line bg-si-panel-2">
              <Undo2 className="size-3.5" />
            </span>
          </div>
        ))}
      </div>
    </MockFrame>
  );
}

/** Import dialog: a YouTube playlist becoming one session per video. */
export function ImportMock() {
  const videos = [
    { title: 'Ep. 110 · Sandwich court', state: 'Transcribed' },
    { title: 'Ep. 111 · The garage tapes', state: 'Transcribing' },
    { title: 'Ep. 112 · The long table', state: 'Downloading' },
    { title: 'Ep. 113 · Live in Tulsa', state: 'Queued' },
  ];
  return (
    <MockFrame title="Import · YouTube playlist">
      <div className="flex h-(--h-ctl) items-center rounded-ctl border border-(--si-line-strong) bg-si-bg px-2.5 text-[0.84rem] text-si-muted">
        <span className="truncate">youtube.com/playlist?list=PL7tL0ng-Table</span>
      </div>
      <ul className="m-0 mt-3 flex list-none flex-col gap-1.5 p-0">
        {videos.map((v) => (
          <li
            key={v.title}
            className="flex items-center justify-between gap-3 rounded-ctl border border-si-line bg-si-bg px-3 py-2"
          >
            <span className="min-w-0 truncate text-[0.84rem]">{v.title}</span>
            <Badge variant={v.state === 'Transcribed' ? 'secondary' : 'outline'}>{v.state}</Badge>
          </li>
        ))}
      </ul>
    </MockFrame>
  );
}

/** Export tab: the download formats. */
export function ExportMock() {
  const formats = [
    ['Event feed CSV', 'events.csv'],
    ['Transcript subtitles (SRT)', 'transcript.srt'],
    ['Transcript (text)', 'transcript.txt'],
    ['Topics CSV', 'topics.csv'],
  ];
  return (
    <MockFrame title="Export">
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {formats.map(([label, file]) => (
          <li
            key={file}
            className="flex items-center justify-between gap-3 rounded-ctl border border-si-line bg-si-bg px-3 py-2"
          >
            <span className="min-w-0">
              <span className="block truncate text-[0.84rem]">{label}</span>
              <span className={TC}>{file}</span>
            </span>
            <Download className="size-4 shrink-0 text-si-muted" />
          </li>
        ))}
      </ul>
    </MockFrame>
  );
}
