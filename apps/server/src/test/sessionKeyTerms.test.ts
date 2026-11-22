import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deepgramUrl } from '../media/deepgram.ts';
import { transcriptionOptionsFor } from '../worker/handlers.ts';
import { asAgent, call, failsWith, makeUser, resetDb, setupDb, studio } from './harness.ts';

beforeAll(setupDb);
beforeEach(resetDb);

const sentTerms = async (sessionId: string, override?: string[]) =>
  new URL(deepgramUrl(await transcriptionOptionsFor(sessionId, override))).searchParams.getAll(
    'keyterm',
  );

describe('session key terms', () => {
  it('reach the Deepgram request for that session only, ahead of the show terms', async () => {
    const { owner, show, session: other } = await studio();
    const agent = asAgent(owner);
    await call(owner, 'shows.update', { showId: show.id, keyTerms: ['Tom Talks'] });
    const ep3 = await call(agent, 'sessions.create', {
      showId: show.id,
      keyTerms: [' DJ Premier ', 'Olu Dara', 'DJ Premier'],
    });
    expect(ep3.keyTerms).toEqual(['DJ Premier', 'Olu Dara']);

    expect(await sentTerms(ep3.id)).toEqual(['DJ Premier', 'Olu Dara', 'Tom Talks']);
    expect(await sentTerms(other.id)).toEqual(['Tom Talks']);
    // A one-off list (media.retranscribe keyTerms) replaces the session's terms for that run.
    expect(await sentTerms(ep3.id, ['Akinyele'])).toEqual(['Akinyele', 'Tom Talks']);

    const updated = await call(agent, 'sessions.update', {
      sessionId: ep3.id,
      keyTerms: ['Akinyele'],
    });
    expect(updated.keyTerms).toEqual(['Akinyele']);
    // Other fields leave them alone; [] clears them.
    await call(agent, 'sessions.update', { sessionId: ep3.id, notes: 'x' });
    expect((await call(agent, 'sessions.get', { sessionId: ep3.id })).keyTerms).toEqual([
      'Akinyele',
    ]);
    await call(agent, 'sessions.update', { sessionId: ep3.id, keyTerms: [] });
    expect(await sentTerms(ep3.id)).toEqual(['Tom Talks']);
  });

  it('keep session terms when the combined list is over the Deepgram limits', async () => {
    const { owner, show } = await studio();
    const showTerms = Array.from({ length: 30 }, (_, i) => `show${i}`);
    const sessionTerms = Array.from({ length: 30 }, (_, i) => `guest${i}`);
    await call(owner, 'shows.update', { showId: show.id, keyTerms: showTerms });
    const s = await call(owner, 'sessions.create', { showId: show.id, keyTerms: sessionTerms });
    expect(await sentTerms(s.id)).toEqual([...sessionTerms, ...showTerms.slice(0, 20)]);
    await failsWith(
      call(owner, 'sessions.update', {
        sessionId: s.id,
        keyTerms: Array.from({ length: 51 }, (_, i) => `t${i}`),
      }),
      'bad_request',
    );
  });

  it('need write access to the session', async () => {
    const { owner, team, show, session } = await studio();
    const outsider = asAgent(await makeUser('outsider@example.com'));
    await failsWith(
      call(outsider, 'sessions.update', { sessionId: session.id, keyTerms: ['x'] }),
      'not_found',
    );
    const reader = await makeUser('reader@example.com');
    await call(owner, 'teams.invite', { teamId: team.id, email: 'reader@example.com' });
    await call(owner, 'teams.setGrant', {
      teamId: team.id,
      userId: reader.user.id,
      showId: show.id,
      access: 'read',
    });
    await failsWith(
      call(reader, 'sessions.update', { sessionId: session.id, keyTerms: ['x'] }),
      'forbidden',
    );
    await failsWith(
      call(reader, 'sessions.create', { showId: show.id, keyTerms: ['x'] }),
      'forbidden',
    );
    expect((await call(owner, 'sessions.get', { sessionId: session.id })).keyTerms).toEqual([]);
  });
});
