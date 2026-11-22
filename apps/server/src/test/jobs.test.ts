import { and, eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executeOp } from '../core/op.ts';
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
    // Waiting out a retry backoff: no position.
    const later = await job();
    await db
      .update(schema.jobs)
      .set({ runAfter: new Date(Date.now() + 60_000) })
      .where(eq(schema.jobs.id, later.id));
    const withLater = await call(agent, 'jobs.list', { sessionId: session.id });
    expect(withLater.find((j) => j.id === later.id)?.queuePosition).toBeUndefined();
    await db.delete(schema.jobs).where(eq(schema.jobs.id, later.id));

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

    // A change racing the first read is not missed (the watch starts before the transaction).
    const racing = (await claimJob())!;
    t = Date.now();
    const raced = call(agent, 'jobs.list', { ...pending, waitSec: 30 });
    await completeJob(racing);
    expect(await raced).toEqual([]);
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it('re-checks access after waiting, and stops waiting when the caller goes away', async () => {
    const { owner, team, show, session } = await studio();
    const imp = await enqueueJob(db, {
      kind: 'youtube_import',
      sessionId: session.id,
      actorId: owner.user.id,
      payload: { url: 'https://youtu.be/x' },
    });
    const agent = asAgent(owner);
    const input = { showId: show.id, status: ['queued' as const, 'running' as const] };

    // Aborted (client disconnected): returns the first answer at once, no re-run.
    const abort = new AbortController();
    const t = Date.now();
    setTimeout(() => abort.abort(), 100);
    const first = await executeOp(
      'jobs.list',
      { ...input, waitSec: 30 },
      agent,
      'mcp',
      abort.signal,
    );
    expect(Date.now() - t).toBeLessThan(2000);
    expect(first.map((j) => j.id)).toEqual([imp.id]);

    // Access removed while waiting: the re-run answers not_found.
    const waiting = call(agent, 'jobs.list', { ...input, waitSec: 30 });
    setTimeout(async () => {
      await db
        .delete(schema.teamMembers)
        .where(
          and(eq(schema.teamMembers.teamId, team.id), eq(schema.teamMembers.userId, owner.user.id)),
        );
      await completeJob((await claimJob())!);
    }, 100);
    await failsWith(waiting, 'not_found');
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
