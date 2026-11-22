import type { DashboardSpecInput } from '@autologger/contract';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../core/ids.ts';
import { db, schema } from '../db/client.ts';
import { asAgent, call, failsWith, makeUser, resetDb, setupDb, studio } from './harness.ts';

beforeAll(setupDb);
beforeEach(resetDb);

const size = (v: unknown) => JSON.stringify(v).length;

const sentence =
  'So the thing about running a live show is that you never really know what is going to happen next, and honestly that is half the fun of doing it every single week with these people.';

const dashboardSpec: DashboardSpecInput = {
  title: 'Episode overview',
  description: 'Counts, talk time and chapters for this episode.',
  widgets: [
    {
      id: 'events',
      type: 'stat',
      title: 'Events',
      span: 1,
      query: { name: 'summary_stats' },
      field: 'events',
    },
    {
      id: 'wpm',
      type: 'stat',
      title: 'Pace',
      span: 1,
      query: { name: 'summary_stats' },
      field: 'wpm',
      unit: 'wpm',
    },
    {
      id: 'cats',
      type: 'bar',
      title: 'Events by button',
      span: 2,
      query: { name: 'events_by_category' },
      x: 'category',
      y: 'count',
    },
    {
      id: 'talk',
      type: 'pie',
      title: 'Talk time',
      span: 2,
      query: { name: 'speaker_talk_time' },
      label: 'speaker',
      value: 'seconds',
    },
    {
      id: 'chapters',
      type: 'timeline',
      title: 'Chapters',
      span: 4,
      query: { name: 'topics', maxLevel: 1 },
      at: 'atSec',
      label: 'label',
      duration: 'durationSec',
    },
    {
      id: 'notes',
      type: 'markdown',
      title: 'Notes',
      span: 4,
      markdown: `## Highlights\n\n${sentence}\n\n${sentence}`,
    },
  ],
};

describe('compact responses for bulk writes', () => {
  it('return ids and counts instead of the full echo, and stay undoable', async () => {
    const { owner, session } = await studio();
    const agent = asAgent(owner, 'Claude Code');

    // transcript.updateSegments: 40 realistic speaker turns, full vs compact.
    const ids = Array.from({ length: 40 }, () => newId('seg'));
    await db.insert(schema.transcriptSegments).values(
      ids.map((id, i) => ({
        id,
        sessionId: session.id,
        startSec: i * 15,
        endSec: i * 15 + 14,
        speaker: 'Speaker 1',
        text: `${sentence} (${i})`,
        words: [],
      })),
    );
    const updates = (tag: string) =>
      ids.map((segmentId, i) => ({
        segmentId,
        text: `${sentence} [${tag} ${i}]`,
        speaker: 'Dana',
      }));
    const segFull = await call(agent, 'transcript.updateSegments', {
      sessionId: session.id,
      updates: updates('a'),
    });
    const segCompact = await call(agent, 'transcript.updateSegments', {
      sessionId: session.id,
      updates: [...updates('b').slice(0, 39), updates('a')[39]!], // last one is a no-op
      compact: true,
    });
    expect(segFull).toHaveProperty('segments');
    expect(segCompact).toEqual({ updated: 39, ids: ids.slice(0, 39) });

    // events.createMany
    const evInput = Array.from({ length: 40 }, (_, i) => ({
      category: 'Laugh',
      message: `Big laugh after the bit about the dog (${i})`,
      atSec: i * 15,
    }));
    const evFull = await call(agent, 'events.createMany', {
      sessionId: session.id,
      events: evInput,
    });
    const evCompact = await call(agent, 'events.createMany', {
      sessionId: session.id,
      events: evInput.slice(0, 2),
      compact: true,
    });
    expect(evCompact).toEqual([
      { id: expect.any(String), atSec: 0, category: 'Laugh' },
      { id: expect.any(String), atSec: 15, category: 'Laugh' },
    ]);

    // topics.replace
    const topics = Array.from({ length: 12 }, (_, i) => ({
      startSec: i * 50,
      durationSec: 50,
      title: `Chapter ${i}: the one about the dog`,
      summary: sentence,
    }));
    const tpFull = await call(agent, 'topics.replace', { sessionId: session.id, topics });
    const tpCompact = await call(agent, 'topics.replace', {
      sessionId: session.id,
      topics,
      compact: true,
    });
    expect(tpCompact).toHaveLength(12);
    expect(tpCompact[0]).toEqual({
      id: expect.any(String),
      startSec: 0,
      level: 1,
      title: 'Chapter 0: the one about the dog',
    });

    // dashboards.save
    const dbFull = await call(agent, 'dashboards.save', {
      sessionId: session.id,
      spec: dashboardSpec,
    });
    const dbCompact = await call(agent, 'dashboards.save', {
      sessionId: session.id,
      dashboardId: dbFull.id,
      spec: dashboardSpec,
      compact: true,
    });
    expect(dbCompact).toEqual({ id: dbFull.id, revision: 2 });

    // Compact acknowledgements are a small fraction of the full echo for the same input.
    const evCompactAll = evFull.map((e) => ({ id: e.id, atSec: e.atSec, category: e.category }));
    const ratios = {
      segments: size(segCompact) / size(segFull),
      events: size(evCompactAll) / size(evFull),
      topics: size(tpCompact) / size(tpFull),
      dashboard: size(dbCompact) / size(dbFull),
    };
    for (const r of Object.values(ratios)) expect(r).toBeLessThan(0.25);

    // Compact writes are still recorded and undoable.
    const [latest] = await call(owner, 'changes.list', { sessionId: session.id, via: 'mcp' });
    expect(latest).toMatchObject({ entity: 'dashboard', entityId: dbFull.id });
    await call(owner, 'changes.revert', { changeId: latest!.id });
    const reverted = await call(owner, 'dashboards.get', { dashboardId: dbFull.id });
    expect(reverted.revision).toBe(1);

    // Compact mode does not bypass authorization.
    const outsider = await makeUser('outsider@example.com');
    await failsWith(
      call(outsider, 'events.createMany', {
        sessionId: session.id,
        events: evInput.slice(0, 1),
        compact: true,
      }),
      'not_found',
    );
  });
});
