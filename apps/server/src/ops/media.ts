// Media: audio segments (recorded / uploaded / YouTube), playback URLs, transcription jobs.
//
// Upload flow: media.createUpload (row status 'uploading' + presigned PUT) → browser PUTs the
// bytes straight to S3 → media.completeUpload (verifies the object, status 'ready', enqueues
// `transcribe`). The worker (src/worker) does the Deepgram and yt-dlp work.

import type { AudioSegment, Job, PlaylistImport } from '@autologger/contract';
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { requireSession, requireShow } from '../core/authz.ts';
import { type BusMessage, changeMessage, subscribeAll, type Topic } from '../core/bus.ts';
import { badRequest, conflict, notFound, unavailable } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import { type Ctx, defineOp, type OpWatch } from '../core/op.ts';
import type { Tx } from '../db/client.ts';
import { db, schema } from '../db/client.ts';
import { env, storageConfigured, transcriptionConfigured } from '../env.ts';
import { enqueueJob, type JobRow, toJob } from '../media/jobs.ts';
import {
  deleteObject,
  extForMime,
  headObject,
  objectKeyFor,
  PLAYBACK_URL_TTL_SEC,
  presignPlayback,
  presignUpload,
  requireStorage,
} from '../media/s3.ts';
import { activeTranscribeJob, lockSession, nextSegmentSlot } from '../media/segments.ts';
import {
  isYoutubeUrl,
  listPlaylist,
  type Playlist,
  watchUrl,
  youtubePlaylistId,
  youtubeVideoId,
} from '../media/youtube.ts';
import { toAudioSegment } from './map.ts';
import { publishSession, reserveEpisodes } from './sessions.ts';

const { audioSegments, jobs, sessions } = schema;

const MAX_PLAYLIST_VIDEOS = 200;
const PLAYLIST_TIMEOUT_MS = 60_000;
type SegmentRow = typeof audioSegments.$inferSelect;

function requireYoutube(): void {
  if (!env.youtubeEnabled)
    throw unavailable(
      'YouTube import is disabled on this server. Set YOUTUBE_IMPORT=1 to enable it.',
    );
  requireStorage();
}

function requireTranscription(): void {
  if (!transcriptionConfigured) {
    throw unavailable(
      storageConfigured
        ? 'Transcription is not configured. Set DEEPGRAM_API_KEY.'
        : 'Transcription needs media storage and Deepgram. Set S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY and DEEPGRAM_API_KEY.',
    );
  }
}

async function loadSegment(ctx: Ctx, segmentId: string, need: 'read' | 'write') {
  const [row] = await ctx.db.select().from(audioSegments).where(eq(audioSegments.id, segmentId));
  if (!row) throw notFound('Audio segment');
  try {
    const { session } = await requireSession(ctx, row.sessionId, need);
    return { row, session };
  } catch (e) {
    if ((e as { code?: string }).code === 'not_found') throw notFound('Audio segment');
    throw e;
  }
}

function publishSegment(ctx: Ctx, seg: AudioSegment): void {
  ctx.publish(`session:${seg.sessionId}`, changeMessage('audio_segment', 'upsert', seg.id, seg));
}

function publishJob(ctx: Ctx, job: JobRow): void {
  if (job.sessionId)
    ctx.publish(`session:${job.sessionId}`, changeMessage('job', 'upsert', job.id, toJob(job)));
}

async function enqueueTranscribe(ctx: Ctx, seg: SegmentRow, keyTerms?: string[]): Promise<JobRow> {
  const existing = await activeTranscribeJob(ctx.db, seg.id);
  // The active job runs with its own key terms; don't pretend this one-off list was applied.
  if (existing && keyTerms)
    throw conflict(
      'a transcription is already queued or running for this audio; retry when it finishes',
    );
  if (existing) return existing;
  const job = await enqueueJob(ctx.db, {
    kind: 'transcribe',
    sessionId: seg.sessionId,
    actorId: ctx.actor.user.id,
    payload: { segmentId: seg.id, keyTerms: keyTerms && [...new Set(keyTerms)] },
  });
  publishJob(ctx, job);
  return job;
}

defineOp({
  name: 'media.list',
  description:
    'Audio segments of a session in order, with their session start time, duration and transcription status (uploading, ready, transcribing, transcribed, failed).',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  async run(ctx, { sessionId }) {
    await requireSession(ctx, sessionId, 'read');
    const rows = await ctx.db
      .select()
      .from(audioSegments)
      .where(eq(audioSegments.sessionId, sessionId))
      .orderBy(asc(audioSegments.ordinal));
    return rows.map(toAudioSegment);
  },
});

defineOp({
  name: 'media.createUpload',
  description:
    'Start uploading one audio segment (a recording chunk or a local file). Returns a presigned PUT URL valid for 15 minutes; PUT the bytes with the given headers, then call media.completeUpload.',
  kind: 'write',
  surfaces: ['web'],
  async run(ctx, { sessionId, mimeType, origin, fileName, startSec, sizeBytes }) {
    requireStorage();
    const base = mimeType.split(';')[0]!.trim().toLowerCase();
    if (!base.startsWith('audio/') && !base.startsWith('video/')) {
      throw badRequest('Only audio or video files can be uploaded.');
    }
    await requireSession(ctx, sessionId, 'write');
    await lockSession(ctx.db, sessionId);
    const slot = await nextSegmentSlot(ctx.db, sessionId);
    const id = newId('aud');
    const objectKey = objectKeyFor(sessionId, id, extForMime(mimeType, fileName));
    const [row] = await ctx.db
      .insert(audioSegments)
      .values({
        id,
        sessionId,
        ordinal: slot.ordinal,
        startSec: startSec ?? slot.endSec,
        mimeType,
        origin,
        fileName: fileName ?? null,
        objectKey,
        sizeBytes: sizeBytes ?? null,
        status: 'uploading',
        createdBy: ctx.actor.user.id,
      })
      .returning();
    const uploadUrl = await presignUpload(objectKey, mimeType);
    const segment = toAudioSegment(row!);
    publishSegment(ctx, segment);
    return { segment, uploadUrl, headers: { 'Content-Type': mimeType } };
  },
});

defineOp({
  name: 'media.completeUpload',
  description:
    'Finish an upload started with media.createUpload once the PUT succeeded. Marks the segment ready and queues transcription when Deepgram is configured.',
  kind: 'write',
  surfaces: ['web'],
  async run(ctx, { segmentId, durationSec }) {
    requireStorage();
    const { row, session } = await loadSegment(ctx, segmentId, 'write');
    if (row.status !== 'uploading') {
      if (durationSec !== undefined && row.durationSec === null) {
        const [u] = await ctx.db
          .update(audioSegments)
          .set({ durationSec })
          .where(eq(audioSegments.id, segmentId))
          .returning();
        return toAudioSegment(u!);
      }
      return toAudioSegment(row);
    }
    const head = await headObject(row.objectKey);
    if (!head || head.size === 0)
      throw conflict('The upload has not arrived in storage yet. PUT the file first.');
    const [after] = await ctx.db
      .update(audioSegments)
      .set({
        status: 'ready',
        sizeBytes: head.size,
        error: null,
        ...(durationSec !== undefined ? { durationSec } : {}),
      })
      .where(eq(audioSegments.id, segmentId))
      .returning();
    if (!session.sourceKind) {
      await ctx.db
        .update(sessions)
        .set({ sourceKind: row.origin, updatedAt: new Date() })
        .where(eq(sessions.id, session.id));
    }
    if (transcriptionConfigured) await enqueueTranscribe(ctx, after!);
    const out = toAudioSegment(after!);
    publishSegment(ctx, out);
    await publishSession(ctx, session.id);
    return out;
  },
});

defineOp({
  name: 'media.playbackUrl',
  description: 'A short-lived URL to play or download one audio segment.',
  kind: 'read',
  surfaces: ['web'],
  async run(ctx, { segmentId }) {
    requireStorage();
    const { row } = await loadSegment(ctx, segmentId, 'read');
    if (row.status === 'uploading') throw conflict('This segment is still uploading.');
    const url = await presignPlayback(row.objectKey);
    return { url, expiresAt: new Date(Date.now() + PLAYBACK_URL_TTL_SEC * 1000).toISOString() };
  },
});

defineOp({
  name: 'media.importYoutube',
  description:
    "Import the audio of one YouTube video into an existing session. Runs in the background: the worker downloads the audio, stores it and transcribes it. If the session's episodeDate is still its default (the day it was created), it is set to the video's upload date. Playlist URLs are rejected: use media.importPlaylist to import a whole playlist into a show. Returns the job; wait for it with jobs.list (waitSec).",
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { sessionId, url }) {
    requireYoutube();
    if (!isYoutubeUrl(url))
      throw badRequest('That is not a YouTube URL (youtube.com or youtu.be).');
    if (youtubePlaylistId(url) && !youtubeVideoId(url))
      throw badRequest(
        'That is a playlist URL. Use media.importPlaylist with the showId to create one session per video.',
      );
    await requireSession(ctx, sessionId, 'write');
    const job = await enqueueJob(ctx.db, {
      kind: 'youtube_import',
      sessionId,
      actorId: ctx.actor.user.id,
      payload: { url },
    });
    publishJob(ctx, job);
    return toJob(job);
  },
});

/** Concurrent yt-dlp playlist resolutions allowed per server process. */
const MAX_PLAYLIST_RESOLUTIONS = 2;
let playlistResolutions = 0;

/** One-pass template fill, so `{…}` or `$&` inside a video title is never re-expanded. */
export function fillTitle(template: string, vars: { title: string; episode: string }): string {
  return template
    .replace(/\{(title|episode)\}/g, (_, k: 'title' | 'episode') => vars[k])
    .slice(0, 200);
}

defineOp({
  name: 'media.importPlaylist',
  description:
    'Import a whole YouTube playlist into a show in one call: one new session per video, each with a queued youtube_import job (download + transcription run in the background; poll jobs.list with showId and status ["queued","running"] until empty). showId comes from shows.list (needs write access). url is a YouTube URL with a list= parameter. Videos already in the show (a session whose sourceUrl is the same video, or one with a queued/running import of it) and private/deleted videos are skipped, so calling it again later imports only new videos. Session titles come from titleTemplate (placeholders {title} = video title, {episode} = episode number; default "{title}"); episode numbers are taken from the show counter in import order. order "playlist" (default) keeps the playlist order; "reverse" imports the last video first (use it when the playlist lists newest first, so episode 1 is the oldest). episodeDate is set to each video\'s YouTube upload date when its import job runs. Up to 200 videos per playlist. Agents cannot delete sessions (deleting is web-only), so for an unfamiliar playlist call it first with dryRun: true: it returns the same created/skipped lists (dryRun true, sessionId and jobId null) without writing anything. A session whose import job fails stays in the show (and is skipped on re-runs): retry it with media.importYoutube on that sessionId. Returns {playlistTitle, dryRun, created [{sessionId, title, episode, videoId, durationSec, jobId}], skipped [{videoId, title, reason, sessionId}]}; durationSec is in seconds (null if YouTube did not say). Fails with unavailable when the server is busy reading other playlists: retry shortly.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  // Authorize, then run yt-dlp, before the op's transaction opens.
  async prepare(actor, { showId, url }): Promise<Playlist> {
    await db.transaction((tx) =>
      requireShow(
        {
          actor,
          db: tx,
          op: 'media.importPlaylist',
          groupId: '',
          record: () => Promise.reject(new Error('read-only')),
          publish: () => {},
        },
        showId,
        'write',
      ),
    );
    requireYoutube();
    const listId = youtubePlaylistId(url);
    if (!listId)
      throw badRequest(
        'That is not a YouTube playlist URL (it needs a list= parameter). Use media.importYoutube for a single video.',
      );
    if (playlistResolutions >= MAX_PLAYLIST_RESOLUTIONS)
      throw unavailable('The server is busy reading other playlists. Retry in a few seconds.');
    playlistResolutions++;
    let playlist: Playlist;
    try {
      playlist = await listPlaylist(
        env.ytDlpPath,
        `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`,
        { maxEntries: MAX_PLAYLIST_VIDEOS + 1, timeoutMs: PLAYLIST_TIMEOUT_MS },
      );
    } catch (e) {
      console.warn(`playlist ${listId}: ${(e as Error).message}`);
      throw unavailable(
        'Could not read the playlist. Check that it exists and is public or unlisted, then retry.',
      );
    } finally {
      playlistResolutions--;
    }
    if (playlist.entries.length > MAX_PLAYLIST_VIDEOS)
      throw badRequest(`The playlist has more than ${MAX_PLAYLIST_VIDEOS} videos.`);
    if (playlist.entries.length === 0) throw badRequest('The playlist is empty or not public.');
    return playlist;
  },
  async run(ctx, { showId, order, titleTemplate, dryRun }, playlist): Promise<PlaylistImport> {
    const { show } = await requireShow(ctx, showId, 'write');
    // Serialize imports into one show, so concurrent calls cannot both import a video.
    await ctx.db.execute(sql`select pg_advisory_xact_lock(hashtext(${show.id}))`);

    // Videos the show already has: finished imports (sourceUrl) and imports still in the queue.
    const known = new Map<string, string>();
    const imported = await ctx.db
      .select({ id: sessions.id, sourceUrl: sessions.sourceUrl })
      .from(sessions)
      .where(and(eq(sessions.showId, show.id), isNotNull(sessions.sourceUrl)));
    const pending = await ctx.db
      .select({ id: sessions.id, url: sql<string | null>`${jobs.payload}->>'url'` })
      .from(jobs)
      .innerJoin(sessions, eq(sessions.id, jobs.sessionId))
      .where(
        and(
          eq(sessions.showId, show.id),
          eq(jobs.kind, 'youtube_import'),
          inArray(jobs.status, ['queued', 'running']),
        ),
      );
    for (const r of [...imported.map((r) => ({ id: r.id, url: r.sourceUrl })), ...pending]) {
      const vid = youtubeVideoId(r.url);
      if (vid && !known.has(vid)) known.set(vid, r.id);
    }

    const entries = order === 'reverse' ? [...playlist.entries].reverse() : playlist.entries;
    const skipped: PlaylistImport['skipped'] = [];
    const todo: typeof entries = [];
    const seen = new Set<string>(); // a video listed twice is imported once
    for (const e of entries) {
      if (seen.has(e.videoId)) continue;
      seen.add(e.videoId);
      const existing = known.get(e.videoId);
      if (existing)
        skipped.push({
          videoId: e.videoId,
          title: e.title,
          reason: 'already_imported',
          sessionId: existing,
        });
      else if (!e.available)
        skipped.push({
          videoId: e.videoId,
          title: e.title,
          reason: 'unavailable',
          sessionId: null,
        });
      else todo.push(e);
    }

    const created: PlaylistImport['created'] = [];
    if (todo.length) {
      const first = dryRun ? show.nextEpisode : await reserveEpisodes(ctx, show.id, todo.length);
      const today = new Date().toISOString().slice(0, 10);
      // Rows of one transaction share now(): stagger created_at/run_after to keep playlist order.
      const base = Date.now();
      for (const [i, e] of todo.entries()) {
        const episode = String(first + i);
        const item: PlaylistImport['created'][number] = {
          sessionId: null,
          title: fillTitle(titleTemplate ?? '{title}', { title: e.title, episode }),
          episode,
          videoId: e.videoId,
          durationSec: e.durationSec,
          jobId: null,
        };
        created.push(item);
        if (dryRun) continue;
        const sessionId = newId('ses');
        const videoUrl = watchUrl(e.videoId);
        await ctx.db.insert(sessions).values({
          id: sessionId,
          showId: show.id,
          title: item.title,
          episode,
          // Replaced by the upload date when the import job runs.
          episodeDate: today,
          frameRate: show.defaultFrameRate,
          sourceKind: 'youtube',
          sourceUrl: videoUrl,
          createdBy: ctx.actor.user.id,
        });
        const job = await enqueueJob(
          ctx.db,
          {
            kind: 'youtube_import',
            sessionId,
            actorId: ctx.actor.user.id,
            payload: { url: videoUrl },
          },
          { at: new Date(base + i) },
        );
        item.sessionId = sessionId;
        item.jobId = job.id;
      }
      if (!dryRun)
        ctx.publish(`show:${show.id}`, { type: 'show_changed', showId: show.id, entity: 'show' });
    }
    return { playlistTitle: playlist.title, dryRun, created, skipped };
  },
});

defineOp({
  name: 'media.retranscribe',
  description:
    "Transcribe one audio segment again, or every segment of the session when segmentId is omitted. Replaces the machine transcript of those segments (manual edits to them are lost). Uses the show's current transcription settings and the session's key terms; pass `keyTerms` to use that list instead of the session's for this run only (the show's terms are still added after them; same limits as sessions_update). A segment that already has a queued or running transcription keeps that job; with `keyTerms` that is a conflict error instead (retry when the job finishes). Returns the jobs; when a job is done, its `progress` (jobs_list) reports how often each key term occurs in the new transcript, listing terms that never occur first and at most 15 terms, e.g. \"key terms: Olu Dara ×0, Tom Segura ×41, +3 more\".",
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { sessionId, segmentId, keyTerms }) {
    requireTranscription();
    await requireSession(ctx, sessionId, 'write');
    const where = segmentId
      ? and(eq(audioSegments.sessionId, sessionId), eq(audioSegments.id, segmentId))
      : eq(audioSegments.sessionId, sessionId);
    const rows = await ctx.db
      .select()
      .from(audioSegments)
      .where(where)
      .orderBy(asc(audioSegments.ordinal));
    if (segmentId && rows.length === 0) throw notFound('Audio segment');
    const eligible = rows.filter((r) => r.status !== 'uploading');
    if (segmentId && eligible.length === 0) throw conflict('This segment is still uploading.');
    const out: JobRow[] = [];
    for (const seg of eligible) out.push(await enqueueTranscribe(ctx, seg, keyTerms));
    return out.map(toJob);
  },
});

defineOp({
  name: 'media.delete',
  description: 'Delete one audio segment, its stored audio and its transcript.',
  kind: 'write',
  surfaces: ['web'],
  async run(ctx, { segmentId }) {
    const { row, session } = await loadSegment(ctx, segmentId, 'write');
    // Transcript rows cascade with the segment.
    await ctx.db.delete(audioSegments).where(eq(audioSegments.id, segmentId));
    await ctx.db
      .update(jobs)
      .set({ status: 'failed', error: 'Audio segment deleted.', updatedAt: new Date() })
      .where(
        and(
          eq(jobs.kind, 'transcribe'),
          eq(jobs.status, 'queued'),
          eq(jobs.sessionId, session.id),
          sql`${jobs.payload}->>'segmentId' = ${segmentId}`,
        ),
      );
    if (storageConfigured) {
      try {
        await deleteObject(row.objectKey);
      } catch (e) {
        console.warn(`could not delete object ${row.objectKey}: ${(e as Error).message}`);
      }
    }
    ctx.publish(`session:${session.id}`, changeMessage('audio_segment', 'delete', segmentId));
    ctx.publish(`session:${session.id}`, { type: 'invalidate', entity: 'transcript_segment' });
    ctx.publish(`session:${session.id}`, { type: 'invalidate', entity: 'job' });
    await publishSession(ctx, session.id);
    return { deleted: true as const };
  },
});

/**
 * Fill `queuePosition` on runnable queued jobs: how many runnable queued jobs (any show) the
 * worker claims first, 0 = next. Mirrors claimJob's order (run_after, transcriptions first,
 * created_at, id); `kind <> 'transcribe'` is false for transcriptions, so they sort first. Jobs
 * waiting out a retry backoff (run_after in the future) get no position.
 */
async function withQueuePositions<T extends Job>(tx: Tx, list: T[]): Promise<T[]> {
  const ids = list.filter((j) => j.status === 'queued').map((j) => j.id);
  if (!ids.length) return list;
  const rows = await tx
    .select({
      id: jobs.id,
      ahead: sql<number>`(select count(*)::int from jobs a
        where a.status = 'queued' and a.run_after <= now()
          and (a.run_after, a.kind <> 'transcribe', a.created_at, a.id)
            < (jobs.run_after, jobs.kind <> 'transcribe', jobs.created_at, jobs.id))`,
    })
    .from(jobs)
    .where(and(inArray(jobs.id, ids), sql`${jobs.runAfter} <= now()`));
  const ahead = new Map(rows.map((r) => [r.id, r.ahead]));
  return list.map((j) => (ahead.has(j.id) ? { ...j, queuePosition: ahead.get(j.id)! } : j));
}

/**
 * Long-poll for jobs.list. Starts listening on the realtime bus before the op's transaction (so
 * a change committed meanwhile isn't missed); `wait` then resolves when a listed unfinished job
 * changes status or is deleted, or a job is queued in one of their sessions — or on timeout or
 * abort. Worker updates reach the bus through Postgres NOTIFY on the shared LISTEN connection, so
 * waiting holds no database connection.
 */
function watchJobs(ms: number, signal?: AbortSignal): OpWatch<Job[]> {
  const seen: [Topic, BusMessage][] = [];
  let onMessage = (topic: Topic, m: BusMessage) => void seen.push([topic, m]);
  const unsubscribe = subscribeAll((topic, m) => onMessage(topic, m));
  let finish = () => {};
  const onAbort = () => finish();
  let timer: NodeJS.Timeout | undefined;
  const cancel = () => {
    unsubscribe();
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    finish();
  };
  return {
    cancel,
    wait(list) {
      const pending = new Map(
        list.filter((j) => j.status === 'queued' || j.status === 'running').map((j) => [j.id, j]),
      );
      const topics = new Set(
        [...pending.values()].flatMap((j) => (j.sessionId ? [`session:${j.sessionId}`] : [])),
      );
      if (!topics.size || signal?.aborted) return null;
      const relevant = (topic: Topic, m: BusMessage) => {
        if (!topics.has(topic)) return false;
        if (m.type === 'invalidate') return m.entity === 'job';
        if (m.type !== 'change' || m.entity !== 'job') return false;
        const status = (m.data as Job | undefined)?.status;
        // A progress update of a listed job doesn't count.
        return !(m.op === 'upsert' && status && pending.get(m.id)?.status === status);
      };
      return new Promise<void>((resolve) => {
        finish = () => {
          finish = () => {};
          resolve();
          cancel();
        };
        if (seen.some(([t, m]) => relevant(t, m))) return finish();
        onMessage = (t, m) => {
          if (relevant(t, m)) finish();
        };
        timer = setTimeout(() => finish(), ms);
        timer.unref();
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}

defineOp({
  name: 'jobs.list',
  description:
    'Background jobs (transcription, YouTube import), newest first, with status, progress and errors. Pass exactly one of sessionId (one session) or showId (every session of the show — each job then includes sessionId and sessionTitle, so one call answers "is the playlist import finished?"). Optional status filters to the given states (e.g. ["queued","running"] for unfinished work; an empty result means nothing is pending); limit defaults to 100 (max 500). Queued jobs include queuePosition: how many jobs the worker will start before this one, 0 = next. It counts every runnable queued job on the server (all teams and shows; only the number is exposed); a job waiting to retry after a failure has no queuePosition until its retry time. The worker runs a couple of jobs at a time and each usually takes under a minute or two. To wait for jobs, pass waitSec (1–55): if any listed job is queued or running, the call holds until one of them changes status (starts, finishes, fails) or a new job is queued in one of their sessions, then returns the fresh list — or returns after waitSec seconds when nothing changed. Call it again in a loop until the result is empty / all done; no separate sleep is needed. Without waitSec the call returns at once; do not poll it in a tight loop.',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  watch: ({ waitSec }, signal) => (waitSec ? watchJobs(waitSec * 1000, signal) : null),
  async run(ctx, { sessionId, showId, status, limit }) {
    const statusCond = status ? inArray(jobs.status, status) : undefined;
    if (sessionId) {
      await requireSession(ctx, sessionId, 'read');
      const rows = await ctx.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.sessionId, sessionId), statusCond))
        .orderBy(desc(jobs.createdAt))
        .limit(limit);
      return withQueuePositions(ctx.db, rows.map(toJob));
    }
    // Read access is per show, so every session of a readable show is readable.
    await requireShow(ctx, showId!, 'read');
    const rows = await ctx.db
      .select({ job: jobs, sessionTitle: sessions.title })
      .from(jobs)
      .innerJoin(sessions, eq(sessions.id, jobs.sessionId))
      .where(and(eq(sessions.showId, showId!), statusCond))
      .orderBy(desc(jobs.createdAt))
      .limit(limit);
    return withQueuePositions(
      ctx.db,
      rows.map((r) => ({ ...toJob(r.job), sessionTitle: r.sessionTitle })),
    );
  },
});
