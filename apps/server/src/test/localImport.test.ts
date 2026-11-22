// The local import helper's server side (#245): sessions from a client-listed playlist, YouTube
// uploads over a personal access token, and compilations built locally.

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Storage "configured" (no Deepgram); presigning is local, object checks are stubbed.
vi.hoisted(() => {
  process.env.S3_BUCKET = 'test-bucket';
  process.env.S3_ACCESS_KEY_ID = 'test';
  process.env.S3_SECRET_ACCESS_KEY = 'test';
  process.env.S3_ENDPOINT = 'http://127.0.0.1:9';
});
const stored = vi.hoisted(() => ({ heads: new Map<string, number>(), deletes: [] as string[] }));
vi.mock('../media/s3.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../media/s3.ts')>()),
  presignUpload: async (key: string) => `http://upload.invalid/${key}`,
  headObject: async (key: string) =>
    stored.heads.has(key) ? { size: stored.heads.get(key)!, contentType: 'x' } : null,
  deleteObject: async (key: string) => {
    stored.deletes.push(key);
  },
}));

const { db, schema } = await import('../db/client.ts');
const { env } = await import('../env.ts');
const { createApp } = await import('../http/app.ts');
const { asAgent, call, failsWith, makeUser, resetDb, setupDb, studio } = await import(
  './harness.ts'
);

const { audioSegments, compilations, jobs, sessions } = schema;
const VIDEO_A = 'https://www.youtube.com/watch?v=aaaaaaaaaaa';
const VIDEO_B = 'https://youtu.be/bbbbbbbbbbb';

/** The fields these tests read from rpc results. */
type Data = { uploadUrl: string; segment: { id: string }; url: string; [k: string]: unknown };

/** POST /api/rpc/<op> with a bearer token, as the import helper does. */
async function rpc(token: string, op: string, input: unknown) {
  const res = await createApp().request(`/api/rpc/${op}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await res.json()) as {
    ok: boolean;
    data: Data;
    error?: { code: string; message: string };
  };
}

/** Upload one YouTube video's audio into a session over a PAT; returns the segment. */
async function uploadVideo(token: string, sessionId: string, url: string, priv = false) {
  const started = await rpc(token, 'media.createUpload', {
    sessionId,
    mimeType: 'audio/mp4',
    origin: 'youtube',
    youtube: { url, title: 'Episode audio', uploadDate: '2021-04-01', private: priv },
  });
  expect(started.ok).toBe(true);
  const key = new URL(started.data.uploadUrl).pathname.slice(1);
  stored.heads.set(key, 2048);
  const done = await rpc(token, 'media.completeUpload', {
    segmentId: started.data.segment.id,
    durationSec: 600,
  });
  expect(done.ok).toBe(true);
  return done.data;
}

describe('local import helper ops', () => {
  beforeAll(setupDb);
  beforeEach(async () => {
    await resetDb();
    stored.heads.clear();
    stored.deletes.length = 0;
  });

  it('creates sessions from a client-supplied video list without download jobs', async () => {
    const { owner, show } = await studio();
    const agent = asAgent(owner);
    // YouTube import may be off on the server: the client did the reading.
    const youtubeEnabled = env.youtubeEnabled;
    env.youtubeEnabled = false;
    try {
      const videos = [
        { url: VIDEO_A, title: 'First', durationSec: 3600, uploadDate: '2020-01-02' },
        { url: VIDEO_B, title: 'Second', durationSec: null },
      ];
      const dry = await call(agent, 'media.importPlaylist', {
        showId: show.id,
        videos,
        titleTemplate: '{episode}: {title}',
        dryRun: true,
      });
      expect(dry.created.map((c) => c.sessionId)).toEqual([null, null]);
      const out = await call(agent, 'media.importPlaylist', {
        showId: show.id,
        videos,
        titleTemplate: '{episode}: {title}',
      });
      expect(out).toMatchObject({
        playlistTitle: null,
        dryRun: false,
        created: [
          { title: '2: First', episode: '2', videoId: 'aaaaaaaaaaa', jobId: null },
          { title: '3: Second', episode: '3', videoId: 'bbbbbbbbbbb', jobId: null },
        ],
        skipped: [],
      });
      expect(await db.select().from(jobs)).toEqual([]);
      const [first] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, out.created[0]!.sessionId!));
      expect(first).toMatchObject({
        sourceKind: 'youtube',
        sourceUrl: VIDEO_A,
        episodeDate: '2020-01-02',
      });

      // Re-running (the helper resuming) skips them and says which session each video has.
      const again = await call(agent, 'media.importPlaylist', { showId: show.id, videos });
      expect(again.created).toEqual([]);
      expect(again.skipped.map((s) => [s.reason, s.sessionId])).toEqual([
        ['already_imported', out.created[0]!.sessionId],
        ['already_imported', out.created[1]!.sessionId],
      ]);
      await failsWith(
        call(agent, 'media.importPlaylist', {
          showId: show.id,
          videos: [{ url: 'https://example.com/x', title: 'Nope' }],
        }),
        'bad_request',
      );
    } finally {
      env.youtubeEnabled = youtubeEnabled;
    }
  });

  it('uploads a YouTube video over a personal access token and keeps its provenance', async () => {
    const { owner, session } = await studio();
    const { token } = await call(owner, 'tokens.createPat', { name: 'importer' });
    // An interrupted earlier upload is replaced, not left behind.
    const stale = await rpc(token, 'media.createUpload', {
      sessionId: session.id,
      mimeType: 'audio/webm',
      origin: 'youtube',
      youtube: { url: VIDEO_A },
    });
    expect(stale.ok).toBe(true);

    const seg = await uploadVideo(token, session.id, `${VIDEO_A}&t=5`, true);
    expect(seg).toMatchObject({
      origin: 'youtube',
      startSec: 0,
      status: 'ready',
      fileName: 'Episode audio',
      sourceUrl: VIDEO_A,
      sourcePrivate: true,
      durationSec: 600,
    });
    const segs = await db
      .select()
      .from(audioSegments)
      .where(eq(audioSegments.sessionId, session.id));
    expect(segs.map((s) => s.id)).toEqual([seg.id]);
    expect(stored.deletes).toHaveLength(1);
    const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id));
    expect(row).toMatchObject({
      sourceKind: 'youtube',
      sourceUrl: VIDEO_A,
      episodeDate: '2021-04-01',
    });
    const queued = await db.select().from(jobs).where(eq(jobs.sessionId, session.id));
    expect(queued.map((j) => j.kind)).toEqual(['waveform']);

    // youtube requires origin "youtube" and a YouTube video URL.
    const bad = await rpc(token, 'media.createUpload', {
      sessionId: session.id,
      mimeType: 'audio/mp4',
      origin: 'file',
      youtube: { url: VIDEO_A },
    });
    expect(bad.error?.code).toBe('bad_request');
  });

  it('builds a compilation of private sessions locally; the server refuses to', async () => {
    const { owner, show, session } = await studio();
    const { token } = await call(owner, 'tokens.createPat', { name: 'importer' });
    await uploadVideo(token, session.id, VIDEO_A, true);
    const agent = asAgent(owner);
    const clips = [{ sessionId: session.id, startSec: 10, endSec: 40 }];

    const refused = await call(agent, 'compilations.create', {
      showId: show.id,
      title: 'Server',
      clips,
      logEvents: false,
    }).catch((e: Error) => e);
    expect((refused as { code?: string }).code).toBe('bad_request');
    expect((refused as Error).message).toContain('buildLocally: true');

    const c = await call(agent, 'compilations.create', {
      showId: show.id,
      title: 'Local',
      clips,
      logEvents: false,
      buildLocally: true,
    });
    expect(c).toMatchObject({ status: 'queued', buildLocally: true });
    expect(c.progress).toContain(`autologger-import compile ${c.id}`);
    expect(await db.select().from(jobs).where(eq(jobs.kind, 'compile'))).toEqual([]);

    const plan = await rpc(token, 'compilations.createUpload', { compilationId: c.id });
    expect(plan.data).toMatchObject({
      sources: [{ sessionId: session.id, url: VIDEO_A, fromSec: 10, toSec: 40 }],
      headers: { 'Content-Type': 'video/mp4' },
    });
    const early = await rpc(token, 'compilations.completeUpload', { compilationId: c.id });
    expect(early.error?.code).toBe('conflict');
    stored.heads.set(new URL(plan.data.uploadUrl).pathname.slice(1), 9999);
    const done = await rpc(token, 'compilations.completeUpload', {
      compilationId: c.id,
      durationSec: 30.2,
    });
    expect(done.data).toMatchObject({ status: 'ready', sizeBytes: 9999, durationSec: 30.2 });
    expect(done.data.url).toContain(`compilations/${c.id}.mp4`);
    const [row] = await db.select().from(compilations).where(eq(compilations.id, c.id));
    expect(row!.objectKey).toBe(`shows/${show.id}/compilations/${c.id}.mp4`);
  });

  it('answers not_found to someone without access to the show', async () => {
    const { owner, show, session } = await studio();
    const { token } = await call(owner, 'tokens.createPat', { name: 'importer' });
    await uploadVideo(token, session.id, VIDEO_A, true);
    const c = await call(owner, 'compilations.create', {
      showId: show.id,
      title: 'Local',
      clips: [{ sessionId: session.id, startSec: 0, endSec: 5 }],
      logEvents: false,
      buildLocally: true,
    });
    const outsider = asAgent(await makeUser('outsider@example.com'));
    await failsWith(
      call(outsider, 'media.importPlaylist', {
        showId: show.id,
        videos: [{ url: VIDEO_A, title: 'X' }],
      }),
      'not_found',
    );
    await failsWith(
      call(outsider, 'media.createUpload', {
        sessionId: session.id,
        mimeType: 'audio/mp4',
        origin: 'youtube',
        youtube: { url: VIDEO_A, private: false },
      }),
      'not_found',
    );
    await failsWith(
      call(outsider, 'compilations.createUpload', { compilationId: c.id }),
      'not_found',
    );
    await failsWith(
      call(outsider, 'compilations.completeUpload', { compilationId: c.id }),
      'not_found',
    );
  });
});

describe('GET /api/importer/autologger-import.mjs', () => {
  it('serves the import helper as one file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'importer-'));
    const file = join(dir, 'autologger-import.mjs');
    await writeFile(file, '#!/usr/bin/env node\n// helper\n');
    const previous = env.importerFile;
    env.importerFile = file;
    try {
      const res = await createApp().request('/api/importer/autologger-import.mjs');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toContain('autologger-import.mjs');
      expect(await res.text()).toContain('// helper');
      env.importerFile = join(dir, 'missing.mjs');
      expect((await createApp().request('/api/importer/autologger-import.mjs')).status).toBe(404);
    } finally {
      env.importerFile = previous;
    }
  });
});
