// Media: audio segments (recorded / uploaded / YouTube), playback URLs, transcription jobs.
//
// Upload flow: media.createUpload (row status 'uploading' + presigned PUT) → browser PUTs the
// bytes straight to S3 → media.completeUpload (verifies the object, status 'ready', enqueues
// `transcribe`). The worker (src/worker) does the Deepgram and yt-dlp work.

import type { AudioSegment, Job } from '@autologger/contract';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { requireSession, requireShow } from '../core/authz.ts';
import { type BusMessage, changeMessage, subscribe } from '../core/bus.ts';
import { badRequest, conflict, notFound, unavailable } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import { type Ctx, defineOp } from '../core/op.ts';
import type { Tx } from '../db/client.ts';
import { schema } from '../db/client.ts';
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
import { isYoutubeUrl } from '../media/youtube.ts';
import { toAudioSegment } from './map.ts';
import { publishSession } from './sessions.ts';

const { audioSegments, jobs, sessions } = schema;
type SegmentRow = typeof audioSegments.$inferSelect;

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

async function enqueueTranscribe(ctx: Ctx, seg: SegmentRow): Promise<JobRow> {
  const existing = await activeTranscribeJob(ctx.db, seg.id);
  if (existing) return existing;
  const job = await enqueueJob(ctx.db, {
    kind: 'transcribe',
    sessionId: seg.sessionId,
    actorId: ctx.actor.user.id,
    payload: { segmentId: seg.id },
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
    'Import the audio of a YouTube video into the session. Runs in the background: the worker downloads the audio, stores it and transcribes it. Returns the job; wait for it with jobs.list (waitSec).',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { sessionId, url }) {
    if (!env.youtubeEnabled)
      throw unavailable(
        'YouTube import is disabled on this server. Set YOUTUBE_IMPORT=1 to enable it.',
      );
    requireStorage();
    if (!isYoutubeUrl(url))
      throw badRequest('That is not a YouTube URL (youtube.com or youtu.be).');
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

defineOp({
  name: 'media.retranscribe',
  description:
    'Transcribe one audio segment again, or every segment of the session when segmentId is omitted. Replaces the machine transcript of those segments (manual edits to them are lost).',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { sessionId, segmentId }) {
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
    for (const seg of eligible) out.push(await enqueueTranscribe(ctx, seg));
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

/** Fill `queuePosition` on queued jobs: queued jobs the worker will claim first, 0 = next. */
async function withQueuePositions<T extends Job>(tx: Tx, list: T[]): Promise<T[]> {
  const ids = list.filter((j) => j.status === 'queued').map((j) => j.id);
  if (!ids.length) return list;
  const rows = await tx
    .select({
      id: jobs.id,
      ahead: sql<number>`(select count(*)::int from jobs a where a.status = 'queued'
        and (a.run_after, a.created_at) < (jobs.run_after, jobs.created_at))`,
    })
    .from(jobs)
    .where(inArray(jobs.id, ids));
  const ahead = new Map(rows.map((r) => [r.id, r.ahead]));
  return list.map((j) => (ahead.has(j.id) ? { ...j, queuePosition: ahead.get(j.id)! } : j));
}

/**
 * Resolve when a listed unfinished job changes status, is deleted, or a new job appears in one of
 * their sessions — or after `ms`. Listens on the in-process bus (fed by Postgres NOTIFY from the
 * worker), so it holds no database connection while waiting.
 */
function waitForJobChange(list: Job[], ms: number): Promise<void> | null {
  const pending = new Map(
    list.filter((j) => j.status === 'queued' || j.status === 'running').map((j) => [j.id, j]),
  );
  const sessionIds = new Set([...pending.values()].flatMap((j) => j.sessionId ?? []));
  if (!sessionIds.size) return null;
  return new Promise((resolve) => {
    const unsubs: (() => void)[] = [];
    const done = () => {
      clearTimeout(timer);
      for (const u of unsubs) u();
      resolve();
    };
    const timer = setTimeout(done, ms);
    const onMessage = (m: BusMessage) => {
      if (m.type === 'invalidate' && m.entity === 'job') return done();
      if (m.type !== 'change' || m.entity !== 'job') return;
      const status = (m.data as Job | undefined)?.status;
      if (m.op === 'upsert' && status && pending.get(m.id)?.status === status) return; // progress only
      done();
    };
    for (const id of sessionIds) unsubs.push(subscribe(`session:${id}`, onMessage));
  });
}

defineOp({
  name: 'jobs.list',
  description:
    'Background jobs (transcription, YouTube import), newest first, with status, progress and errors. Pass exactly one of sessionId (one session) or showId (every session of the show — each job then includes sessionId and sessionTitle, so one call answers "is the playlist import finished?"). Optional status filters to the given states (e.g. ["queued","running"] for unfinished work; an empty result means nothing is pending); limit defaults to 100 (max 500). Queued jobs include queuePosition: how many queued jobs (from any show) the worker will start before this one, 0 = next; the worker runs a couple of jobs at a time and each usually takes under a minute or two. To wait for jobs, pass waitSec (1–55): if any listed job is queued or running, the call holds until one of them changes status (starts, finishes, fails) or a new job is queued in one of their sessions, then returns the fresh list — or returns after waitSec seconds when nothing changed. Call it again in a loop until the result is empty / all done; no separate sleep is needed. Without waitSec the call returns at once; do not poll it in a tight loop.',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  waitForChange: ({ waitSec }, list) => (waitSec ? waitForJobChange(list, waitSec * 1000) : null),
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
