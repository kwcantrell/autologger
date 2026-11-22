import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Storage "configured" for this file only; the S3 calls are mocked so nothing leaves the process.
vi.hoisted(() => {
  process.env.S3_BUCKET = 'test-bucket';
  process.env.S3_ACCESS_KEY_ID = 'test';
  process.env.S3_SECRET_ACCESS_KEY = 'test';
  process.env.S3_ENDPOINT = 'http://127.0.0.1:9';
});
const deleted = vi.hoisted(() => [] as string[]);
vi.mock('../media/s3.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../media/s3.ts')>()),
  deletePrefix: async (prefix: string) => {
    deleted.push(prefix);
    return 1;
  },
}));

const { call, failsWith, makeUser, resetDb, setupDb, studio } = await import('./harness.ts');

beforeAll(setupDb);
beforeEach(async () => {
  await resetDb();
  deleted.length = 0;
});

describe('stored media of deleted sessions', () => {
  it('sessions.delete removes the session prefix after commit, only for a manager', async () => {
    const { owner, session } = await studio();
    const stranger = await makeUser('stranger@example.com');
    await failsWith(call(stranger, 'sessions.delete', { sessionId: session.id }), 'not_found');
    expect(deleted).toEqual([]);

    await call(owner, 'sessions.delete', { sessionId: session.id });
    expect(deleted).toEqual([`sessions/${session.id}/`]);
  });

  it('shows.delete and teams.delete remove every session prefix of what they delete', async () => {
    const { owner, team, show, session } = await studio();
    const second = await call(owner, 'sessions.create', { showId: show.id });
    await call(owner, 'shows.delete', { showId: show.id });
    expect(deleted.sort()).toEqual(
      [`sessions/${session.id}/`, `sessions/${second.id}/`, `shows/${show.id}/`].sort(),
    );

    deleted.length = 0;
    const other = await call(owner, 'shows.create', { teamId: team.id, name: 'Other' });
    const third = await call(owner, 'sessions.create', { showId: other.id });
    await call(owner, 'teams.delete', { teamId: team.id });
    expect(deleted).toEqual([`sessions/${third.id}/`, `shows/${other.id}/`]);
  });
});
