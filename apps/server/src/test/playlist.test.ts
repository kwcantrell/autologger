import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, schema } from '../db/client.ts';
import { env } from '../env.ts';
import { handlers } from '../worker/handlers.ts';
import { asAgent, call, failsWith, makeUser, resetDb, setupDb, studio } from './harness.ts';

// No network, S3 or Deepgram: yt-dlp is a shell script printing canned JSON, the audio download
// and the S3 upload are stubbed.
vi.mock('../env.ts', async (orig) => {
  const mod = await orig<typeof import('../env.ts')>();
  return {
    ...mod,
    storageConfigured: true,
    transcriptionConfigured: false,
    env: { ...mod.env, youtubeEnabled: true },
  };
});
vi.mock('../media/s3.ts', async (orig) => ({
  ...(await orig<typeof import('../media/s3.ts')>()),
  putObjectFromFile: async () => 1234,
}));
vi.mock('../media/youtube.ts', async (orig) => ({
  ...(await orig<typeof import('../media/youtube.ts')>()),
  downloadAudio: async () => ({
    dir: '/nonexistent',
    path: '/nonexistent/audio.m4a',
    ext: 'm4a',
    mimeType: 'audio/mp4',
    title: 'Episode',
    durationSec: 3600,
    uploadDate: '2024-03-05',
    cleanup: async () => {},
  }),
}));

const PLAYLIST = 'https://www.youtube.com/playlist?list=PLtomtalks01';
const entry = (id: string, title: string, duration: number | null = 3600) => ({
  _type: 'url',
  id,
  title,
  duration,
  url: `https://www.youtube.com/watch?v=${id}`,
});
let jsonFile = '';
const playlist = (entries: unknown[]) =>
  writeFile(jsonFile, JSON.stringify({ _type: 'playlist', title: 'Tom Talks', entries }));

beforeAll(async () => {
  await setupDb();
  const dir = await mkdtemp(join(tmpdir(), 'fake-yt-dlp-'));
  jsonFile = join(dir, 'playlist.json');
  const script = join(dir, 'yt-dlp');
  await writeFile(script, `#!/bin/sh\ncat '${jsonFile}'\n`);
  await chmod(script, 0o755);
  env.ytDlpPath = script;
});
beforeEach(resetDb);

describe('media.importPlaylist', () => {
  it('creates one session and import job per video, and imports only new videos on re-run', async () => {
    const { owner, show } = await studio(); // studio() takes episode 1
    const agent = asAgent(owner);
    await playlist([
      entry('aaaaaaaaaaa', 'Newest talk'),
      entry('bbbbbbbbbbb', '[Private video]', null),
      entry('ccccccccccc', 'Oldest talk', 4200),
    ]);

    const input = {
      showId: show.id,
      url: PLAYLIST,
      order: 'reverse' as const,
      titleTemplate: 'Tom Talks #{episode}: {title}',
    };
    // dryRun previews the same lists and writes nothing.
    const preview = await call(agent, 'media.importPlaylist', { ...input, dryRun: true });
    expect(preview.dryRun).toBe(true);
    expect(preview.created.map((c) => [c.title, c.sessionId, c.jobId])).toEqual([
      ['Tom Talks #2: Oldest talk', null, null],
      ['Tom Talks #3: Newest talk', null, null],
    ]);
    expect(await call(agent, 'jobs.list', { showId: show.id })).toHaveLength(0);
    expect(await call(agent, 'sessions.list', { showId: show.id })).toHaveLength(1);

    const first = await call(agent, 'media.importPlaylist', input);
    expect(first.dryRun).toBe(false);
    expect(first.playlistTitle).toBe('Tom Talks');
    expect(first.created).toMatchObject([
      {
        videoId: 'ccccccccccc',
        episode: '2',
        title: 'Tom Talks #2: Oldest talk',
        durationSec: 4200,
      },
      { videoId: 'aaaaaaaaaaa', episode: '3', title: 'Tom Talks #3: Newest talk' },
    ]);
    expect(first.skipped).toEqual([
      { videoId: 'bbbbbbbbbbb', title: '[Private video]', reason: 'unavailable', sessionId: null },
    ]);
    const jobs = await call(agent, 'jobs.list', { showId: show.id });
    expect(jobs.map((j) => j.id).sort()).toEqual(first.created.map((c) => c.jobId).sort());
    const [shw] = await db.select().from(schema.shows).where(eq(schema.shows.id, show.id));
    expect(shw!.nextEpisode).toBe(4);
    // Jobs of one batch get distinct, increasing timestamps in import order.
    const rows = await db
      .select()
      .from(schema.jobs)
      .orderBy(schema.jobs.runAfter, schema.jobs.createdAt);
    expect(rows.map((r) => r.id)).toEqual(first.created.map((c) => c.jobId));
    expect(rows[1]!.createdAt.getTime()).toBeGreaterThan(rows[0]!.createdAt.getTime());
    expect(rows[1]!.runAfter.getTime()).toBeGreaterThan(rows[0]!.runAfter.getTime());
    // The video length rides along for the session-level transcript estimate.
    expect(rows[0]!.payload).toMatchObject({ durationSec: 4200 });

    // The import job sets the session date from the YouTube upload date.
    const [jobRow] = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, first.created[0]!.jobId!));
    await handlers.youtube_import.run(jobRow!);
    const s = await call(agent, 'sessions.get', { sessionId: first.created[0]!.sessionId! });
    expect(s).toMatchObject({
      episodeDate: '2024-03-05',
      sourceKind: 'youtube',
      sourceUrl: 'https://www.youtube.com/watch?v=ccccccccccc',
    });

    // A video imported by hand into another session counts as already imported.
    const manual = await call(owner, 'sessions.create', { showId: show.id });
    await db
      .update(schema.sessions)
      .set({ sourceUrl: 'https://youtu.be/ddddddddddd' })
      .where(eq(schema.sessions.id, manual.id));
    await playlist([
      entry('aaaaaaaaaaa', 'Newest talk'),
      entry('eeeeeeeeeee', 'Brand new talk'),
      entry('ddddddddddd', 'Imported by hand'),
      entry('ccccccccccc', 'Oldest talk'),
    ]);
    const again = await call(agent, 'media.importPlaylist', { showId: show.id, url: PLAYLIST });
    expect(again.created).toMatchObject([
      { videoId: 'eeeeeeeeeee', title: 'Brand new talk', episode: '5' },
    ]);
    expect(again.skipped.map((x) => [x.videoId, x.reason, x.sessionId])).toEqual([
      ['aaaaaaaaaaa', 'already_imported', first.created[1]!.sessionId],
      ['ddddddddddd', 'already_imported', manual.id],
      ['ccccccccccc', 'already_imported', first.created[0]!.sessionId],
    ]);
  });

  it('fills the title template in one pass', async () => {
    const { owner, show } = await studio();
    await playlist([entry('aaaaaaaaaaa', 'Cost: $& and {episode} $1')]);
    const out = await call(owner, 'media.importPlaylist', {
      showId: show.id,
      url: PLAYLIST,
      titleTemplate: '{episode}. {title}',
      dryRun: true,
    });
    expect(out.created[0]!.title).toBe('2. Cost: $& and {episode} $1');
  });

  it('keeps a date the user chose when importing a single video', async () => {
    const { owner, session } = await studio();
    await call(owner, 'sessions.update', { sessionId: session.id, episodeDate: '2023-01-01' });
    const job = await call(owner, 'media.importYoutube', {
      sessionId: session.id,
      url: 'https://youtu.be/fffffffffff',
    });
    const [jobRow] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
    await handlers.youtube_import.run(jobRow!);
    const s = await call(owner, 'sessions.get', { sessionId: session.id });
    expect(s.episodeDate).toBe('2023-01-01');
  });

  it('lists the video URL on a single import job, so a failed one can be retried', async () => {
    const { owner, show, session } = await studio();
    const url = 'https://youtu.be/fffffffffff';
    const job = await call(owner, 'media.importYoutube', { sessionId: session.id, url });
    expect(job.sourceUrl).toBe(url);
    await db
      .update(schema.jobs)
      .set({ status: 'failed', error: 'yt-dlp exited with code 1' })
      .where(eq(schema.jobs.id, job.id));
    const [failed] = await call(asAgent(owner), 'jobs.list', {
      showId: show.id,
      status: ['failed'],
    });
    expect(failed).toMatchObject({ id: job.id, sessionId: session.id, sourceUrl: url });
    // The session itself only gets the link once the download succeeds.
    expect((await call(owner, 'sessions.get', { sessionId: session.id })).sourceUrl).toBeNull();
  });

  it('rejects bad URLs and callers without write access', async () => {
    const { owner, show, session } = await studio();
    await playlist([entry('aaaaaaaaaaa', 'Talk')]);
    await failsWith(
      call(owner, 'media.importPlaylist', {
        showId: show.id,
        url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
      }),
      'bad_request',
    );
    await failsWith(
      call(owner, 'media.importYoutube', { sessionId: session.id, url: PLAYLIST }),
      'bad_request',
    );
    const outsider = asAgent(await makeUser('outsider@example.com'));
    await failsWith(
      call(outsider, 'media.importPlaylist', { showId: show.id, url: PLAYLIST }),
      'not_found',
    );
    expect(await call(owner, 'jobs.list', { showId: show.id })).toHaveLength(0);
  });
});
