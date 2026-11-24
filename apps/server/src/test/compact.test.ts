import type { DashboardSpecInput } from '@autologger/contract';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../core/ids.ts';
import { db, schema } from '../db/client.ts';
import { asAgent, call, failsWith, makeUser, resetDb, setupDb, studio } from './harness.ts';

beforeAll(setupDb);
beforeEach(resetDb);

describe('compact by default for MCP callers', () => {
  it('MCP gets compact unless it passes compact: false; RPC keeps the full shape', async () => {
    const { owner, session } = await studio();
    const agent = asAgent(owner);
    const events = [{ category: 'Scene', atSec: 5 }];
    const ack = await call(agent, 'events.createMany', { sessionId: session.id, events });
    expect(ack).toEqual({ ids: [expect.any(String)], freeLabels: [] });
    const full = await call(agent, 'events.createMany', {
      sessionId: session.id,
      events,
      compact: false,
    });
    expect(full).toEqual([expect.objectContaining({ category: 'Scene', sessionId: session.id })]);
    // Same op over RPC (web): the full record, as before.
    const web = await call(owner, 'events.list', { sessionId: session.id });
    expect(web[0]).toHaveProperty('wallTime');
    const lines = await call(agent, 'events.list', { sessionId: session.id });
    expect(Object.keys(lines[0]!).sort()).toEqual(['atSec', 'category', 'id', 'message']);
  });

  it('sessions.get lists the show buttons for agents only', async () => {
    const { owner, session } = await studio();
    const forAgent = await call(asAgent(owner), 'sessions.get', { sessionId: session.id });
    expect(forAgent.categories).toEqual([
      { id: expect.any(String), name: 'Scene', kind: 'button' },
      {
        id: expect.any(String),
        name: 'Audio issue',
        kind: 'dropdown',
        options: ['Lav', 'Boom', 'Noise', 'Clipping'],
      },
      { id: expect.any(String), name: 'Note', kind: 'text' },
    ]);
    const forWeb = await call(owner, 'sessions.get', { sessionId: session.id });
    expect(forWeb).not.toHaveProperty('categories');
  });
});

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

  it('events.createMany returns { ids, freeLabels } and checks access', async () => {
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
    expect(res).toEqual({
      ids: [expect.any(String), expect.any(String)],
      freeLabels: [{ category: 'Laugh', indexes: [0, 1] }],
    });
    const named = await call(asAgent(owner), 'events.createMany', {
      sessionId: session.id,
      events: [{ category: 'scene', atSec: 1 }],
      compact: true,
    });
    expect(named.freeLabels).toEqual([]);
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

  it('topics.list returns [{ id, startSec, durationSec, level, title, summary }]', async () => {
    const { owner, session } = await studio();
    await call(owner, 'topics.replace', {
      sessionId: session.id,
      topics: [{ startSec: 60, durationSec: 30, title: 'Interview', summary: 'Dana on dogs' }],
    });
    const res = await call(asAgent(owner), 'topics.list', { sessionId: session.id, compact: true });
    expect(res).toEqual([
      {
        id: expect.any(String),
        startSec: 60,
        durationSec: 30,
        level: 1,
        title: 'Interview',
        summary: 'Dana on dogs',
      },
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

  it('events.list returns [{ id, atSec, category, message }] and checks access', async () => {
    const { owner, session } = await studio();
    await call(owner, 'events.create', {
      sessionId: session.id,
      category: 'Laugh',
      atSec: 3,
      message: 'ha',
    });
    const res = await call(asAgent(owner), 'events.list', { sessionId: session.id, compact: true });
    expect(res).toEqual([{ id: expect.any(String), atSec: 3, category: 'Laugh', message: 'ha' }]);
    const outsider = await makeUser('outsider@example.com');
    await failsWith(
      call(outsider, 'events.list', { sessionId: session.id, compact: true }),
      'not_found',
    );
  });

  it('wiki.upsert returns { id, title, kind, revision, unresolvedLinks } and stays undoable', async () => {
    const { owner, show } = await studio();
    const agent = asAgent(owner);
    await call(owner, 'wiki.upsert', {
      showId: show.id,
      kind: 'person',
      title: 'Dana Lee',
      aliases: ['Dana'],
      bodyMd: 'Host.',
    });
    const body = 'With [[dana]], [[Dana Lee|the host]], [[Tom Talks]] and [[ tom talks ]].';
    const created = await call(agent, 'wiki.upsert', {
      showId: show.id,
      kind: 'topic',
      title: 'Episode notes',
      bodyMd: body,
      compact: true,
    });
    expect(created).toEqual({
      id: expect.any(String),
      title: 'Episode notes',
      kind: 'topic',
      revision: 1,
      unresolvedLinks: ['Tom Talks'],
      citationCount: 0,
      badCitations: [],
      clampedCitations: [],
      relabeledCitations: [],
    });
    const updated = await call(agent, 'wiki.upsert', {
      showId: show.id,
      kind: 'topic',
      title: 'Episode notes',
      bodyMd: 'Links to [[Episode notes]] only.',
      compact: true,
    });
    expect(updated).toMatchObject({ id: created.id, revision: 2, unresolvedLinks: [] });

    const [latest] = await call(owner, 'changes.list', { showId: show.id, via: 'mcp' });
    await call(owner, 'changes.revert', { changeId: latest!.id });
    expect(await call(owner, 'wiki.get', { pageId: created.id })).toMatchObject({ bodyMd: body });

    const outsider = await makeUser('outsider@example.com');
    await failsWith(
      call(outsider, 'wiki.upsert', {
        showId: show.id,
        kind: 'topic',
        title: 'X',
        bodyMd: '',
        compact: true,
      }),
      'not_found',
    );
  });

  it('wiki.patch returns the compact page with unresolvedLinks', async () => {
    const { owner, show } = await studio();
    const page = await call(owner, 'wiki.upsert', {
      showId: show.id,
      kind: 'topic',
      title: 'Episode notes',
      bodyMd: 'Notes.',
    });
    const res = await call(asAgent(owner), 'wiki.patch', {
      pageId: page.id,
      append: 'See [[Tom Talks]] and [[Episode notes]].',
      compact: true,
    });
    expect(res).toEqual({
      id: page.id,
      title: 'Episode notes',
      kind: 'topic',
      revision: 2,
      unresolvedLinks: ['Tom Talks'],
      citationCount: 0,
      badCitations: [],
      clampedCitations: [],
      relabeledCitations: [],
    });
  });

  it('transcript.replace returns counts, and trimmed samples on a dry run', async () => {
    const { owner, session } = await studio();
    const agent = asAgent(owner);
    const filler = 'and then we talked about it for a while longer than planned';
    const ids = Array.from({ length: 100 }, () => newId('seg'));
    await db.insert(schema.transcriptSegments).values(
      ids.map((id, i) => ({
        id,
        sessionId: session.id,
        startSec: i * 10,
        endSec: i * 10 + 9,
        text: `${filler} so the doctor said ${filler} and ${filler}`,
        words: [],
      })),
    );
    const rules = [
      { find: 'doctor', replace: 'dr', wholeWord: true },
      { find: 'nowhere', replace: 'x' },
    ];
    const preview = await call(agent, 'transcript.replace', {
      sessionId: session.id,
      rules,
      dryRun: true,
      compact: true,
    });
    expect(preview).toMatchObject({
      dryRun: true,
      changed: 100,
      replacements: 100,
      rules: [{ find: 'doctor', count: 100 }],
    });
    // compact: true types the result as the compact shape: no narrowing needed.
    expect(preview.samples).toHaveLength(5);
    expect(preview.samples?.[0]).toEqual({
      id: ids[0],
      startSec: 0,
      before: '…planned so the doctor said and then…',
      after: '…planned so the dr said and then…',
    });
    expect(JSON.stringify(preview).length).toBeLessThan(2048);

    const applied = await call(agent, 'transcript.replace', {
      sessionId: session.id,
      rules,
      compact: true,
    });
    expect(applied).toEqual({
      dryRun: false,
      changed: 100,
      replacements: 100,
      rules: [{ find: 'doctor', count: 100 }],
    });
    expect(JSON.stringify(applied).length).toBeLessThan(2048);
    const [first] = await call(owner, 'transcript.get', { sessionId: session.id, toSec: 5 });
    expect(first!.text).toContain('so the dr said');
  });
});
