// The presentational pieces shared by the session workspace and the landing page mocks render from
// props alone (no query client, workspace context or socket), and the mocks stay decorative.

import type { Change, SessionEvent, Topic, TranscriptSegment } from '@autologger/contract';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WorkspaceMock } from '@/routes/landing/heroMock';
import { AgentsMock, LoggingMock, TopicsMock, TranscriptMock } from '@/routes/landing/mocks';
import { LogButton } from './LogButton';
import { ChangeRow } from './tabs/ChangeRow';
import { EventRow } from './tabs/EventRow';
import { SegmentRow } from './tabs/SegmentRow';
import { TopicRow } from './tabs/TopicRow';

const html = (n: ReactNode) => renderToStaticMarkup(n);
const row = (n: ReactNode) =>
  html(
    <table>
      <tbody>{n}</tbody>
    </table>,
  );
const noop = () => {};
const resolved = () => Promise.resolve();
const AT = '2026-03-14T20:00:00.000Z';

describe('shared session pieces', () => {
  it('LogButton shows the hotkey, latched state and a toggle’s name for screen readers', () => {
    const out = html(
      <LogButton hotkey={2} color="#3b82f6" label="Mic on" srName="Mic" latched="on" />,
    );
    expect(out).toContain('data-latched="on"');
    expect(out).toContain('--cat:#3b82f6');
    expect(out).toContain('<span class="sr-only">Mic: </span>Mic on');
    expect(out).toMatch(/<kbd[^>]*>2<\/kbd>/);
  });

  it('EventRow renders the session time without frames and the agent badge', () => {
    const e: SessionEvent = {
      id: 'e1',
      sessionId: 's',
      categoryId: null,
      category: 'Laugh',
      color: '#f59e0b',
      message: 'Dana on the ticket',
      value: null,
      timecodeFrames: 2531 * 30 + 7,
      atSec: 2531,
      wallTime: AT,
      take: 1,
      source: 'agent',
      createdBy: null,
      createdAt: AT,
      updatedAt: AT,
    };
    const out = row(
      <EventRow
        e={e}
        session={{ frameRate: 30, startOffsetFrames: 0, isRolling: false }}
        categories={[]}
        timeMode="session"
        editable={false}
        canWrite={false}
        onJump={noop}
        onSave={resolved}
        onDelete={noop}
      />,
    );
    expect(out).toContain('>00:42:11<');
    expect(out).toContain('Dana on the ticket');
    expect(out).toContain('>agent<');
    expect(out).not.toContain('Delete row');
  });

  it('SegmentRow lights the word under the playhead', () => {
    const s: TranscriptSegment = {
      id: 't1',
      sessionId: 's',
      audioSegmentId: null,
      startSec: 10,
      endSec: 12,
      speaker: 'Dana',
      text: 'Two tickets',
      words: [
        { w: 'Two', s: 10, e: 11 },
        { w: 'tickets', s: 11, e: 12 },
      ],
      edited: false,
    };
    const out = row(
      <SegmentRow
        s={s}
        active={false}
        playheadSec={11.5}
        canWrite={false}
        rolling={false}
        onSeek={noop}
        onRenameSpeaker={noop}
        onSaveText={resolved}
      />,
    );
    expect(out).toMatch(/bg-si-accent\/35[^>]*>tickets </);
    expect(out).not.toMatch(/bg-si-accent\/35[^>]*>Two </);
  });

  it('TopicRow is read-only without write access', () => {
    const t: Topic = {
      id: 'p1',
      sessionId: 's',
      startSec: 930,
      durationSec: 1391,
      level: 1,
      title: 'Guest: Priya',
      summary: 'On touring',
      createdBy: null,
      via: 'mcp',
      createdAt: AT,
    };
    const out = row(
      <TopicRow
        t={t}
        canWrite={false}
        rolling={false}
        onJump={noop}
        onSave={resolved}
        onDelete={noop}
      />,
    );
    expect(out).toContain('>Guest: Priya</textarea>');
    expect(out).toMatch(/aria-label="Title" readOnly=""/);
    expect(out).not.toContain('Delete topic');
  });

  it('ChangeRow offers to undo a whole call', () => {
    const c: Change = {
      id: 'c1',
      at: AT,
      actor: { id: 'u', name: 'Dana' },
      via: 'mcp',
      clientName: 'Claude Code',
      op: 'events.createMany',
      entity: 'event',
      entityId: 'e1',
      kind: 'create',
      summary: 'Laugh',
      sessionId: 's',
      showId: 'sh',
      revertedAt: null,
      revertOf: null,
      groupId: 'g1',
      groupSize: 24,
    };
    const out = row(
      <ChangeRow
        change={c}
        now={Date.parse(AT) + 120_000}
        sec={null}
        onJump={noop}
        canWrite
        busy={false}
        error={undefined}
        onUndo={noop}
      />,
    );
    expect(out).toContain('Claude Code');
    expect(out).toContain('Undo all');
    expect(out).toContain(' and 23 more');
  });

  it('landing mocks render the shared pieces, hidden and inert', () => {
    for (const Mock of [WorkspaceMock, LoggingMock, TranscriptMock, TopicsMock, AgentsMock]) {
      const out = html(<Mock />);
      expect(out).toMatch(/^<div aria-hidden="true" inert=""/);
    }
    expect(html(<LoggingMock />)).toContain('data-variant="log"');
    expect(html(<WorkspaceMock />)).toContain('>00:42:11<');
  });
});
