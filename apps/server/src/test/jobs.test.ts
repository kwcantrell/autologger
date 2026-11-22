import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, schema } from '../db/client.ts';
import { enqueueJob } from '../media/jobs.ts';
import { claimJob, completeJob, setProgress } from '../worker/queue.ts';
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

  it('shows queue positions and waits for a job to finish (waitSec)', async () => {
    const { owner, show, session } = await studio();
    const job = () =>
      enqueueJob(db, {
        kind: 'youtube_import',
        sessionId: session.id,
        actorId: owner.user.id,
        payload: { url: 'https://youtu.be/x' },
      });
    const first = await job();
    const second = await job();
    const agent = asAgent(owner);
    const pending = { showId: show.id, status: ['queued' as const, 'running' as const] };

    const queued = await call(agent, 'jobs.list', pending);
    expect(queued.find((j) => j.id === first.id)?.queuePosition).toBe(0);
    expect(queued.find((j) => j.id === second.id)?.queuePosition).toBe(1);

    // Nothing changes: answers after waitSec.
    let t = Date.now();
    expect(await call(agent, 'jobs.list', { ...pending, waitSec: 1 })).toHaveLength(2);
    expect(Date.now() - t).toBeGreaterThanOrEqual(900);

    // A progress update doesn't end the wait; finishing a job does.
    const running = (await claimJob())!;
    t = Date.now();
    setTimeout(() => void setProgress(running, 'Downloading'), 100);
    setTimeout(() => void completeJob(running), 400);
    const after = await call(agent, 'jobs.list', { ...pending, waitSec: 30 });
    expect(Date.now() - t).toBeGreaterThanOrEqual(350);
    expect(Date.now() - t).toBeLessThan(5000);
    expect(after.map((j) => [j.id, j.status, j.queuePosition])).toEqual([[second.id, 'queued', 0]]);
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
