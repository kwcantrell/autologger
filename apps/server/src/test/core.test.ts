import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../core/ids.ts';
import { db, schema } from '../db/client.ts';
import { asAgent, call, failsWith, makeUser, resetDb, setupDb, studio } from './harness.ts';

beforeAll(setupDb);
beforeEach(resetDb);

describe('access control', () => {
  it('members reach a show only through a grant, and read grants cannot write', async () => {
    const { owner, team, show, session } = await studio();
    const member = await makeUser('member@example.com');
    await call(owner, 'teams.invite', { teamId: team.id, email: 'member@example.com' });

    expect(await call(member, 'shows.list', {})).toEqual([]);
    await failsWith(call(member, 'sessions.get', { sessionId: session.id }), 'not_found');

    await call(owner, 'teams.setGrant', {
      teamId: team.id,
      userId: member.user.id,
      showId: show.id,
      access: 'read',
    });
    expect((await call(member, 'sessions.get', { sessionId: session.id })).access).toBe('read');
    await failsWith(
      call(member, 'events.create', { sessionId: session.id, category: 'Note' }),
      'forbidden',
    );

    await call(owner, 'teams.setGrant', {
      teamId: team.id,
      userId: member.user.id,
      showId: show.id,
      access: 'write',
    });
    await call(member, 'events.create', { sessionId: session.id, category: 'Note', message: 'hi' });
    await failsWith(
      call(member, 'categories.save', { showId: show.id, categories: [] }),
      'forbidden',
    );
  });

  it('outsiders cannot see another team’s data and search does not leak it', async () => {
    const { session } = await studio();
    const outsider = await makeUser('outsider@example.com');
    await failsWith(call(outsider, 'events.list', { sessionId: session.id }), 'not_found');
    expect(await call(outsider, 'search', { query: 'Late' })).toEqual([]);
  });

  it('pending accounts can only read themselves', async () => {
    const pending = await makeUser('new@example.com', { status: 'pending' });
    expect((await call(pending, 'me.get', {})).status).toBe('pending');
    await failsWith(call(pending, 'teams.create', { name: 'x' }), 'forbidden');
  });

  it('the owner cannot leave without transferring ownership', async () => {
    const { owner, team } = await studio();
    const admin = await makeUser('admin@example.com');
    await call(owner, 'teams.invite', { teamId: team.id, email: admin.user.email, role: 'admin' });
    await failsWith(call(owner, 'teams.leave', { teamId: team.id }), 'conflict');
    await call(owner, 'teams.transferOwnership', { teamId: team.id, userId: admin.user.id });
    await call(owner, 'teams.leave', { teamId: team.id });
    expect((await call(admin, 'teams.list', {}))[0]?.role).toBe('owner');
  });

  it('web-only ops are not reachable from MCP', async () => {
    const { owner, team } = await studio();
    await failsWith(call(asAgent(owner), 'teams.delete', { teamId: team.id }), 'not_found');
  });
});

describe('timecode and events', () => {
  it('places events by explicit timecode, atSec, or the live transport', async () => {
    const { owner, session } = await studio();
    const a = await call(owner, 'events.create', {
      sessionId: session.id,
      category: 'Scene',
      timecode: '01:00:10:00',
    });
    expect(a.timecodeFrames).toBe(24 * 3610);
    expect(a.categoryId).not.toBeNull(); // matched the default "Scene" button

    const b = await call(asAgent(owner), 'events.create', {
      sessionId: session.id,
      category: 'Laugh',
      atSec: 2,
    });
    expect(b.timecodeFrames).toBe(24 * 3600 + 48);
    expect(b.source).toBe('agent');
    expect(b.categoryId).toBeNull(); // free label

    await failsWith(
      call(owner, 'events.create', {
        sessionId: session.id,
        category: 'Scene',
        timecode: '01:00:00:30',
      }),
      'bad_request',
    );

    const rolling = await call(owner, 'transport.start', { sessionId: session.id });
    expect(rolling.isRolling).toBe(true);
    expect(rolling.take).toBe(1);
    const stopped = await call(owner, 'transport.stop', { sessionId: session.id });
    expect(stopped.isRolling).toBe(false);
    expect(stopped.eventCount).toBe(2);
  });

  it('imports CSV and reports bad rows', async () => {
    const { owner, session } = await studio();
    const res = await call(owner, 'events.importCsv', {
      sessionId: session.id,
      csv: 'timecode,category,message\n01:00:01:00,Scene,"Opening, wide"\nnope,Scene,x\n',
    });
    expect(res.imported).toBe(1);
    expect(res.skipped).toEqual([{ line: 3, reason: 'bad timecode “nope”' }]);
    const [e] = await call(owner, 'events.list', { sessionId: session.id });
    expect(e?.message).toBe('Opening, wide');
    expect(e?.source).toBe('import');
  });
});

describe('change log and undo', () => {
  it('records agent writes with attribution and undoes them', async () => {
    const { owner, session } = await studio();
    const agent = asAgent(owner, 'Claude Code');
    await call(agent, 'topics.replace', {
      sessionId: session.id,
      topics: [
        { startSec: 0, title: 'Cold open' },
        { startSec: 60, title: 'Interview' },
      ],
    });
    const changes = await call(owner, 'changes.list', { sessionId: session.id, via: 'mcp' });
    expect(changes).toHaveLength(2);
    expect(changes.every((c) => c.clientName === 'Claude Code')).toBe(true);

    await call(owner, 'changes.revert', { changeId: changes[0]!.id });
    expect(await call(owner, 'topics.list', { sessionId: session.id })).toHaveLength(1);
    await failsWith(call(owner, 'changes.revert', { changeId: changes[0]!.id }), 'conflict');
  });

  it('restores a deleted event and refuses to undo a stale change', async () => {
    const { owner, session } = await studio();
    const e = await call(owner, 'events.create', {
      sessionId: session.id,
      category: 'Note',
      message: 'one',
    });
    await call(owner, 'events.update', { eventId: e.id, message: 'two' });
    const [update, create] = await call(owner, 'changes.list', { sessionId: session.id });
    await failsWith(call(owner, 'changes.revert', { changeId: create!.id }), 'conflict');
    await call(owner, 'changes.revert', { changeId: update!.id });
    expect((await call(owner, 'events.list', { sessionId: session.id }))[0]?.message).toBe('one');

    await call(owner, 'events.delete', { eventId: e.id });
    const [del] = await call(owner, 'changes.list', { sessionId: session.id });
    await call(owner, 'changes.revert', { changeId: del!.id });
    const [restored] = await call(owner, 'events.list', { sessionId: session.id });
    expect(restored?.id).toBe(e.id);
    expect(restored?.createdAt).toBe(e.createdAt);
  });
});

describe('dashboards and wiki', () => {
  it('validates dashboard specs and evaluates live queries', async () => {
    const { owner, session } = await studio();
    await call(owner, 'events.create', { sessionId: session.id, category: 'Scene', atSec: 1 });
    await call(owner, 'events.create', { sessionId: session.id, category: 'Scene', atSec: 400 });
    const rows = await call(owner, 'dashboards.query', {
      sessionId: session.id,
      query: { name: 'events_over_time', bucketSec: 300 },
    });
    expect(rows).toEqual([
      { atSec: 0, category: 'Scene', count: 1 },
      { atSec: 300, category: 'Scene', count: 1 },
    ]);
    await failsWith(
      call(owner, 'dashboards.save', {
        sessionId: session.id,
        // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid widget type
        spec: { title: 'x', widgets: [{ id: 'a', type: 'html' }] } as any,
      }),
      'bad_request',
    );
  });

  it('summary_stats reports speech duration and words per minute', async () => {
    const { owner, session } = await studio();
    const stats = () =>
      call(owner, 'dashboards.query', { sessionId: session.id, query: { name: 'summary_stats' } });
    expect(await stats()).toMatchObject([{ words: 0, speechSec: 0, wpm: null }]);
    const word = (w: string) => ({ w, s: 0, e: 0 });
    await db.insert(schema.transcriptSegments).values([
      {
        id: newId('seg'),
        sessionId: session.id,
        startSec: 10,
        endSec: 40,
        text: 'a b',
        words: [word('a'), word('b')],
      },
      {
        id: newId('seg'),
        sessionId: session.id,
        startSec: 60,
        endSec: 70,
        text: 'c',
        words: [word('c')],
      },
    ]);
    // 3 words over 60s (10 → 70), gaps included.
    expect(await stats()).toMatchObject([{ words: 3, speechSec: 60, wpm: 3 }]);
    const outsider = await makeUser('outsider@example.com');
    await failsWith(
      call(outsider, 'dashboards.query', {
        sessionId: session.id,
        query: { name: 'summary_stats' },
      }),
      'not_found',
    );
  });

  it('upserts wiki pages by title or alias and keeps revisions', async () => {
    const { owner, show } = await studio();
    const p = await call(owner, 'wiki.upsert', {
      showId: show.id,
      kind: 'person',
      title: 'Dana Ruiz',
      bodyMd: 'Host.',
      aliases: ['Dana'],
    });
    const q = await call(owner, 'wiki.upsert', {
      showId: show.id,
      kind: 'person',
      title: 'dana',
      bodyMd: 'Host of the show.',
    });
    expect(q.id).toBe(p.id);
    expect(q.revision).toBe(2);
    await call(owner, 'wiki.upsert', {
      showId: show.id,
      kind: 'bit',
      title: 'Cold Open',
      bodyMd: 'With [[Dana]].',
    });
    await call(owner, 'wiki.upsert', {
      showId: show.id,
      kind: 'topic',
      title: 'Recap',
      bodyMd: 'Thanks [[Dana Ruiz|our host]].',
    });
    expect((await call(owner, 'wiki.get', { pageId: p.id })).backlinks.map((b) => b.title)).toEqual(
      ['Cold Open', 'Recap'],
    );
    expect(await call(owner, 'wiki.revisions', { pageId: p.id })).toHaveLength(2);
  });
});
