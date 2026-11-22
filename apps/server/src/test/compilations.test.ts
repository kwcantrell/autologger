import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Storage "configured" for this file only; uploads and deletes are mocked, presigning is local.
vi.hoisted(() => {
  process.env.S3_BUCKET = 'test-bucket';
  process.env.S3_ACCESS_KEY_ID = 'test';
  process.env.S3_SECRET_ACCESS_KEY = 'test';
  process.env.S3_ENDPOINT = 'http://127.0.0.1:9';
});
const stored = vi.hoisted(() => ({ puts: [] as string[], deletes: [] as string[] }));
vi.mock('../media/s3.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../media/s3.ts')>()),
  putObjectFromFile: async (key: string) => {
    stored.puts.push(key);
    return 4321;
  },
  deleteObject: async (key: string) => {
    stored.deletes.push(key);
  },
}));

const { db, schema } = await import('../db/client.ts');
const { env } = await import('../env.ts');
const { newId } = await import('../core/ids.ts');
const { publish } = await import('../core/bus.ts');
const { compilationMessage } = await import('../media/compilations.ts');
const { claimJob, failJob } = await import('../worker/queue.ts');
const { handlers } = await import('../worker/handlers.ts');
const { asAgent, call, failsWith, makeUser, resetDb, setupDb, studio } = await import(
  './harness.ts'
);

const { audioSegments, compilations, jobs, sessions } = schema;
const VIDEO = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

/** Mark a session as imported from YouTube: sourceUrl plus a youtube audio segment. */
async function youtubeSession(sessionId: string, startSec = 0, durationSec = 600) {
  await db
    .update(sessions)
    .set({ sourceKind: 'youtube', sourceUrl: VIDEO })
    .where(eq(sessions.id, sessionId));
  const id = newId('aud');
  await db.insert(audioSegments).values({
    id,
    sessionId,
    ordinal: 1,
    startSec,
    durationSec,
    mimeType: 'audio/mp4',
    origin: 'youtube',
    objectKey: `sessions/${sessionId}/${id}.m4a`,
    status: 'transcribed',
  });
}

describe('compilations ops', () => {
  beforeAll(setupDb);
  beforeEach(resetDb);

  it('creates, lists, gets and deletes a compilation of YouTube sessions', async () => {
    const { owner, show, session } = await studio();
    await youtubeSession(session.id);
    const agent = asAgent(owner);
    const c = await call(agent, 'compilations.create', {
      showId: show.id,
      title: 'Best bits',
      clips: [
        { sessionId: session.id, startSec: 10, endSec: 30, label: 'Intro' },
        { sessionId: session.id, startSec: 100, endSec: 120.5 },
      ],
    });
    expect(c).toMatchObject({
      showId: show.id,
      title: 'Best bits',
      status: 'queued',
      durationSec: 40.5,
      createdBy: { id: owner.user.id },
      clips: [
        {
          sessionId: session.id,
          sessionTitle: session.title,
          startSec: 10,
          endSec: 30,
          label: 'Intro',
        },
        { sessionId: session.id, startSec: 100, endSec: 120.5 },
      ],
    });
    expect(c.url).toBeUndefined();
    const [job] = await db.select().from(jobs);
    expect(job).toMatchObject({
      kind: 'compile',
      sessionId: null,
      payload: { compilationId: c.id },
    });

    expect((await call(owner, 'compilations.list', { showId: show.id })).map((x) => x.id)).toEqual([
      c.id,
    ]);
    await db
      .update(compilations)
      .set({
        status: 'ready',
        objectKey: `shows/${show.id}/compilations/${c.id}.mp4`,
        sizeBytes: 99,
      })
      .where(eq(compilations.id, c.id));
    const ready = await call(owner, 'compilations.get', { compilationId: c.id });
    expect(ready).toMatchObject({ status: 'ready', sizeBytes: 99 });
    expect(ready.url).toContain(`compilations/${c.id}.mp4`);
    expect(ready.url).toContain('X-Amz-Signature=');

    expect(await call(agent, 'compilations.delete', { compilationId: c.id })).toEqual({ ok: true });
    expect(stored.deletes).toContain(`shows/${show.id}/compilations/${c.id}.mp4`);
    await failsWith(call(owner, 'compilations.get', { compilationId: c.id }), 'not_found');
  });

  it('rejects sessions that are not from YouTube, ranges outside the video and bad clips', async () => {
    const { owner, show, session } = await studio();
    await youtubeSession(session.id, 0, 300);
    const recorded = await call(owner, 'sessions.create', { showId: show.id });
    const other = await studio();
    await youtubeSession(other.session.id);
    const create = (clips: { sessionId: string; startSec: number; endSec: number }[]) =>
      call(owner, 'compilations.create', { showId: show.id, title: 'X', clips });

    await failsWith(create([{ sessionId: recorded.id, startSec: 0, endSec: 10 }]), 'bad_request');
    await expect(
      create([
        { sessionId: session.id, startSec: 0, endSec: 10 },
        { sessionId: recorded.id, startSec: 0, endSec: 10 },
        { sessionId: session.id, startSec: 290, endSec: 320 },
        { sessionId: other.session.id, startSec: 0, endSec: 10 },
      ]),
    ).rejects.toThrow(
      /clip 2 .*not imported from YouTube.*clip 3 .*outside the YouTube video.*clip 4 .*not found in this show/,
    );
    await failsWith(create([{ sessionId: session.id, startSec: 5, endSec: 5.5 }]), 'bad_request');
    await failsWith(create([{ sessionId: session.id, startSec: 0, endSec: 1300 }]), 'bad_request');
    await failsWith(create([]), 'bad_request');
    expect(await db.select().from(compilations)).toEqual([]);
    expect(await db.select().from(jobs)).toEqual([]);
  });

  it('needs show read access to see and write access to create or delete', async () => {
    const { owner, team, show, session } = await studio();
    await youtubeSession(session.id);
    const c = await call(owner, 'compilations.create', {
      showId: show.id,
      title: 'Mine',
      clips: [{ sessionId: session.id, startSec: 0, endSec: 10 }],
    });
    const stranger = await makeUser('stranger@example.com');
    await failsWith(call(stranger, 'compilations.get', { compilationId: c.id }), 'not_found');
    await failsWith(call(stranger, 'compilations.list', { showId: show.id }), 'not_found');
    await failsWith(call(stranger, 'compilations.delete', { compilationId: c.id }), 'not_found');

    const reader = await makeUser('reader@example.com');
    await call(owner, 'teams.invite', { teamId: team.id, email: reader.user.email });
    await call(owner, 'teams.setGrant', {
      teamId: team.id,
      userId: reader.user.id,
      showId: show.id,
      access: 'read',
    });
    expect(await call(reader, 'compilations.get', { compilationId: c.id })).toMatchObject({
      id: c.id,
    });
    await failsWith(
      call(reader, 'compilations.create', {
        showId: show.id,
        title: 'Theirs',
        clips: [{ sessionId: session.id, startSec: 0, endSec: 10 }],
      }),
      'forbidden',
    );
    await failsWith(call(reader, 'compilations.delete', { compilationId: c.id }), 'forbidden');
  });

  it('compilations.get with waitSec returns when the status changes', async () => {
    const { owner, show, session } = await studio();
    await youtubeSession(session.id);
    const c = await call(owner, 'compilations.create', {
      showId: show.id,
      title: 'Wait',
      clips: [{ sessionId: session.id, startSec: 0, endSec: 10 }],
    });
    const started = Date.now();
    setTimeout(async () => {
      // A progress update with the same status does not end the wait…
      publish(`show:${show.id}`, compilationMessage(show.id, c.id, 'queued'));
      await db.update(compilations).set({ status: 'running' }).where(eq(compilations.id, c.id));
      // …a status change does.
      publish(`show:${show.id}`, compilationMessage(show.id, c.id, 'running'));
    }, 200);
    const got = await call(owner, 'compilations.get', { compilationId: c.id, waitSec: 10 });
    expect(got.status).toBe('running');
    expect(Date.now() - started).toBeLessThan(5000);

    // Finished compilations answer at once.
    await db.update(compilations).set({ status: 'failed' }).where(eq(compilations.id, c.id));
    const t = Date.now();
    await call(owner, 'compilations.get', { compilationId: c.id, waitSec: 10 });
    expect(Date.now() - t).toBeLessThan(2000);
    // Longer waits would outlast MCP clients' ~60 s request timeout.
    await failsWith(
      call(owner, 'compilations.get', { compilationId: c.id, waitSec: 60 }),
      'bad_request',
    );
  });
});

describe('compile jobs in jobs.list and compilation estimates', () => {
  beforeAll(setupDb);
  beforeEach(resetDb);

  it('lists show-level compile jobs by showId, wakes waits on them and dismisses them', async () => {
    const { owner, team, show, session } = await studio();
    await youtubeSession(session.id);
    const c = await call(owner, 'compilations.create', {
      showId: show.id,
      title: 'Best bits',
      clips: [{ sessionId: session.id, startSec: 0, endSec: 10 }],
    });
    const agent = asAgent(owner);
    const listed = await call(agent, 'jobs.list', { showId: show.id, kinds: ['compile'] });
    expect(listed).toHaveLength(1);
    const job = listed[0]!;
    expect(job).toMatchObject({
      kind: 'compile',
      status: 'queued',
      sessionId: null,
      compilationId: c.id,
      compilationTitle: 'Best bits',
      queuePosition: 0,
    });
    expect(await call(agent, 'jobs.list', { sessionId: session.id })).toEqual([]);

    const stranger = await makeUser('stranger@example.com');
    await failsWith(call(stranger, 'jobs.list', { showId: show.id }), 'not_found');
    await failsWith(call(stranger, 'jobs.dismiss', { jobId: job.id }), 'not_found');
    const reader = await makeUser('reader@example.com');
    await call(owner, 'teams.invite', { teamId: team.id, email: reader.user.email });
    await call(owner, 'teams.setGrant', {
      teamId: team.id,
      userId: reader.user.id,
      showId: show.id,
      access: 'read',
    });
    expect((await call(reader, 'jobs.list', { showId: show.id })).map((j) => j.id)).toEqual([
      job.id,
    ]);

    // The worker claiming it (published on the show topic) ends a wait.
    const started = Date.now();
    setTimeout(() => void claimJob(), 200);
    const waited = await call(agent, 'jobs.list', {
      showId: show.id,
      status: ['queued', 'running'],
      waitSec: 10,
    });
    expect(waited[0]).toMatchObject({ id: job.id, status: 'running' });
    expect(Date.now() - started).toBeLessThan(5000);

    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    await failJob(row!, 'boom', true);
    await failsWith(call(reader, 'jobs.dismiss', { jobId: job.id }), 'forbidden');
    expect((await call(agent, 'jobs.dismiss', { jobId: job.id })).dismissedAt).not.toBeNull();

    // Deleted: still listed (unlabelled); its open failures are dismissed.
    const again = await call(owner, 'compilations.create', {
      showId: show.id,
      title: 'Gone',
      clips: [{ sessionId: session.id, startSec: 0, endSec: 10 }],
    });
    await call(owner, 'compilations.delete', { compilationId: again.id });
    const gone = (await call(agent, 'jobs.list', { showId: show.id })).find(
      (j) => j.compilationId === again.id,
    );
    expect(gone).toMatchObject({ status: 'failed', error: 'Compilation deleted.' });
    expect(gone!.compilationTitle).toBeUndefined();
    expect(gone!.dismissedAt).not.toBeNull();
  });

  it('gives unfinished compilations queuePosition and etaSec scaled by clip seconds', async () => {
    const { owner, show, session } = await studio();
    await youtubeSession(session.id);
    // History: a 100 s compilation built in 50 s (0.5 s per clip second).
    const old = await call(owner, 'compilations.create', {
      showId: show.id,
      title: 'Old',
      clips: [{ sessionId: session.id, startSec: 0, endSec: 100 }],
    });
    await db.update(compilations).set({ status: 'ready' }).where(eq(compilations.id, old.id));
    await db
      .update(jobs)
      .set({
        status: 'done',
        startedAt: new Date(Date.now() - 50_000),
        updatedAt: new Date(),
      })
      .where(eq(jobs.kind, 'compile'));

    const c = await call(owner, 'compilations.create', {
      showId: show.id,
      title: 'New',
      clips: [{ sessionId: session.id, startSec: 0, endSec: 20 }],
    });
    expect(c).toMatchObject({ queuePosition: 0, etaSec: 10 });
    expect(await call(owner, 'compilations.get', { compilationId: c.id })).toMatchObject({
      queuePosition: 0,
      etaSec: 10,
    });
    const [listed] = await call(owner, 'jobs.list', { showId: show.id, status: ['queued'] });
    expect(listed).toMatchObject({ compilationId: c.id, etaSec: 10 });
    const ready = (await call(owner, 'compilations.list', { showId: show.id })).find(
      (x) => x.id === old.id,
    );
    expect(ready!.queuePosition).toBeUndefined();
    expect(ready!.etaSec).toBeUndefined();
  });

  it('backfills show_id of compile jobs queued before the column existed', async () => {
    const { owner, show, session } = await studio();
    await youtubeSession(session.id);
    const c = await call(owner, 'compilations.create', {
      showId: show.id,
      title: 'Before',
      clips: [{ sessionId: session.id, startSec: 0, endSec: 10 }],
    });
    await db.update(jobs).set({ showId: null });
    const migration = new URL('../../drizzle/0015_backfill_compile_job_show.sql', import.meta.url);
    await db.execute(sql.raw(readFileSync(migration, 'utf8')));
    const [job] = await call(owner, 'jobs.list', { showId: show.id });
    expect(job).toMatchObject({ compilationId: c.id });
  });
});

describe('compile job', () => {
  beforeAll(setupDb);
  beforeEach(resetDb);
  const saved = { ytDlpPath: env.ytDlpPath, ffmpegPath: env.ffmpegPath };
  afterAll(() => Object.assign(env, saved));

  /** Stub yt-dlp, ffmpeg and ffprobe: each logs its arguments and writes its output file. */
  async function stubTools() {
    const dir = await mkdtemp(join(tmpdir(), 'autologger-compile-stubs-'));
    const log = join(dir, 'calls.log');
    const script = (body: string) => `#!/bin/sh\necho "$(basename "$0") $*" >> '${log}'\n${body}\n`;
    // yt-dlp: write the file named by -o with %(ext)s = mp4.
    await writeFile(
      join(dir, 'yt-dlp'),
      script(
        `while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; fi; shift; done\n` +
          `printf video > "$(echo "$out" | sed 's/%(ext)s/mp4/')"`,
      ),
    );
    // ffmpeg: the output is the last argument.
    await writeFile(
      join(dir, 'ffmpeg'),
      script(`for a in "$@"; do last="$a"; done\n[ "$1" = "-version" ] || printf mp4 > "$last"`),
    );
    await writeFile(
      join(dir, 'ffprobe'),
      script(`case "$*" in *format=duration*) echo 40.48 ;; *) echo 1 ;; esac`),
    );
    for (const f of ['yt-dlp', 'ffmpeg', 'ffprobe']) await chmod(join(dir, f), 0o755);
    env.ytDlpPath = join(dir, 'yt-dlp');
    env.ffmpegPath = join(dir, 'ffmpeg');
    return { calls: async () => (await readFile(log, 'utf8')).trim().split('\n') };
  }

  it('downloads each range at video time, joins them and stores the MP4', async () => {
    const tools = await stubTools();
    const { owner, show, session } = await studio();
    // The video starts 5 s into the session: session second 15 is video second 10.
    await youtubeSession(session.id, 5);
    const c = await call(owner, 'compilations.create', {
      showId: show.id,
      title: 'Two clips',
      clips: [
        { sessionId: session.id, startSec: 15, endSec: 35 },
        { sessionId: session.id, startSec: 105, endSec: 125.5 },
      ],
    });
    const job = await claimJob();
    expect(job?.kind).toBe('compile');
    const note = await handlers.compile.run(job!);
    expect(note).toMatch(/^Compiled 2 clips/);

    const calls = await tools.calls();
    const downloads = calls.filter((l) => l.startsWith('yt-dlp'));
    expect(downloads).toHaveLength(2);
    expect(downloads[0]).toContain('--download-sections *10.000-30.000');
    expect(downloads[1]).toContain('--download-sections *100.000-120.500');
    expect(downloads[0]).toContain(VIDEO);
    // The temp dir is gone afterwards.
    const tmp = downloads[0]!.match(/-o (\S+)\/raw-0/)![1]!;
    expect(existsSync(tmp)).toBe(false);
    const encodes = calls.filter((l) => l.startsWith('ffmpeg') && l.includes('libx264'));
    expect(encodes).toHaveLength(2);
    expect(encodes[0]).toContain('-t 20.000');
    expect(calls.some((l) => l.startsWith('ffmpeg') && l.includes('-f concat'))).toBe(true);

    const key = `shows/${show.id}/compilations/${c.id}.mp4`;
    expect(stored.puts).toContain(key);
    const got = await call(owner, 'compilations.get', { compilationId: c.id });
    expect(got).toMatchObject({ status: 'ready', durationSec: 40.48, sizeBytes: 4321 });
    expect(got.progress).toBeUndefined();
    expect(got.url).toContain(`compilations/${c.id}.mp4`);
  });

  it('marks the compilation failed when the job fails for good', async () => {
    await stubTools();
    const { owner, show, session } = await studio();
    await youtubeSession(session.id);
    const c = await call(owner, 'compilations.create', {
      showId: show.id,
      title: 'Doomed',
      clips: [{ sessionId: session.id, startSec: 0, endSec: 10 }],
    });
    env.ytDlpPath = '/nonexistent/yt-dlp';
    const job = await claimJob();
    await expect(handlers.compile.run(job!)).rejects.toThrow(/yt-dlp not found/);
    await handlers.compile.onFinalFailure!(job!, 'yt-dlp not found');
    expect(await call(owner, 'compilations.get', { compilationId: c.id })).toMatchObject({
      status: 'failed',
      error: 'yt-dlp not found',
    });
    const [row] = await db.select().from(compilations).where(eq(compilations.id, c.id));
    expect(row!.objectKey).toBeNull();
  });
});
