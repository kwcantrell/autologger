import { eq, sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Storage "configured" for this file only; the bucket is an in-memory map (key → last modified).
vi.hoisted(() => {
  process.env.S3_BUCKET = 'test-bucket';
  process.env.S3_ACCESS_KEY_ID = 'test';
  process.env.S3_SECRET_ACCESS_KEY = 'test';
  process.env.S3_ENDPOINT = 'http://127.0.0.1:9';
});
const bucket = vi.hoisted(() => new Map<string, Date>());
vi.mock('../media/s3.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../media/s3.ts')>()),
  presignUpload: async () => 'http://upload.invalid/put',
  deleteObject: async (key: string) => {
    bucket.delete(key);
  },
  deletePrefix: async (prefix: string) => {
    let n = 0;
    for (const k of [...bucket.keys()]) if (k.startsWith(prefix) && bucket.delete(k)) n++;
    return n;
  },
  listChildPrefixes: async (prefix: string) => [
    ...new Set(
      [...bucket.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => `${prefix}${k.slice(prefix.length).split('/')[0]}/`),
    ),
  ],
  listObjects: async (prefix: string) =>
    [...bucket]
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, lastModified]) => ({
        key,
        lastModified,
      })),
}));

const { db, schema } = await import('../db/client.ts');
const { newId } = await import('../core/ids.ts');
const { sweepMedia } = await import('../worker/sweep.ts');
const { call, resetDb, setupDb, studio } = await import('./harness.ts');

const { audioSegments } = schema;
const HOUR = 3600_000;
const ago = (h: number) => new Date(Date.now() - h * HOUR);

beforeAll(setupDb);
beforeEach(async () => {
  await resetDb();
  bucket.clear();
});

async function upload(owner: Awaited<ReturnType<typeof studio>>['owner'], sessionId: string) {
  const { segment } = await call(owner, 'media.createUpload', {
    sessionId,
    mimeType: 'audio/wav',
    origin: 'file',
  });
  const [row] = await db.select().from(audioSegments).where(eq(audioSegments.id, segment.id));
  bucket.set(row!.objectKey, new Date());
  return row!;
}

describe('media sweep', () => {
  it('removes uploads stuck in uploading past the age, keeps recent ones', async () => {
    const { owner, session } = await studio();
    const stale = await upload(owner, session.id);
    const fresh = await upload(owner, session.id);
    await db
      .update(audioSegments)
      .set({ createdAt: ago(25) })
      .where(eq(audioSegments.id, stale.id));

    const r = await sweepMedia({ uploadAgeMs: 24 * HOUR, dryRun: false });
    expect(r.ran).toBe(true);
    expect(r.uploads).toEqual([stale.id]);
    const left = await db.select({ id: audioSegments.id }).from(audioSegments);
    expect(left.map((s) => s.id)).toEqual([fresh.id]);
    expect([...bucket.keys()]).toEqual([fresh.objectKey]);
  });

  it('removes prefixes of deleted sessions and shows, keeps live ones and recent orphans', async () => {
    const { show, session } = await studio();
    const compId = newId('cmp');
    await db
      .insert(schema.compilations)
      .values({ id: compId, showId: show.id, title: 'Best of', clips: [], durationSec: 5 });
    const live = [
      `sessions/${session.id}/aud_old.wav`, // old object of a live session: never touched
      `shows/${show.id}/notes/keep.json`, // unknown shape under a live show: kept
      `shows/${show.id}/compilations/${compId}.mp4`,
    ];
    for (const k of live) bucket.set(k, ago(100));
    const goneSession = newId('ses');
    const goneShow = newId('shw');
    bucket.set(`sessions/${goneSession}/a.wav`, ago(48));
    bucket.set(`sessions/${goneSession}/a.peaks.json`, ago(30));
    bucket.set(`shows/${goneShow}/compilations/cmp_x.mp4`, ago(48));
    bucket.set(`shows/${show.id}/compilations/cmp_deleted.mp4`, ago(48));
    // Orphans touched within the grace period (an import still running): kept.
    const recent = newId('ses');
    bucket.set(`sessions/${recent}/old.wav`, ago(48));
    bucket.set(`sessions/${recent}/new.wav`, ago(1));
    bucket.set(`shows/${show.id}/compilations/cmp_new.mp4`, ago(1));

    const log = vi.spyOn(console, 'log');
    const r = await sweepMedia({ orphanGraceMs: 24 * HOUR, dryRun: false });
    expect(log).toHaveBeenLastCalledWith(
      expect.stringMatching(
        /^media sweep: 0 stuck uploads, 2 orphan prefixes, 1 compilation object removed; 2 orphans within grace; \d+ s$/,
      ),
    );
    log.mockRestore();
    expect(r.withinGrace).toBe(2);
    expect(r.prefixes.sort()).toEqual([`sessions/${goneSession}/`, `shows/${goneShow}/`].sort());
    expect(r.objects).toEqual([`shows/${show.id}/compilations/cmp_deleted.mp4`]);
    expect([...bucket.keys()].sort()).toEqual(
      [
        ...live,
        `sessions/${recent}/old.wav`,
        `sessions/${recent}/new.wav`,
        `shows/${show.id}/compilations/cmp_new.mp4`,
      ].sort(),
    );
  });

  it('dry run reports but deletes nothing', async () => {
    const { owner, session } = await studio();
    const stale = await upload(owner, session.id);
    await db
      .update(audioSegments)
      .set({ createdAt: ago(25) })
      .where(eq(audioSegments.id, stale.id));
    const gone = `sessions/${newId('ses')}/a.wav`;
    bucket.set(gone, ago(48));
    const before = [...bucket.keys()].sort();

    const log = vi.spyOn(console, 'log');
    const r = await sweepMedia({ dryRun: true });
    expect(log).toHaveBeenLastCalledWith(
      expect.stringMatching(
        /^media sweep \(dry run\): 1 stuck upload, 1 orphan prefix, 0 compilation objects would be removed; 0 orphans within grace; \d+ s$/,
      ),
    );
    log.mockRestore();
    expect(r).toMatchObject({
      dryRun: true,
      uploads: [stale.id],
      prefixes: [gone.replace(/a\.wav$/, '')],
    });
    expect([...bucket.keys()].sort()).toEqual(before);
    expect(await db.select().from(audioSegments)).toHaveLength(1);
  });

  it('skips while another worker holds the sweep lock', async () => {
    bucket.set(`sessions/${newId('ses')}/a.wav`, ago(48));
    const log = vi.spyOn(console, 'log');
    const r = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('autologger:media-sweep'))`);
      return sweepMedia({ dryRun: false });
    });
    expect(log).toHaveBeenLastCalledWith(
      'media sweep: skipped, another worker holds the sweep lock',
    );
    log.mockRestore();
    expect(r.ran).toBe(false);
    expect(bucket.size).toBe(1);
  });
});
