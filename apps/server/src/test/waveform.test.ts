import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Storage "configured" for this file only; nothing here talks to S3 (presigning is local and the
// calls that would reach the server are mocked below).
vi.hoisted(() => {
  process.env.S3_BUCKET = 'test-bucket';
  process.env.S3_ACCESS_KEY_ID = 'test';
  process.env.S3_SECRET_ACCESS_KEY = 'test';
  process.env.S3_ENDPOINT = 'http://127.0.0.1:9';
});
vi.mock('../media/s3.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../media/s3.ts')>()),
  presignUpload: async () => 'http://upload.invalid/put',
  headObject: async () => ({ size: 1234, contentType: 'audio/wav' }),
  deleteObject: async () => {},
}));

const { db, schema } = await import('../db/client.ts');
const { env } = await import('../env.ts');
const { newId } = await import('../core/ids.ts');
const { enqueueJob } = await import('../media/jobs.ts');
const { PeakAccumulator, PCM_RATE, PEAKS_PER_SEC, computePeaks, decodePeaks, encodePeaks } =
  await import('../media/waveform.ts');
const { backfillWaveforms, handlers } = await import('../worker/handlers.ts');
const { call, failsWith, makeUser, resetDb, setupDb, studio } = await import('./harness.ts');

const { audioSegments, jobs } = schema;

/** 0.5 s of silence, then 0.5 s of a half-scale 440 Hz sine, as s16le mono PCM. */
function fixturePcm(): Buffer {
  const n = PCM_RATE;
  const buf = Buffer.alloc(n * 2);
  for (let i = n / 2; i < n; i++)
    buf.writeInt16LE(Math.round(16384 * Math.sin((2 * Math.PI * 440 * i) / PCM_RATE)), i * 2);
  return buf;
}

function wav(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(PCM_RATE, 24);
  h.writeUInt32LE(PCM_RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function expectFixturePeaks(peaks: Uint8Array) {
  expect(peaks).toHaveLength(PEAKS_PER_SEC);
  expect([...peaks.slice(0, PEAKS_PER_SEC / 2)].every((p) => p === 0)).toBe(true);
  for (const p of peaks.slice(PEAKS_PER_SEC / 2)) expect(p).toBeGreaterThanOrEqual(126);
  for (const p of peaks.slice(PEAKS_PER_SEC / 2)) expect(p).toBeLessThanOrEqual(128);
}

describe('waveform peaks computation', () => {
  it('collects one peak per window from PCM in odd-sized chunks', () => {
    const pcm = fixturePcm();
    const acc = new PeakAccumulator();
    for (let i = 0; i < pcm.length; i += 777) acc.push(pcm.subarray(i, i + 777));
    const { peaks, durationSec } = acc.finish();
    expect(durationSec).toBe(1);
    expectFixturePeaks(peaks);
    const back = decodePeaks(encodePeaks(peaks, durationSec));
    expect(back).toMatchObject({ peaksPerSec: PEAKS_PER_SEC, durationSec: 1 });
    expect([...back.peaks]).toEqual([...peaks]);
  });

  it('keeps a trailing partial window and handles negative full scale', () => {
    const acc = new PeakAccumulator();
    const buf = Buffer.alloc(10 * 2);
    buf.writeInt16LE(-32768, 8);
    acc.push(buf);
    expect([...acc.finish().peaks]).toEqual([255]);
  });

  const hasFfmpeg = spawnSync(env.ffmpegPath, ['-version']).status === 0;
  it.skipIf(!hasFfmpeg)('decodes a WAV file with ffmpeg', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'autologger-wave-'));
    try {
      const path = join(dir, 'fixture.wav');
      await writeFile(path, wav(fixturePcm()));
      const { peaks, durationSec } = await computePeaks(env.ffmpegPath, path);
      expect(durationSec).toBeCloseTo(1, 2);
      expectFixturePeaks(peaks);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('waveform jobs and media.waveform', () => {
  beforeAll(setupDb);
  beforeEach(resetDb);
  const ffmpegPath = env.ffmpegPath;
  afterAll(() => {
    env.ffmpegPath = ffmpegPath;
  });

  async function segment(sessionId: string, ordinal: number, peaksKey: string | null) {
    const id = newId('aud');
    await db.insert(audioSegments).values({
      id,
      sessionId,
      ordinal,
      startSec: (ordinal - 1) * 60,
      durationSec: 60,
      mimeType: 'audio/wav',
      origin: 'file',
      objectKey: `sessions/${sessionId}/${id}.wav`,
      peaksKey,
      status: 'transcribed',
    });
    return id;
  }

  it('queues a waveform job after an upload, outside the transcript status', async () => {
    const { owner, session } = await studio();
    const up = await call(owner, 'media.createUpload', {
      sessionId: session.id,
      mimeType: 'audio/wav',
      origin: 'file',
      fileName: 'a.wav',
    });
    const seg = await call(owner, 'media.completeUpload', { segmentId: up.segment.id });
    expect(seg.hasWaveform).toBe(false);
    const queued = await db.select().from(jobs).where(eq(jobs.sessionId, session.id));
    expect(queued.map((j) => [j.kind, j.payload])).toEqual([['waveform', { segmentId: seg.id }]]);
    // Only transcript work counts as sessions.get transcriptJob.
    expect((await call(owner, 'sessions.get', { sessionId: session.id })).transcriptJob).toBe(null);
  });

  it('returns presigned peaks URLs for segments with peaks, to readers only', async () => {
    const { owner, session } = await studio();
    const withPeaks = await segment(session.id, 2, `sessions/${session.id}/seg.peaks.json`);
    await segment(session.id, 1, null);
    const list = await call(owner, 'media.waveform', { sessionId: session.id });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ segmentId: withPeaks, startSec: 60, durationSec: 60 });
    expect(list[0]!.url).toContain(`sessions/${session.id}/seg.peaks.json`);
    expect(list[0]!.url).toContain('X-Amz-Signature=');

    const stranger = await makeUser('stranger@example.com');
    await failsWith(call(stranger, 'media.waveform', { sessionId: session.id }), 'not_found');
  });

  it('skips without ffmpeg, and the startup backfill queues stored audio without peaks', async () => {
    const { owner, session } = await studio();
    const bare = await segment(session.id, 1, null);
    await segment(session.id, 2, `sessions/${session.id}/done.peaks.json`);
    const failedOne = await segment(session.id, 3, null);
    const failedJob = await enqueueJob(db, {
      kind: 'waveform',
      sessionId: session.id,
      actorId: owner.user.id,
      payload: { segmentId: failedOne },
    });
    await db.update(jobs).set({ status: 'failed' }).where(eq(jobs.id, failedJob.id));

    expect(await backfillWaveforms()).toBe(1);
    expect(await backfillWaveforms()).toBe(0); // already queued
    const [job] = await db.select().from(jobs).where(eq(jobs.status, 'queued'));
    expect(job).toMatchObject({ kind: 'waveform', payload: { segmentId: bare } });

    env.ffmpegPath = '/nonexistent/ffmpeg';
    const note = await handlers.waveform.run(job!);
    expect(note).toMatch(/^Skipped: ffmpeg not found on the worker/);
    const [row] = await db.select().from(audioSegments).where(eq(audioSegments.id, bare));
    expect(row!.peaksKey).toBeNull();
    // A skipped job ends done; the next startup with ffmpeg queues the segment again.
    await db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, job!.id));
    expect(await backfillWaveforms()).toBe(1);
  });
});
