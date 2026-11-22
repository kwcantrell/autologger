import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../core/ids.ts';
import { db, schema } from '../db/client.ts';
import { call, failsWith, makeUser, resetDb, setupDb, studio } from './harness.ts';

beforeAll(setupDb);
beforeEach(resetDb);

describe('search', () => {
  it('tells same-titled sessions apart by their date', async () => {
    const { owner, show } = await studio();
    const a = await call(owner, 'sessions.create', {
      showId: show.id,
      title: 'Weekly roundup',
      episodeDate: '2026-11-01',
    });
    const b = await call(owner, 'sessions.create', {
      showId: show.id,
      title: 'Weekly roundup',
      episodeDate: '2026-11-08',
    });
    await call(owner, 'events.create', { sessionId: b.id, category: 'Note', message: 'banana' });

    const sessions = await call(owner, 'search', { query: 'roundup', kinds: ['session'] });
    expect(sessions.map((h) => [h.sessionId, h.sessionDate]).sort()).toEqual(
      [
        [a.id, '2026-11-01'],
        [b.id, '2026-11-08'],
      ].sort(),
    );

    const [moment] = await call(owner, 'search', { query: 'banana', kinds: ['event'] });
    expect(moment).toMatchObject({
      sessionId: b.id,
      sessionTitle: 'Weekly roundup',
      sessionDate: '2026-11-08',
    });
  });

  it('falls back to the creation time when there is no episode date, and is null for wiki pages', async () => {
    const { owner, show, session } = await studio();
    await call(owner, 'sessions.update', { sessionId: session.id, episodeDate: null });
    // The fixture session is titled "LNT <date>" (show code + date).
    await call(owner, 'wiki.upsert', {
      showId: show.id,
      kind: 'bit',
      title: 'Cold open',
      bodyMd: 'Every LNT starts here.',
    });

    const hits = await call(owner, 'search', { query: 'LNT', kinds: ['session', 'wiki'] });
    const sessionHit = hits.find((h) => h.kind === 'session');
    const wikiHit = hits.find((h) => h.kind === 'wiki');
    expect(sessionHit?.sessionDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(
      Math.abs(Date.parse(sessionHit!.sessionDate!) - Date.parse(session.createdAt)),
    ).toBeLessThan(1000);
    expect(wikiHit?.sessionDate).toBeNull();
  });

  it('gives transcript lines and topics an end, not events', async () => {
    const { owner, show, session } = await studio();
    await db.insert(schema.transcriptSegments).values({
      id: newId('seg'),
      sessionId: session.id,
      startSec: 12.5,
      endSec: 17,
      text: 'the bombing story',
      words: [],
    });
    await call(owner, 'topics.create', {
      sessionId: session.id,
      startSec: 60,
      durationSec: 90,
      title: 'Bombing on stage',
    });
    await call(owner, 'topics.create', { sessionId: session.id, startSec: 300, title: 'Bombing' });
    await call(owner, 'events.create', {
      sessionId: session.id,
      category: 'Note',
      message: 'bombing',
    });

    const hits = await call(owner, 'search', { query: 'bombing', showId: show.id });
    const ends = hits.map((h) => `${h.kind} ${h.kind === 'event' ? '' : h.atSec} ${h.endSec}`);
    expect(ends.sort()).toEqual([
      'event  null',
      'topic 300 null',
      'topic 60 150',
      'transcript 12.5 17',
    ]);

    const outsider = await makeUser('outsider@example.com');
    await failsWith(call(outsider, 'search', { query: 'bombing', showId: show.id }), 'not_found');
  });

  it('returns more than 100 hits when asked, up to 500', async () => {
    const { owner, show, session } = await studio();
    await call(owner, 'events.createMany', {
      sessionId: session.id,
      events: Array.from({ length: 150 }, (_, i) => ({
        category: 'Note',
        message: `bombing ${i}`,
        atSec: i,
      })),
    });
    const hits = await call(owner, 'search', {
      query: 'bombing',
      showId: show.id,
      kinds: ['event'],
      limit: 500,
    });
    expect(hits).toHaveLength(150);
    expect(await call(owner, 'search', { query: 'bombing', kinds: ['event'] })).toHaveLength(30);
    await failsWith(call(owner, 'search', { query: 'bombing', limit: 501 }), 'bad_request');
  });
});
