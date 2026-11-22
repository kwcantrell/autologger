import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId } from '../core/ids.ts';
import { db, schema } from '../db/client.ts';
import { enqueueJob } from '../media/jobs.ts';
import { asAgent, call, failsWith, makeUser, resetDb, setupDb, studio } from './harness.ts';

// Only enqueues jobs, so no Deepgram or S3 is needed; pretend transcription is configured.
vi.mock('../env.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../env.ts')>()),
  transcriptionConfigured: true,
}));

beforeAll(setupDb);
beforeEach(resetDb);

describe('media.retranscribe keyTerms', () => {
  it('passes one-off terms to the job and refuses them while a job is active', async () => {
    const { owner, session } = await studio();
    const agent = asAgent(owner);
    const segmentId = newId('aud');
    await db.insert(schema.audioSegments).values({
      id: segmentId,
      sessionId: session.id,
      ordinal: 0,
      mimeType: 'audio/mpeg',
      origin: 'file',
      objectKey: `test/${segmentId}`,
      status: 'transcribed',
    });

    const [job] = await call(agent, 'media.retranscribe', {
      sessionId: session.id,
      keyTerms: ['Olu Dara', 'Olu Dara'],
    });
    const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, job!.id));
    expect(row!.payload).toEqual({ segmentId, keyTerms: ['Olu Dara'] });

    // Without terms the active job is reused; with terms it is a conflict, not a silent no-op.
    const [again] = await call(agent, 'media.retranscribe', { sessionId: session.id });
    expect(again!.id).toBe(job!.id);
    await failsWith(
      call(agent, 'media.retranscribe', { sessionId: session.id, keyTerms: ['Akinyele'] }),
      'conflict',
    );
  });
});

describe('retrying one failed transcription', () => {
  it('jobs.list names the segment, and media.retranscribe redoes only that one', async () => {
    const { owner, team, show, session } = await studio();
    const segment = async (ordinal: number) => {
      const id = newId('aud');
      await db.insert(schema.audioSegments).values({
        id,
        sessionId: session.id,
        ordinal,
        mimeType: 'audio/mpeg',
        origin: 'file',
        objectKey: `test/${id}`,
        status: ordinal === 0 ? 'failed' : 'transcribed',
      });
      return id;
    };
    const broken = await segment(0);
    const fine = await segment(1);
    const job = (segmentId: string, status: 'failed' | 'done') =>
      enqueueJob(db, {
        kind: 'transcribe',
        sessionId: session.id,
        actorId: owner.user.id,
        payload: { segmentId },
      }).then(async (j) => {
        await db.update(schema.jobs).set({ status }).where(eq(schema.jobs.id, j.id));
        return j;
      });
    const failed = await job(broken, 'failed');
    await job(fine, 'done');

    const agent = asAgent(owner);
    const listed = await call(agent, 'jobs.list', { showId: show.id, status: ['failed'] });
    expect(listed).toMatchObject([{ id: failed.id, segmentId: broken }]);

    const reader = await makeUser('reader@example.com');
    await call(owner, 'teams.invite', { teamId: team.id, email: 'reader@example.com' });
    await call(owner, 'teams.setGrant', {
      teamId: team.id,
      userId: reader.user.id,
      showId: show.id,
      access: 'read',
    });
    await failsWith(
      call(reader, 'media.retranscribe', { sessionId: session.id, segmentId: broken }),
      'forbidden',
    );

    const retried = await call(agent, 'media.retranscribe', {
      sessionId: session.id,
      segmentId: broken,
    });
    expect(retried).toMatchObject([{ kind: 'transcribe', status: 'queued', segmentId: broken }]);
    const queued = await call(agent, 'jobs.list', { sessionId: session.id, status: ['queued'] });
    expect(queued.map((j) => j.segmentId)).toEqual([broken]);
  });
});
