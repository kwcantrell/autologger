// Decorative product mocks for the landing page, filled with sample data and hidden from
// assistive tech (each feature row says the same thing in text) and from the keyboard (inert).
// Where the app has a presentational piece the mock renders that same component, so it follows
// the real UI: the log button; the Event feed, Transcript, Topics and Agents rows and their feed
// table; the stat, timeline and table dashboard widgets; the wiki page header, body and backlinks;
// the compilation card; the playlist import preview; the export list. The rest (the hero's top
// bar, clock and waveform, the Stream Deck page, ConnectCard's Claude Code line) is static markup
// in the app's Show Ignition classes and names the component it imitates: changed that
// component's look? Update its mock.

import type {
  Change,
  Compilation,
  PlaylistImport,
  SessionEvent,
  Topic,
  TranscriptSegment,
  Widget,
} from '@autologger/contract';
import type { CSSProperties, ReactNode } from 'react';
import { CompilationCard } from '@/routes/compilations/CompilationCard';
import { PlaylistResult } from '@/routes/PlaylistResult';
import { WikiMarkdown } from '@/routes/wiki/WikiMarkdown';
import { BacklinksSection, WikiPageHeader } from '@/routes/wiki/WikiPageParts';
import type { WikiResolver } from '@/routes/wiki/wikiShared';
import {
  StatWidget,
  TableWidget,
  TimelineWidget,
  WidgetFrame,
} from '@/session/dashboards/WidgetParts';
import { FeedTable } from '@/session/feed';
import { LogButton } from '@/session/LogButton';
import { CHANGE_COLUMNS, ChangeRow } from '@/session/tabs/ChangeRow';
import { EventRow, eventColumns } from '@/session/tabs/EventRow';
import { ExportOptions } from '@/session/tabs/ExportOptions';
import { SEGMENT_COLUMNS, SegmentRow } from '@/session/tabs/SegmentRow';
import { TOPIC_COLUMNS, TopicRow } from '@/session/tabs/TopicRow';
import { Badge } from '@/shared/components/ui/badge';
import { Input } from '@/shared/components/ui/input';
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
type StatW = Extract<Widget, { type: 'stat' }>;
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

const MOCK_TOPICS = [
  mockTopic(0, 252, 'Cold open: the double ticket', 'Two tickets, one car, zero minutes over.'),
  mockTopic(252, 678, 'Listener mail', 'Sandwich court rulings and a fan theory.'),
  mockTopic(930, 1391, 'Guest: Priya on touring', 'Twelve cities, one van, no parking.'),
  mockTopic(2321, 141, 'Ad break', 'Sponsor read, take 2.'),
  mockTopic(2462, 1030, 'Lightning round', 'Dana keeps the tally.'),
];

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
  return (
    <MockFrame title="Topics" aside={<span className={TC}>5 chapters</span>}>
      {/* No Level column (4th): in a half-width card it squeezes the times. */}
      <FeedTable columns={TOPIC_COLUMNS} maxHeight={cn(MOCK_TABLE, '[&_tr>:nth-child(4)]:hidden')}>
        {MOCK_TOPICS.map((t) => (
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

/** Dashboards tab: the real stat, timeline and table widgets, fed sample rows. */
export function DashboardMock() {
  const stats: StatW[] = [
    { id: 'events', type: 'stat', title: 'Events', span: 1, value: 128 },
    { id: 'talk', type: 'stat', title: 'Talk time', span: 1, value: 58, unit: 'min' },
    { id: 'laughs', type: 'stat', title: 'Laughs', span: 1, value: 41, caption: '0.7 a minute' },
  ];
  const timeline: Extract<Widget, { type: 'timeline' }> = {
    id: 'topics',
    type: 'timeline',
    title: 'Topic timeline',
    span: 4,
    at: 'startSec',
    duration: 'durationSec',
    label: 'title',
    data: MOCK_TOPICS.slice(0, 4).map((t) => ({
      startSec: t.startSec,
      durationSec: t.durationSec,
      title: t.title,
    })),
  };
  const byCategory: Extract<Widget, { type: 'table' }> = {
    id: 'by-category',
    type: 'table',
    title: 'Events by category',
    span: 4,
    columns: [
      { key: 'category', label: 'Category' },
      { key: 'events', label: 'Events' },
    ],
    data: [
      { category: CATS[0].name, events: 41 },
      { category: CATS[4].name, events: 18 },
      { category: CATS[1].name, events: 12 },
      { category: CATS[3].name, events: 6 },
    ],
  };
  return (
    <MockFrame title="Dashboard · Episode stats">
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-3 gap-2">
          {stats.map((w) => (
            <WidgetFrame key={w.id} widget={w}>
              <StatWidget widget={w} rows={[]} />
            </WidgetFrame>
          ))}
        </div>
        <WidgetFrame widget={timeline}>
          <TimelineWidget widget={timeline} rows={timeline.data ?? []} onSeek={noop} />
        </WidgetFrame>
        <WidgetFrame widget={byCategory}>
          <TableWidget widget={byCategory} rows={byCategory.data ?? []} />
        </WidgetFrame>
      </div>
    </MockFrame>
  );
}

// Sample wiki: the pages [[links]] resolve to and the sessions citations name.
const WIKI_PAGES = ['Lightning Round', 'Parking Ticket Saga', 'Priya Nair', 'Ep. 112 recap'];
const resolveWiki: WikiResolver = (title) =>
  WIKI_PAGES.includes(title) ? { id: `wiki-${WIKI_PAGES.indexOf(title)}`, title } : null;
const SESSION_TITLES: Record<string, string> = {
  ses109: 'Ep. 109 · Sandwich court',
  ses112: 'Ep. 112 · The long table',
  ses118: 'Ep. 118 · Live in Tulsa',
};
const sessionTitle = (id: string) => SESSION_TITLES[id] ?? null;

/** Wiki: a person page (the real header, body with [[links]] and a citation, and backlinks). */
export function WikiMock() {
  return (
    <MockFrame title="Show wiki">
      <div className="flex flex-col gap-4">
        <WikiPageHeader
          page={{
            kind: 'person',
            title: 'Dana Ruiz',
            aliases: ['Dana'],
            updatedBy: HOST,
            updatedAt: MOCK_AT,
            revision: 14,
            sessionId: null,
          }}
        />
        <WikiMarkdown
          body={[
            'Co-host since Ep. 1. Runs the [[Lightning Round]] and keeps the running tally for the [[Parking Ticket Saga]].',
            'Toured with [[Priya Nair]] in 2024; first told the double-ticket story in [[Ep. 112 recap]] [@ses112:2512-2541].',
          ].join('\n\n')}
          resolve={resolveWiki}
          sessionTitle={sessionTitle}
        />
        <BacklinksSection
          backlinks={[
            { id: 'wiki-3', title: 'Ep. 112 recap', kind: 'session' },
            { id: 'wiki-0', title: 'Lightning Round', kind: 'bit' },
            { id: 'wiki-1', title: 'Parking Ticket Saga', kind: 'bit' },
          ]}
        />
      </div>
    </MockFrame>
  );
}

/**
 * Ask & compile: a question page whose citations become one video (the real wiki body and
 * compilation card, building).
 */
export function CompileMock() {
  const compilation: Compilation = {
    id: 'comp-mock',
    showId: 'mock',
    title: 'The Parking Ticket Saga',
    status: 'running',
    progress: 'Cutting clip 2 of 3',
    etaSec: 60,
    clips: [
      { sessionId: 'ses109', sessionTitle: SESSION_TITLES.ses109!, startSec: 2462, endSec: 2590 },
      { sessionId: 'ses112', sessionTitle: SESSION_TITLES.ses112!, startSec: 750, endSec: 910 },
      { sessionId: 'ses118', sessionTitle: SESSION_TITLES.ses118!, startSec: 3855, endSec: 3940 },
    ],
    durationSec: 373,
    createdBy: HOST,
    createdAt: MOCK_AT,
    updatedAt: MOCK_AT,
  };
  return (
    <MockFrame title="Question" aside={<span className={TC}>3 citations</span>}>
      <div className="flex flex-col gap-4">
        <WikiMarkdown
          body={[
            '## How did the Parking Ticket Saga start?',
            'Dana got two tickets for the same spot on the same morning [@ses109:2462-2590], told it on air [@ses112:750-910] and kept a running tally until Tulsa [@ses118:3855-3940].',
          ].join('\n\n')}
          resolve={resolveWiki}
          sessionTitle={sessionTitle}
        />
        <ul className="m-0 list-none p-0">
          <CompilationCard
            c={compilation}
            canWrite
            onDelete={noop}
            deleting={false}
            onRetry={noop}
            retrying={false}
          />
        </ul>
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

/** Import dialog: a YouTube playlist previewed as one new session per video (PlaylistResult). */
export function ImportMock() {
  const preview: PlaylistImport = {
    playlistTitle: 'The Long Table · Season 3',
    dryRun: true,
    created: [
      ['Ep. 112 · The long table', 3492],
      ['Ep. 113 · The garage tapes', 3310],
      ['Ep. 114 · Live in Tulsa', 4105],
    ].map(([title, durationSec], i) => ({
      sessionId: null,
      title: String(title),
      episode: String(112 + i),
      videoId: `vid-${i}`,
      durationSec: Number(durationSec),
      jobId: null,
    })),
    skipped: [
      {
        videoId: 'vid-old',
        title: 'Ep. 111 · Sandwich court',
        reason: 'already_imported',
        sessionId: null,
      },
    ],
  };
  return (
    <MockFrame title="Import · YouTube playlist">
      <div className="flex flex-col gap-3">
        <Input readOnly value="https://www.youtube.com/playlist?list=PL7tL0ng-Table" />
        <PlaylistResult data={preview} onOpenSession={noop} />
      </div>
    </MockFrame>
  );
}

/** Export tab: the download formats (ExportOptions, without links). */
export function ExportMock() {
  return (
    <MockFrame title="Export">
      <ExportOptions />
    </MockFrame>
  );
}
