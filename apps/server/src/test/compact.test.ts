import type { DashboardSpecInput } from '@autologger/contract';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../core/ids.ts';
import { db, schema } from '../db/client.ts';
import { asAgent, call, failsWith, makeUser, resetDb, setupDb, studio } from './harness.ts';

beforeAll(setupDb);
beforeEach(resetDb);

describe('compact responses for bulk writes', () => {
  it('transcript.updateSegments returns { updated, ids } of changed segments', async () => {
    const { owner, session } = await studio();
    const ids = [newId('seg'), newId('seg'), newId('seg')];
    await db.insert(schema.transcriptSegments).values(
      ids.map((id, i) => ({
        id,
        sessionId: session.id,
        startSec: i * 10,
        endSec: i * 10 + 9,
        text: `line ${i}`,
        words: [],
      })),
    );
    const res = await call(asAgent(owner), 'transcript.updateSegments', {
      sessionId: session.id,
      updates: [
        { segmentId: ids[0]!, text: 'line zero' },
        { segmentId: ids[1]!, text: 'line 1' }, // no-op
        { segmentId: ids[2]!, speaker: 'Dana' },
      ],
      compact: true,
    });
    expect(res).toEqual({ updated: 2, ids: [ids[0], ids[2]] });
  });

  it('events.createMany returns [{ id, atSec, category }] and checks access', async () => {
    const { owner, session } = await studio();
    const events = [
      { category: 'Laugh', message: 'big laugh', atSec: 5 },
      { category: 'Laugh', message: 'bigger laugh', atSec: 20 },
    ];
    const res = await call(asAgent(owner), 'events.createMany', {
      sessionId: session.id,
      events,
      compact: true,
    });
    expect(res).toEqual([
      { id: expect.any(String), atSec: 5, category: 'Laugh' },
      { id: expect.any(String), atSec: 20, category: 'Laugh' },
    ]);
    const outsider = await makeUser('outsider@example.com');
    await failsWith(
      call(outsider, 'events.createMany', { sessionId: session.id, events, compact: true }),
      'not_found',
    );
  });

  it('topics.replace returns [{ id, startSec, level, title }]', async () => {
    const { owner, session } = await studio();
    const res = await call(asAgent(owner), 'topics.replace', {
      sessionId: session.id,
      topics: [
        { startSec: 60, title: 'Interview', summary: 'Long summary' },
        { startSec: 0, title: 'Cold open', level: 2 },
      ],
      compact: true,
    });
    expect(res).toEqual([
      { id: expect.any(String), startSec: 0, level: 2, title: 'Cold open' },
      { id: expect.any(String), startSec: 60, level: 1, title: 'Interview' },
    ]);
  });

  it('dashboards.save returns { id, revision } and stays undoable', async () => {
    const { owner, session } = await studio();
    const agent = asAgent(owner);
    const spec: DashboardSpecInput = {
      title: 'Overview',
      widgets: [{ id: 'n', type: 'markdown', markdown: 'hi' }],
    };
    const created = await call(agent, 'dashboards.save', {
      sessionId: session.id,
      spec,
      compact: true,
    });
    expect(created).toEqual({ id: expect.any(String), revision: 1 });
    const updated = await call(agent, 'dashboards.save', {
      sessionId: session.id,
      dashboardId: created.id,
      spec: { ...spec, title: 'Renamed' },
      compact: true,
    });
    expect(updated).toEqual({ id: created.id, revision: 2 });

    const [latest] = await call(owner, 'changes.list', { sessionId: session.id, via: 'mcp' });
    await call(owner, 'changes.revert', { changeId: latest!.id });
    expect(await call(owner, 'dashboards.get', { dashboardId: created.id })).toMatchObject({
      title: 'Overview',
      revision: 1,
    });
  });
});
