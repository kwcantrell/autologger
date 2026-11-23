// Bulk import of local files (#358): media.importFiles creates one session and upload per file and
// recognizes files on re-runs; media.completeUploads finishes many, reporting missing parts (#357).

import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.S3_BUCKET = 'test-bucket';
  process.env.S3_ACCESS_KEY_ID = 'test';
  process.env.S3_SECRET_ACCESS_KEY = 'test';
  process.env.S3_ENDPOINT = 'http://127.0.0.1:9';
});
/** What finishUpload answers per object key (default: nothing arrived). */
const stored = vi.hoisted(() => new Map<string, { size: number } | { missing: number[] }>());
vi.mock('../media/s3.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../media/s3.ts')>();
  return {
    ...real,
    // The real plan, without signing or listing anything.
    presignUploadTarget: async (key: string, contentType: string, sizeBytes?: number | null) =>
      sizeBytes && sizeBytes > real.UPLOAD_PART_BYTES
        ? {
            headers: {},
            parts: real
              .partPlan(sizeBytes)
              .map((p) => ({ ...p, url: `http://part.invalid/${key}` })),
            expiresAt: new Date().toISOString(),
          }
        : {
            uploadUrl: `http://upload.invalid/${key}`,
            headers: { 'Content-Type': contentType },
            expiresAt: new Date().toISOString(),
          },
    finishUpload: async (key: string) => stored.get(key) ?? null,
  };
});

const { db, schema } = await import('../db/client.ts');
const { asAgent, call, failsWith, makeUser, resetDb, setupDb, studio } = await import(
  './harness.ts'
);

beforeAll(setupDb);
beforeEach(async () => {
  await resetDb();
  stored.clear();
});

const MiB = 1024 ** 2;
const FILES = [
  { fileName: 'Ep 1 - Pilot.mp3', sizeBytes: 5 * MiB, mimeType: 'audio/mpeg' },
  {
    fileName: 'ep2.flac',
    sizeBytes: 334 * MiB,
    mimeType: 'audio/flac',
    title: 'Second',
    episode: '2',
    episodeDate: '2019-03-04',
    keyTerms: ['Tom'],
  },
];

describe('media.importFiles', () => {
  it('creates a session and upload per file; re-runs resume or skip instead of duplicating', async () => {
    const { owner, show } = await studio();
    const agent = asAgent(owner);

    const dry = await call(agent, 'media.importFiles', {
      showId: show.id,
      files: FILES,
      dryRun: true,
    });
    expect(dry.files.map((f) => [f.status, f.title, f.sessionId, f.upload])).toEqual([
      ['created', 'Ep 1 - Pilot', null, undefined],
      ['created', 'Second', null, undefined],
    ]);
    expect(await db.select().from(schema.sessions)).toHaveLength(1); // studio()'s

    const first = await call(agent, 'media.importFiles', { showId: show.id, files: FILES });
    const [a, b] = first.files;
    expect(a).toMatchObject({ status: 'created', title: 'Ep 1 - Pilot' });
    expect(a!.upload?.uploadUrl).toBeDefined();
    // 334 MiB: 11 parts of at most 32 MiB, none over Cloudflare's 100 MB limit.
    expect(b!.upload?.parts).toHaveLength(11);
    expect(Math.max(...b!.upload!.parts!.map((p) => p.sizeBytes))).toBe(32 * MiB);
    const [session] = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, b!.sessionId!));
    expect(session).toMatchObject({
      title: 'Second',
      episode: '2',
      episodeDate: '2019-03-04',
      keyTerms: ['Tom'],
    });

    // Only the small file arrived; the big one is missing parts 4–11.
    const segs = await db.select().from(schema.audioSegments);
    const key = (id: string) => segs.find((s) => s.id === id)!.objectKey;
    stored.set(key(a!.segmentId!), { size: 5 * MiB });
    stored.set(key(b!.segmentId!), { missing: [4, 5, 6, 7, 8, 9, 10, 11] });
    const done = await call(agent, 'media.completeUploads', {
      segmentIds: [a!.segmentId!, b!.segmentId!],
      transcribe: false,
    });
    expect(done.completed.map((s) => [s.id, s.status])).toEqual([[a!.segmentId, 'ready']]);
    expect(done.pending).toEqual([
      {
        segmentId: b!.segmentId,
        message: expect.stringContaining('PUT parts 4–11'),
        missingParts: [4, 5, 6, 7, 8, 9, 10, 11],
      },
    ]);
    await failsWith(call(agent, 'media.completeUpload', { segmentId: b!.segmentId! }), 'conflict');

    // The same list again: the finished file is skipped, the unfinished one resumed in place.
    const again = await call(agent, 'media.importFiles', { showId: show.id, files: FILES });
    expect(again.files.map((f) => [f.status, f.sessionId, f.segmentId, Boolean(f.upload)])).toEqual(
      [
        ['skipped', a!.sessionId, a!.segmentId, false],
        ['resumed', b!.sessionId, b!.segmentId, true],
      ],
    );
    expect(await db.select().from(schema.sessions)).toHaveLength(3);

    // Without access to the show nothing is created.
    const outsider = await makeUser('outsider@example.com');
    await failsWith(
      call(outsider, 'media.importFiles', { showId: show.id, files: FILES }),
      'not_found',
    );
  });

  it('rejects non-media types and a file listed twice', async () => {
    const { owner, show } = await studio();
    await failsWith(
      call(owner, 'media.importFiles', {
        showId: show.id,
        files: [{ fileName: 'notes.txt', sizeBytes: 10, mimeType: 'text/plain' }],
      }),
      'bad_request',
    );
    await failsWith(
      call(owner, 'media.importFiles', { showId: show.id, files: [FILES[0]!, FILES[0]!] }),
      'bad_request',
    );
  });
});
