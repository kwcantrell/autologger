import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId } from '../core/ids.ts';
import { db, schema } from '../db/client.ts';
import { asAgent, call, failsWith, resetDb, setupDb, studio } from './harness.ts';

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
