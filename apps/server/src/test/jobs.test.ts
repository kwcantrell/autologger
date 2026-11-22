import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, schema } from '../db/client.ts';
import { enqueueJob } from '../media/jobs.ts';
import { claimJob } from '../worker/queue.ts';
import { asAgent, call, failsWith, makeUser, resetDb, setupDb, studio } from './harness.ts';

beforeAll(setupDb);
beforeEach(resetDb);

describe('jobs.list', () => {
  it('lists a whole show’s jobs with session titles and a status filter', async () => {
    const { owner, team, show, session } = await studio();
    const second = await call(owner, 'sessions.create', { showId: show.id, title: 'Episode 2' });
    const other = await call(owner, 'shows.create', { teamId: team.id, name: 'Other' });
    const elsewhere = await call(owner, 'sessions.create', { showId: other.id });

    const job = (sessionId: string) =>
      enqueueJob(db, {
        kind: 'youtube_import',
        sessionId,
        actorId: owner.user.id,
        payload: { url: 'https://youtu.be/x' },
      });
    const done = await job(session.id);
    await db.update(schema.jobs).set({ status: 'done' }).where(eq(schema.jobs.id, done.id));
    const queued = await job(second.id);
    await job(elsewhere.id);

    const agent = asAgent(owner);
    const all = await call(agent, 'jobs.list', { showId: show.id });
    expect(all.map((j) => j.id).sort()).toEqual([done.id, queued.id].sort());
    expect(all.find((j) => j.id === queued.id)).toMatchObject({
      sessionId: second.id,
      sessionTitle: 'Episode 2',
    });

    const pending = await call(agent, 'jobs.list', {
      showId: show.id,
      status: ['queued', 'running'],
    });
    expect(pending.map((j) => j.id)).toEqual([queued.id]);

    const one = await call(agent, 'jobs.list', { sessionId: session.id });
    expect(one.map((j) => j.id)).toEqual([done.id]);
    expect(await call(agent, 'jobs.list', { showId: show.id, limit: 1 })).toHaveLength(1);
  });

  it('needs exactly one scope and read access to the show', async () => {
    const { show, session } = await studio();
    const outsider = asAgent(await makeUser('outsider@example.com'));
    await failsWith(call(outsider, 'jobs.list', { showId: show.id }), 'not_found');
    await failsWith(call(outsider, 'jobs.list', { sessionId: session.id }), 'not_found');
    await failsWith(call(outsider, 'jobs.list', {}), 'bad_request');
    await failsWith(
      call(outsider, 'jobs.list', { showId: show.id, sessionId: session.id }),
      'bad_request',
    );
  });
});

describe('job queue order', () => {
  it('runs an import’s transcription before imports queued after it', async () => {
    const { owner, session } = await studio();
    const spec = {
      kind: 'youtube_import' as const,
      sessionId: session.id,
      actorId: owner.user.id,
      payload: { url: 'https://youtu.be/x' },
    };
    const first = await enqueueJob(db, spec);
    const rest = [await enqueueJob(db, spec), await enqueueJob(db, spec)];

    expect((await claimJob())?.id).toBe(first.id);
    const transcribe = await enqueueJob(
      db,
      { kind: 'transcribe', sessionId: session.id, actorId: null, payload: { segmentId: 'aud_x' } },
      { after: first },
    );
    expect((await claimJob())?.id).toBe(transcribe.id);
    expect((await claimJob())?.id).toBe(rest[0]!.id);
  });

  it('also when the imports were queued in one transaction (same timestamps)', async () => {
    const { owner, session } = await studio();
    const spec = {
      kind: 'youtube_import' as const,
      sessionId: session.id,
      actorId: owner.user.id,
      payload: { url: 'https://youtu.be/x' },
    };
    const imports = await db.transaction(async (tx) => [
      await enqueueJob(tx, spec),
      await enqueueJob(tx, spec),
      await enqueueJob(tx, spec),
    ]);
    expect(new Set(imports.map((j) => j.createdAt.getTime())).size).toBe(1);

    const first = (await claimJob())!;
    const transcribe = await enqueueJob(
      db,
      { kind: 'transcribe', sessionId: session.id, actorId: null, payload: { segmentId: 'aud_x' } },
      { after: first },
    );
    expect((await claimJob())?.id).toBe(transcribe.id);
    expect(imports.map((j) => j.id)).toContain((await claimJob())?.id);
  });
});
