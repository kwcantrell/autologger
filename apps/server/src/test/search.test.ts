import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { call, resetDb, setupDb, studio } from './harness.ts';

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
});
