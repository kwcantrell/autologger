import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { transcriptionOptionsFor } from '../worker/handlers.ts';
import { call, failsWith, makeUser, resetDb, setupDb, studio } from './harness.ts';

beforeAll(setupDb);
beforeEach(resetDb);

describe('show transcription settings', () => {
  it('default to smart formatting with no key terms, and shows.update persists them', async () => {
    const { owner, show, session } = await studio();
    expect(show).toMatchObject({ smartFormat: true, keyTerms: [] });
    expect(await transcriptionOptionsFor(session.id)).toEqual({ smartFormat: true, keyTerms: [] });

    const updated = await call(owner, 'shows.update', {
      showId: show.id,
      smartFormat: false,
      keyTerms: [' dx ', 'L’Hôpital', 'dx'],
    });
    expect(updated).toMatchObject({ smartFormat: false, keyTerms: ['dx', 'L’Hôpital'] });
    expect(await call(owner, 'shows.get', { showId: show.id })).toMatchObject({
      smartFormat: false,
      keyTerms: ['dx', 'L’Hôpital'],
    });
    // The transcribe job reads them when it runs, so a retranscribe uses the new settings.
    expect(await transcriptionOptionsFor(session.id)).toEqual({
      smartFormat: false,
      keyTerms: ['dx', 'L’Hôpital'],
    });

    // Other fields leave them alone; [] clears the list.
    await call(owner, 'shows.update', { showId: show.id, name: 'Calculus' });
    expect(await call(owner, 'shows.get', { showId: show.id })).toMatchObject({
      smartFormat: false,
      keyTerms: ['dx', 'L’Hôpital'],
    });
    await call(owner, 'shows.update', { showId: show.id, keyTerms: [] });
    expect((await call(owner, 'shows.get', { showId: show.id })).keyTerms).toEqual([]);

    await failsWith(
      call(owner, 'shows.update', {
        showId: show.id,
        keyTerms: Array.from({ length: 51 }, (_, i) => `t${i}`),
      }),
      'bad_request',
    );
  });

  it('only owners and admins can change them', async () => {
    const { owner, team, show } = await studio();
    const member = await makeUser('member@example.com');
    await call(owner, 'teams.invite', { teamId: team.id, email: 'member@example.com' });
    await failsWith(
      call(member, 'shows.update', { showId: show.id, smartFormat: false }),
      'not_found',
    );
    await call(owner, 'teams.setGrant', {
      teamId: team.id,
      userId: member.user.id,
      showId: show.id,
      access: 'write',
    });
    await failsWith(
      call(member, 'shows.update', { showId: show.id, keyTerms: ['dx'] }),
      'forbidden',
    );
    expect(await call(owner, 'shows.get', { showId: show.id })).toMatchObject({
      smartFormat: true,
      keyTerms: [],
    });
  });
});
