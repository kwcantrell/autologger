// The landing page hero's workspace mock, and the mock kit (MockFrame, sample data) that the
// feature mocks in mocks.tsx and wikiMocks.tsx build on. LandingPage imports this file directly,
// so it is part of the first paint; the feature mocks load lazily as their rows near the
// viewport. Keep heavy imports (react-markdown, charts) out of this file.

import type { SessionEvent } from '@autologger/contract';
import type { CSSProperties, ReactNode } from 'react';
import { FeedTable } from '@/session/feed';
import { LogButton } from '@/session/LogButton';
import { EventRow, eventColumns } from '@/session/tabs/EventRow';
import { Badge } from '@/shared/components/ui/badge';
import { cn } from '@/shared/lib/utils';

export const CATS = [
  { name: 'Laugh', color: '#f59e0b' },
  { name: 'Guest intro', color: '#3b82f6' },
  { name: 'Ad read', color: '#22c55e' },
  { name: 'Audio issue', color: '#ef4444' },
  { name: 'Clip it', color: '#a855f7' },
  { name: 'Note', color: '#a3a3a3' },
];

export const LABEL =
  'font-label text-[0.6875rem] font-semibold uppercase leading-none tracking-[0.12em] text-si-dim';
export const TC = 'font-tc text-[0.75rem] font-medium tabular-nums text-si-dim';
export const LIVE_PILL =
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

export const noop = () => {};
// The feed table's scroll area, minus the height cap and the scrollbars: a table wider than the
// card is cropped at its edge, like a screenshot.
export const MOCK_TABLE = 'overflow-hidden';
export const resolved = () => Promise.resolve();

/** CategoryStrip's LogButton, rendered as a plain span. */
export function MockLogButton({
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
export const MOCK_FPS = 30;
export const MOCK_AT = '2026-03-14T20:00:00.000Z';
export const HOST = { id: 'usr_mock', name: 'Dana Ruiz' };

export function mockEvent(
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
