import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asAgent, call, failsWith, makeUser, resetDb, setupDb, studio } from './harness.ts';

beforeAll(setupDb);
beforeEach(resetDb);

describe('episode numbers', () => {
  it('parallel creates without an episode get distinct numbers', async () => {
    const { owner, show } = await studio(); // the fixture session took episode 1
    const agent = asAgent(owner);
    const created = await Promise.all(
      Array.from({ length: 8 }, () => call(agent, 'sessions.create', { showId: show.id })),
    );
    expect(created.map((s) => Number(s.episode)).sort((a, b) => a - b)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect((await call(owner, 'shows.get', { showId: show.id })).nextEpisode).toBe(10);
  });

  it('explicit whole-number episodes move the counter past them', async () => {
    const owner = await makeUser('owner@example.com');
    const team = await call(owner, 'teams.create', { name: 'Studio' });
    const show = await call(owner, 'shows.create', { teamId: team.id, name: 'Tom Talks' });
    await call(owner, 'shows.update', { showId: show.id, code: 'TT', titleSuffix: 'episode' });
    const agent = asAgent(owner);
    await Promise.all(
      Array.from({ length: 19 }, (_, i) =>
        call(agent, 'sessions.create', { showId: show.id, episode: String(19 - i) }),
      ),
    );
    expect((await call(owner, 'shows.get', { showId: show.id })).nextEpisode).toBe(20);

    // Lower and non-numeric episodes leave the counter alone.
    await call(agent, 'sessions.create', { showId: show.id, episode: '3' });
    await call(agent, 'sessions.create', { showId: show.id, episode: '25b' });
    const next = await call(agent, 'sessions.create', { showId: show.id });
    expect(next).toMatchObject({ episode: '20', title: 'TT 20' });

    const outsider = asAgent(await makeUser('outsider@example.com'));
    await failsWith(
      call(outsider, 'sessions.create', { showId: show.id, episode: '99' }),
      'not_found',
    );
    expect((await call(owner, 'shows.get', { showId: show.id })).nextEpisode).toBe(21);
  });
});
