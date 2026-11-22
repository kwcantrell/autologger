// Decorative product mocks for the landing page, filled with sample data and hidden from
// assistive tech (each feature row says the same thing in text) and from the keyboard (inert).
// Where the app has a presentational piece the mock renders that same component, so it follows
// the real UI: the log button; the Event feed, Transcript, Topics and Agents rows and their feed
// table; the stat, timeline and table dashboard widgets; the wiki page header, body and backlinks;
// the compilation card; the playlist import preview; the export list. The rest (the hero's top
// bar, clock and waveform, the Stream Deck page, ConnectCard's Claude Code line) is static markup
// in the app's Show Ignition classes and names the component it imitates: changed that
// component's look? Update its mock.
//
// The hero's mock and the shared kit (MockFrame, sample data) live in heroMock.tsx, the wiki and
// Ask & compile mocks (react-markdown) in wikiMocks.tsx. LandingPage loads this file and
// wikiMocks.tsx lazily, as their rows near the viewport, so the first paint needs only the hero.

import type {
  Change,
  PlaylistImport,
  Topic,
  TranscriptSegment,
  Widget,
} from '@autologger/contract';
import type { CSSProperties } from 'react';
import { PlaylistResult } from '@/routes/PlaylistResult';
import {
  StatWidget,
  TableWidget,
  TimelineWidget,
  WidgetFrame,
} from '@/session/dashboards/WidgetParts';
import { FeedTable } from '@/session/feed';
import { CHANGE_COLUMNS, ChangeRow } from '@/session/tabs/ChangeRow';
import { ExportOptions } from '@/session/tabs/ExportOptions';
import { SEGMENT_COLUMNS, SegmentRow } from '@/session/tabs/SegmentRow';
import { TOPIC_COLUMNS, TopicRow } from '@/session/tabs/TopicRow';
import { Badge } from '@/shared/components/ui/badge';
import { Input } from '@/shared/components/ui/input';
import { cn } from '@/shared/lib/utils';
import {
  CATS,
  HOST,
  LABEL,
  LIVE_PILL,
  MOCK_AT,
  MOCK_TABLE,
  MockFrame,
  MockLogButton,
  noop,
  resolved,
  TC,
} from './heroMock';

function Swatch({ color }: { color: string }) {
  return (
    <span
      className="size-2 shrink-0 rounded-[2px] bg-(--cat)"
      style={{ '--cat': color } as CSSProperties}
    />
  );
}

type StatW = Extract<Widget, { type: 'stat' }>;

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
