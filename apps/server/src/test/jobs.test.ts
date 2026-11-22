import { and, eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../core/ids.ts';
import { executeOp } from '../core/op.ts';
import { db, schema } from '../db/client.ts';
import { env } from '../env.ts';
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

  it('skips kinds with no free slot and claims the next job of another kind', async () => {
    const { owner, session } = await studio();
    const imp = await enqueueJob(db, {
      kind: 'youtube_import',
      sessionId: session.id,
      actorId: owner.user.id,
      payload: { url: 'https://youtu.be/x' },
    });
    const transcribe = await enqueueJob(db, {
      kind: 'transcribe',
      sessionId: session.id,
      actorId: null,
      payload: { segmentId: 'aud_x' },
    });

    expect(await claimJob(['youtube_import', 'transcribe'])).toBeNull();
    // The import is first in line, but its kind is full: the transcription runs instead.
    expect((await claimJob(['youtube_import']))?.id).toBe(transcribe.id);
    expect(await claimJob(['youtube_import'])).toBeNull();
    expect((await claimJob())?.id).toBe(imp.id);
  });
});

describe('job timing', () => {
  it('sets startedAt on claim and estimates etaSec from finished jobs; sessions.get shows it', async () => {
    const { owner, session } = await studio();
    const agent = asAgent(owner);
    const segment = async (durationSec: number) => {
      const id = newId('aud');
      await db.insert(schema.audioSegments).values({
        id,
        sessionId: session.id,
        ordinal: 0,
        durationSec,
        mimeType: 'audio/mpeg',
        origin: 'file',
        objectKey: `test/${id}`,
        status: 'ready',
      });
      return id;
    };
    expect((await call(agent, 'sessions.get', { sessionId: session.id })).transcriptJob).toBeNull();

    // History: transcriptions take 0.1 s per audio second (60 s for 10 min), imports 30 s.
    const ago = (sec: number) => new Date(Date.now() - sec * 1000);
    for (let i = 0; i < 3; i++) {
      const segmentId = await segment(600);
      await db.insert(schema.jobs).values([
        {
          id: newId('job'),
          kind: 'transcribe',
          status: 'done',
          sessionId: session.id,
          payload: { segmentId },
          startedAt: ago(1000),
          updatedAt: ago(940),
        },
        {
          id: newId('job'),
          kind: 'youtube_import',
          status: 'done',
          sessionId: session.id,
          payload: { url: 'https://youtu.be/x' },
          startedAt: ago(1000),
          updatedAt: ago(970),
        },
      ]);
    }

    const transcribe = await enqueueJob(db, {
      kind: 'transcribe',
      sessionId: session.id,
      actorId: null,
      payload: { segmentId: await segment(1200) },
    });
    const imp = await enqueueJob(db, {
      kind: 'youtube_import',
      sessionId: session.id,
      actorId: owner.user.id,
      payload: { url: 'https://youtu.be/y' },
    });
    const pending = { sessionId: session.id, status: ['queued' as const, 'running' as const] };
    const queued = await call(agent, 'jobs.list', pending);
    const byId = new Map(queued.map((j) => [j.id, j]));
    // Own duration: 1200 s of audio × 0.1. Import: 30 s + 1 job ahead × median 45 s ÷ concurrency.
    expect(byId.get(transcribe.id)).toMatchObject({
      queuePosition: 0,
      etaSec: 120,
      startedAt: null,
    });
    expect(byId.get(imp.id)).toMatchObject({
      queuePosition: 1,
      etaSec: Math.round(30 + 45 / env.workerConcurrency),
    });
    // The job expected to finish last.
    expect((await call(agent, 'sessions.get', { sessionId: session.id })).transcriptJob).toEqual({
      id: transcribe.id,
      kind: 'transcribe',
      status: 'queued',
      queuePosition: 0,
      etaSec: 120,
    });

    const claimed = (await claimJob())!;
    expect(claimed.id).toBe(transcribe.id);
    expect(claimed.startedAt).toBeInstanceOf(Date);
    await db
      .update(schema.jobs)
      .set({ startedAt: ago(100) })
      .where(eq(schema.jobs.id, claimed.id));
    const running = (await call(agent, 'jobs.list', pending)).find((j) => j.id === claimed.id)!;
    expect(running.status).toBe('running');
    expect(running.startedAt).not.toBeNull();
    expect(running.etaSec).toBeGreaterThanOrEqual(19);
    expect(running.etaSec).toBeLessThanOrEqual(20);

    await completeJob(claimed);
    await completeJob((await claimJob())!);
    expect((await call(agent, 'sessions.get', { sessionId: session.id })).transcriptJob).toBeNull();
  });

  it('sessions.get etaSec for an unfinished import includes the transcription when the length is known', async () => {
    const { owner, session } = await studio();
    const agent = asAgent(owner);
    // History: transcriptions take 0.1 s per audio second, imports 30 s.
    const ago = (sec: number) => new Date(Date.now() - sec * 1000);
    const segmentId = newId('aud');
    await db.insert(schema.audioSegments).values({
      id: segmentId,
      sessionId: session.id,
      ordinal: 0,
      durationSec: 600,
      mimeType: 'audio/mpeg',
      origin: 'file',
      objectKey: `test/${segmentId}`,
      status: 'ready',
    });
    await db.insert(schema.jobs).values([
      {
        id: newId('job'),
        kind: 'transcribe',
        status: 'done',
        sessionId: session.id,
        payload: { segmentId },
        startedAt: ago(1000),
        updatedAt: ago(940),
      },
      {
        id: newId('job'),
        kind: 'youtube_import',
        status: 'done',
        sessionId: session.id,
        payload: { url: 'https://youtu.be/x' },
        startedAt: ago(1000),
        updatedAt: ago(970),
      },
    ]);
    const imp = await enqueueJob(db, {
      kind: 'youtube_import',
      sessionId: session.id,
      actorId: owner.user.id,
      payload: { url: 'https://youtu.be/y', durationSec: 1200 },
    });
    // jobs.list: the download only. sessions.get: download + 1200 s × 0.1 of transcription.
    const [listed] = await call(agent, 'jobs.list', { sessionId: session.id, status: ['queued'] });
    expect(listed).toMatchObject({ id: imp.id, queuePosition: 0, etaSec: 30 });
    const get = () => call(agent, 'sessions.get', { sessionId: session.id });
    expect((await get()).transcriptJob).toMatchObject({ id: imp.id, etaSec: 150 });

    // Unknown length (media.importYoutube): the download only.
    await db
      .update(schema.jobs)
      .set({ payload: { url: 'https://youtu.be/y' } })
      .where(eq(schema.jobs.id, imp.id));
    expect((await get()).transcriptJob).toMatchObject({ id: imp.id, etaSec: 30 });

    const outsider = asAgent(await makeUser('outsider@example.com'));
    await failsWith(call(outsider, 'sessions.get', { sessionId: session.id }), 'not_found');
  });
});
