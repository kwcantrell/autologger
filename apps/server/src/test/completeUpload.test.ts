// media.completeUpload transcribe: false (#283): store the audio and draw its waveform only.

import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Storage and Deepgram "configured"; nothing reaches S3 or Deepgram (the op only queues jobs).
vi.hoisted(() => {
  process.env.S3_BUCKET = 'test-bucket';
  process.env.S3_ACCESS_KEY_ID = 'test';
  process.env.S3_SECRET_ACCESS_KEY = 'test';
  process.env.S3_ENDPOINT = 'http://127.0.0.1:9';
});
vi.mock('../env.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../env.ts')>()),
  transcriptionConfigured: true,
}));
vi.mock('../media/s3.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../media/s3.ts')>()),
  presignUpload: async () => 'http://upload.invalid/put',
  headObject: async () => ({ size: 1234, contentType: 'audio/wav' }),
  deleteObject: async () => {},
}));

const { db, schema } = await import('../db/client.ts');
const { asAgent, call, failsWith, makeUser, resetDb, setupDb, studio } = await import(
  './harness.ts'
);

beforeAll(setupDb);
beforeEach(resetDb);

describe('media.completeUpload transcribe', () => {
  it('queues transcription by default and only the waveform with transcribe: false', async () => {
    const { owner, session } = await studio();
    const agent = asAgent(owner);
    const upload = async () =>
      (
        await call(agent, 'media.createUpload', {
          sessionId: session.id,
          mimeType: 'audio/wav',
          origin: 'file',
          fileName: 'a.wav',
        })
      ).segment.id;
    const kinds = async (segmentId: string) =>
      (await db.select().from(schema.jobs).where(eq(schema.jobs.sessionId, session.id)))
        .filter((j) => (j.payload as { segmentId?: string }).segmentId === segmentId)
        .map((j) => j.kind)
        .sort();

    const a = await call(agent, 'media.completeUpload', { segmentId: await upload() });
    expect(await kinds(a.id)).toEqual(['transcribe', 'waveform']);

    const b = await call(agent, 'media.completeUpload', {
      segmentId: await upload(),
      transcribe: false,
    });
    expect(b.status).toBe('ready');
    expect(await kinds(b.id)).toEqual(['waveform']);

    // Someone without access to the session cannot finish its upload.
    const outsider = await makeUser('outsider@example.com');
    await failsWith(
      call(outsider, 'media.completeUpload', { segmentId: await upload(), transcribe: false }),
      'not_found',
    );
  });
});
