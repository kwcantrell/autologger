// Decorative product mocks for the landing page, filled with sample data and hidden from
// assistive tech (each feature row says the same thing in text) and from the keyboard (inert).
// Where the app has a presentational piece (the log button; the Event feed, Transcript, Topics
// and Agents rows and their feed table) the mock renders that same component, so it follows the
// real UI. The rest is static markup in the app's Show Ignition classes; each such mock names the
// component it imitates: changed that component's look? Update its mock.

import type { Change, SessionEvent, Topic, TranscriptSegment } from '@autologger/contract';
import { Download, Play } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { FeedTable } from '@/session/feed';
import { LogButton } from '@/session/LogButton';
import { CHANGE_COLUMNS, ChangeRow } from '@/session/tabs/ChangeRow';
import { EventRow, eventColumns } from '@/session/tabs/EventRow';
import { SEGMENT_COLUMNS, SegmentRow } from '@/session/tabs/SegmentRow';
import { TOPIC_COLUMNS, TopicRow } from '@/session/tabs/TopicRow';
import { Badge } from '@/shared/components/ui/badge';
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
      inert
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

const noop = () => {};
// The feed table's scroll area, minus the height cap and the scrollbars: a table wider than the
// card is cropped at its edge, like a screenshot.
const MOCK_TABLE = 'overflow-hidden';
const resolved = () => Promise.resolve();

/** CategoryStrip's LogButton, rendered as a plain span. */
function MockLogButton({
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
    <LogButton
      nativeButton={false}
      render={<span />}
      hotkey={n}
      color={color}
      label={name}
      latched={pressed ? 'on' : undefined}
    />
  );
}

// Sample data in the contract's shapes, for the real row components.
const MOCK_FPS = 30;
const MOCK_AT = '2026-03-14T20:00:00.000Z';
const HOST = { id: 'usr_mock', name: 'Dana Ruiz' };

function mockEvent(
  sec: number,
  cat: { name: string; color: string },
  message: string,
  source: SessionEvent['source'] = 'operator',
): SessionEvent {
  return {
    id: `ev-${sec}`,
    sessionId: 'mock',
    categoryId: null,
    category: cat.name,
    color: cat.color,
    message,
    value: null,
    timecodeFrames: sec * MOCK_FPS,
    atSec: sec,
    wallTime: MOCK_AT,
    take: 2,
    source,
    createdBy: HOST,
    createdAt: MOCK_AT,
    updatedAt: MOCK_AT,
  };
}

/** A speaker turn with evenly spread word timings, so the word under the playhead lights up. */
function mockSegment(
  startSec: number,
  endSec: number,
  speaker: string,
  text: string,
): TranscriptSegment {
  const words = text.split(' ');
  const step = (endSec - startSec) / words.length;
  return {
    id: `seg-${startSec}`,
    sessionId: 'mock',
    audioSegmentId: null,
    startSec,
    endSec,
    speaker,
    text,
    words: words.map((w, i) => ({ w, s: startSec + i * step, e: startSec + (i + 1) * step })),
    edited: false,
  };
}

function mockTopic(startSec: number, durationSec: number, title: string, summary: string): Topic {
  return {
    id: `topic-${startSec}`,
    sessionId: 'mock',
    startSec,
    durationSec,
    level: 1,
    title,
    summary,
    createdBy: HOST,
    via: 'mcp',
    createdAt: MOCK_AT,
  };
}

function mockChange(
  minutesAgo: number,
  op: string,
  entity: Change['entity'],
  kind: Change['kind'],
  summary: string,
  groupSize?: number,
): Change {
  return {
    id: `chg-${minutesAgo}`,
    at: new Date(Date.parse(MOCK_AT) - minutesAgo * 60_000).toISOString(),
    actor: HOST,
    via: 'mcp',
    clientName: 'Claude Code',
    op,
    entity,
    entityId: `${entity}-${minutesAgo}`,
    kind,
    summary,
    sessionId: 'mock',
    showId: 'mock',
    revertedAt: null,
    revertOf: null,
    groupId: groupSize ? `grp-${minutesAgo}` : null,
    ...(groupSize ? { groupSize } : {}),
  };
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

/**
 * Hero: the session workspace, rolling. Log buttons and feed rows are the real components; the
 * top bar, clock and waveform are static (TransportStrip, Timeline).
 */
export function WorkspaceMock() {
  const feed = [
    mockEvent(2531, CATS[0], 'Dana on the parking ticket'),
    mockEvent(2388, CATS[4], 'Cold open candidate', 'agent'),
    mockEvent(2165, CATS[3], 'Mic 2 crackle', 'companion'),
    mockEvent(1880, CATS[2], 'Sponsor read, take 2'),
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
            <MockLogButton key={c.name} n={i + 1} name={c.name} color={c.color} pressed={i === 0} />
          ))}
        </div>
        <FeedTable columns={eventColumns('session')} maxHeight={MOCK_TABLE}>
          {feed.map((e) => (
            <EventRow
              key={e.id}
              e={e}
              session={{ frameRate: MOCK_FPS, startOffsetFrames: 0, isRolling: true }}
              categories={[]}
              timeMode="session"
              editable={false}
              canWrite={false}
              onJump={noop}
              onSave={resolved}
              onDelete={noop}
            />
          ))}
        </FeedTable>
      </div>
    </MockFrame>
  );
}

/**
 * Live logging: the logging strip (real LogButtons) plus a static Stream Deck page driven by
 * Companion (the presets in apps/companion).
 */
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
          <MockLogButton key={c.name} n={i + 1} name={c.name} color={c.color} pressed={i === 1} />
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

/** Transcript tab: speaker turns on the session clock, the word under the playhead lit. */
export function TranscriptMock() {
  const segments = [
    mockSegment(
      2512,
      2523,
      'Dana',
      'So the meter maid is standing there, and I have a parking ticket in each hand.',
    ),
    mockSegment(2523, 2529, 'Marcus', 'Two tickets. For one car.'),
    mockSegment(2529, 2535, 'Dana', 'Two tickets, one car, zero minutes over. I checked.'),
    mockSegment(2535, 2541, 'Priya', "This is going in the cold open, isn't it?"),
  ];
  const playhead = 2530.4;
  return (
    <MockFrame title="Transcript" aside={<span className={TC}>3 speakers · 58:12</span>}>
      <FeedTable columns={SEGMENT_COLUMNS} maxHeight={MOCK_TABLE}>
        {segments.map((s) => (
          // Not `active`: an active row scrolls itself into view, which would scroll the page.
          <SegmentRow
            key={s.id}
            s={s}
            active={false}
            playheadSec={playhead >= s.startSec && playhead < s.endSec ? playhead : null}
            canWrite={false}
            rolling={false}
            onSeek={noop}
            onRenameSpeaker={noop}
            onSaveText={resolved}
          />
        ))}
      </FeedTable>
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

/** Topics tab: chapters with start, length and an agent-written summary. */
export function TopicsMock() {
  const topics = [
    mockTopic(0, 252, 'Cold open: the double ticket', 'Two tickets, one car, zero minutes over.'),
    mockTopic(252, 678, 'Listener mail', 'Sandwich court rulings and a fan theory.'),
    mockTopic(930, 1391, 'Guest: Priya on touring', 'Twelve cities, one van, no parking.'),
    mockTopic(2321, 141, 'Ad break', 'Sponsor read, take 2.'),
    mockTopic(2462, 1030, 'Lightning round', 'Dana keeps the tally.'),
  ];
  return (
    <MockFrame title="Topics" aside={<span className={TC}>5 chapters</span>}>
      {/* No Level column (4th): in a half-width card it squeezes the times. */}
      <FeedTable columns={TOPIC_COLUMNS} maxHeight={cn(MOCK_TABLE, '[&_tr>:nth-child(4)]:hidden')}>
        {topics.map((t) => (
          <TopicRow
            key={t.id}
            t={t}
            canWrite={false}
            rolling={false}
            onJump={noop}
            onSave={resolved}
            onDelete={noop}
          />
        ))}
      </FeedTable>
    </MockFrame>
  );
}

/**
 * Dashboards tab: stat tiles, events by category, speaker talk time. Static: see
 * session/dashboards/widgets.tsx.
 */
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

/** Wiki: a person page with [[links]] and backlinks. Static: see routes/wiki/WikiPageView.tsx. */
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

/**
 * Ask & compile: a question page whose cited ranges become one video. Static: see
 * routes/wiki/WikiPageView.tsx and routes/compilations/CompilationsRoute.tsx.
 */
export function CompileMock() {
  const clips = [
    { ep: 'Ep. 109', range: '00:41:02–00:43:10', w: 30 },
    { ep: 'Ep. 112', range: '00:12:30–00:15:10', w: 38 },
    { ep: 'Ep. 118', range: '01:04:15–01:05:40', w: 20 },
  ];
  const shades = ['bg-si-accent', 'bg-[color-mix(in_oklab,var(--si-accent)_60%,var(--si-panel))]'];
  return (
    <MockFrame title="Question" aside={<span className={TC}>3 citations</span>}>
      <h3 className="m-0 text-[1.25rem] font-semibold leading-tight">
        How did the Parking Ticket Saga start?
      </h3>
      <p className="m-0 mt-2 text-[0.875rem] leading-[1.55] text-si-muted">
        Dana got two tickets for the same spot on the same morning, then kept a running tally.
      </p>
      <ul className="m-0 mt-4 flex list-none flex-col gap-1.5 p-0">
        {clips.map((c, i) => (
          <li
            key={c.ep}
            className={cn(
              'flex items-center gap-2.5 rounded-ctl border border-si-line px-2.5 py-1.5 text-[0.84rem]',
              i === 1 && SEL,
            )}
          >
            <Play className="size-3.5 shrink-0 text-si-dim" />
            <span className="font-semibold">{c.ep}</span>
            <span className={cn(TC, 'ml-auto')}>{c.range}</span>
          </li>
        ))}
      </ul>
      <div className="mt-4 border-t border-si-line pt-3">
        <div className="flex items-center justify-between gap-3">
          <span className={LABEL}>Compilation</span>
          <Badge variant="outline">Ready · 6:13 · 720p</Badge>
        </div>
        <div className="mt-3 flex h-2.5 gap-0.5 overflow-hidden rounded-full">
          {clips.map((c, i) => (
            <span key={c.ep} className={shades[i % 2]} style={{ flexGrow: c.w }} />
          ))}
        </div>
        <span className="mt-3 inline-flex h-(--h-sm) items-center gap-1.5 rounded-ctl border border-si-line bg-si-panel-2 px-3 text-[0.8125rem] font-semibold">
          <Download className="size-3.5" />
          Download MP4
        </span>
      </div>
    </MockFrame>
  );
}

/** Agents tab: ConnectCard's Claude Code line (static), then real change-log rows with undo. */
export function AgentsMock() {
  const changes = [
    mockChange(1, 'events.createMany', 'event', 'create', 'Laugh', 24),
    mockChange(2, 'topics.replace', 'topic', 'create', 'Cold open', 5),
    mockChange(3, 'dashboards.save', 'dashboard', 'create', 'Episode stats'),
    mockChange(4, 'wiki.upsert', 'wiki_page', 'update', 'Dana Ruiz'),
  ];
  return (
    <MockFrame title="Agents · Change log">
      <div className="rounded-ctl border border-si-line bg-si-bg px-3 py-2.5 font-tc text-[0.72rem] leading-[1.5] text-si-muted">
        <span className="text-si-dim">$ </span>
        <span className="break-all">
          claude mcp add --transport http autologger https://autologger.example.com/mcp
        </span>
      </div>
      <div className="mt-4">
        <FeedTable columns={CHANGE_COLUMNS} maxHeight={MOCK_TABLE}>
          {changes.map((c) => (
            <ChangeRow
              key={c.id}
              change={c}
              now={Date.parse(MOCK_AT)}
              sec={null}
              onJump={noop}
              canWrite
              busy={false}
              error={undefined}
              onUndo={noop}
            />
          ))}
        </FeedTable>
      </div>
    </MockFrame>
  );
}

/**
 * Import dialog: a YouTube playlist becoming one session per video. Static: see
 * routes/PlaylistImportForm.tsx.
 */
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

/** Export tab: the download formats. Static: see session/tabs/ExportTab.tsx. */
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
