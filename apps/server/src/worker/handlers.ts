// Job handlers. The worker writes directly through `db` (no executeOp): these are machine
// writes attributed to the job's actor and are not recorded in the change log.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TranscriptRule } from '@autologger/contract';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { changeMessage, publish } from '../core/bus.ts';
import { newId } from '../core/ids.ts';
import { db, schema } from '../db/client.ts';
import { env, transcriptionConfigured } from '../env.ts';
import {
  type ClipSource,
  compilationMessage,
  concatClips,
  normalizeClip,
  probeDuration,
  resolveClipSources,
} from '../media/compilations.ts';
import {
  countKeyTerms,
  DEFAULT_TRANSCRIPTION_OPTIONS,
  describeKeyTermCounts,
  describeTranscriber,
  mapDeepgram,
  PermanentError,
  selectKeyTerms,
  type TranscriptionOptions,
  transcribeAudio,
} from '../media/deepgram.ts';
import { enqueueJob, type JobRow, toJob } from '../media/jobs.ts';
import { applyShowRules, describeRuleCounts } from '../media/rules.ts';
import {
  compilationKeyFor,
  deleteObject,
  getObjectStream,
  objectKeyFor,
  peaksKeyFor,
  presignServerGet,
  putObjectBody,
  putObjectFromFile,
  requireStorage,
} from '../media/s3.ts';
import { lockSession, nextSegmentSlot, STORED } from '../media/segments.ts';
import { computePeaks, encodePeaks, ffmpegAvailable } from '../media/waveform.ts';
import { downloadAudio, downloadSection } from '../media/youtube.ts';
import { toAudioSegment } from '../ops/map.ts';
import { setProgress } from './queue.ts';

const { audioSegments, compilations, jobs, transcriptSegments, sessions, shows } = schema;
type SegmentRow = typeof audioSegments.$inferSelect;

export interface Handler {
  run(job: JobRow): Promise<string | undefined>;
  /** Called once the job has failed for good. */
  onFinalFailure?(job: JobRow, message: string): Promise<void>;
}

function publishSegment(seg: SegmentRow): void {
  publish(
    `session:${seg.sessionId}`,
    changeMessage('audio_segment', 'upsert', seg.id, toAudioSegment(seg)),
  );
}

async function updateSegment(
  id: string,
  set: Partial<typeof audioSegments.$inferInsert>,
): Promise<SegmentRow | null> {
  const [row] = await db.update(audioSegments).set(set).where(eq(audioSegments.id, id)).returning();
  if (row) publishSegment(row);
  return row ?? null;
}

/**
 * The transcription settings for a session, read when the job runs (not when it is queued) so
 * `media.retranscribe` picks up edits made since. Key terms are the session's (or a one-off list
 * given to `media.retranscribe`) followed by the show's; `deepgramUrl` keeps the first that fit.
 */
export async function transcriptionOptionsFor(
  sessionId: string,
  sessionTermsOverride?: string[],
): Promise<TranscriptionOptions> {
  const [row] = await db
    .select({
      smartFormat: shows.smartFormat,
      showTerms: shows.keyTerms,
      sessionTerms: sessions.keyTerms,
    })
    .from(sessions)
    .innerJoin(shows, eq(shows.id, sessions.showId))
    .where(eq(sessions.id, sessionId));
  if (!row) return DEFAULT_TRANSCRIPTION_OPTIONS;
  const sessionTerms = sessionTermsOverride ?? row.sessionTerms;
  return { smartFormat: row.smartFormat, keyTerms: [...sessionTerms, ...row.showTerms] };
}

/** The show's transcript replacement rules for a session, read when the job runs. */
export async function transcriptRulesFor(sessionId: string): Promise<TranscriptRule[]> {
  const [row] = await db
    .select({ rules: shows.transcriptRules })
    .from(sessions)
    .innerJoin(shows, eq(shows.id, sessions.showId))
    .where(eq(sessions.id, sessionId));
  return row?.rules ?? [];
}

const segmentIdOf = (job: JobRow) => (job.payload as { segmentId?: string }).segmentId;
/** One-off session key terms passed to `media.retranscribe`. */
const keyTermsOf = (job: JobRow) => (job.payload as { keyTerms?: string[] }).keyTerms;

const transcribe: Handler = {
  async run(job) {
    if (!transcriptionConfigured)
      throw new PermanentError('Transcription is not configured on the worker (DEEPGRAM_API_KEY).');
    const segmentId = segmentIdOf(job);
    if (!segmentId) throw new PermanentError('Job payload has no segmentId.');
    const [seg] = await db.select().from(audioSegments).where(eq(audioSegments.id, segmentId));
    if (!seg) return 'Audio segment was deleted';
    if (seg.status === 'uploading')
      throw new PermanentError('The audio segment has not finished uploading.');

    await updateSegment(seg.id, { status: 'transcribing', error: null });
    await setProgress(job, 'Transcribing');
    const opts = await transcriptionOptionsFor(seg.sessionId, keyTermsOf(job));
    const { body, size } = await getObjectStream(seg.objectKey);
    const resp = await transcribeAudio(env.deepgramApiKey!, body, seg.mimeType, size, opts);
    const rules = await transcriptRulesFor(seg.sessionId);
    if (rules.length) await setProgress(job, 'Applying replacement rules');
    const {
      segments: mapped,
      counts,
      skipped,
    } = await applyShowRules(mapDeepgram(resp, seg.startSec), rules);

    const updated = await db.transaction(async (tx) => {
      const [still] = await tx
        .select({ id: audioSegments.id })
        .from(audioSegments)
        .where(eq(audioSegments.id, seg.id))
        .for('update');
      if (!still) return null;
      await tx.delete(transcriptSegments).where(eq(transcriptSegments.audioSegmentId, seg.id));
      if (mapped.length) {
        await tx.insert(transcriptSegments).values(
          mapped.map((m) => ({
            id: newId('trs'),
            sessionId: seg.sessionId,
            audioSegmentId: seg.id,
            ...m,
          })),
        );
      }
      const duration = resp.metadata?.duration;
      const [row] = await tx
        .update(audioSegments)
        .set({
          status: 'transcribed',
          error: null,
          ...(seg.durationSec === null && typeof duration === 'number'
            ? { durationSec: duration }
            : {}),
        })
        .where(eq(audioSegments.id, seg.id))
        .returning();
      return row ?? null;
    });
    if (!updated) return 'Audio segment was deleted';
    const topic = `session:${seg.sessionId}` as const;
    publishSegment(updated);
    publish(topic, { type: 'invalidate', entity: 'transcript_segment' });
    publish(topic, { type: 'invalidate', entity: 'session' });
    const notes = [
      describeRuleCounts(counts, skipped),
      describeKeyTermCounts(
        countKeyTerms(
          mapped.map((m) => m.text),
          selectKeyTerms(opts.keyTerms),
        ),
      ),
      describeTranscriber(resp),
    ].filter(Boolean);
    return `Transcribed ${mapped.length} segment${mapped.length === 1 ? '' : 's'}${notes.map((n) => `; ${n}`).join('')}`;
  },
  async onFinalFailure(job, message) {
    const segmentId = segmentIdOf(job);
    if (!segmentId) return;
    const row = await updateSegment(segmentId, { status: 'failed', error: message.slice(0, 1000) });
    if (row) publish(`session:${row.sessionId}`, { type: 'invalidate', entity: 'session' });
  },
};

const youtubeImport: Handler = {
  async run(job) {
    requireStorage();
    const url = (job.payload as { url?: string }).url;
    if (!url || !job.sessionId) throw new PermanentError('Job payload has no url or session.');
    const sessionId = job.sessionId;
    const [session] = await db
      .select({
        id: sessions.id,
        episodeDate: sessions.episodeDate,
        createdAt: sessions.createdAt,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!session) return 'Session was deleted';

    await setProgress(job, 'Downloading from YouTube');
    const dl = await downloadAudio(env.ytDlpPath, url);
    try {
      const segmentId = newId('aud');
      const objectKey = objectKeyFor(sessionId, segmentId, dl.ext);
      await setProgress(job, 'Storing audio');
      const size = await putObjectFromFile(objectKey, dl.path, dl.mimeType);

      const { seg, transcribeJob, waveformJob } = await db.transaction(async (tx) => {
        await lockSession(tx, sessionId);
        const slot = await nextSegmentSlot(tx, sessionId);
        const [seg] = await tx
          .insert(audioSegments)
          .values({
            id: segmentId,
            sessionId,
            ordinal: slot.ordinal,
            startSec: 0,
            durationSec: dl.durationSec,
            mimeType: dl.mimeType,
            origin: 'youtube',
            fileName: dl.title,
            objectKey,
            sizeBytes: size,
            status: 'ready',
            createdBy: job.actorId,
          })
          .returning();
        // The upload date replaces the date only while it is still the default (creation day).
        const defaultDate =
          !session.episodeDate ||
          session.episodeDate === session.createdAt.toISOString().slice(0, 10);
        await tx
          .update(sessions)
          .set({
            sourceKind: 'youtube',
            sourceUrl: url,
            ...(dl.uploadDate && defaultDate ? { episodeDate: dl.uploadDate } : {}),
            updatedAt: sql`now()`,
          })
          .where(eq(sessions.id, sessionId));
        const transcribeJob = transcriptionConfigured
          ? await enqueueJob(
              tx,
              { kind: 'transcribe', sessionId, actorId: job.actorId, payload: { segmentId } },
              { after: job },
            )
          : null;
        const waveformJob = await enqueueJob(
          tx,
          { kind: 'waveform', sessionId, actorId: job.actorId, payload: { segmentId } },
          { after: job },
        );
        return { seg: seg!, transcribeJob, waveformJob };
      });
      const topic = `session:${sessionId}` as const;
      publishSegment(seg);
      for (const j of [transcribeJob, waveformJob])
        if (j) publish(topic, changeMessage('job', 'upsert', j.id, toJob(j)));
      publish(topic, { type: 'invalidate', entity: 'session' });
      return transcribeJob ? 'Imported; transcription queued' : 'Imported';
    } finally {
      await dl.cleanup();
    }
  },
};

const waveform: Handler = {
  async run(job) {
    requireStorage();
    const segmentId = segmentIdOf(job);
    if (!segmentId) throw new PermanentError('Job payload has no segmentId.');
    const [seg] = await db.select().from(audioSegments).where(eq(audioSegments.id, segmentId));
    if (!seg) return 'Audio segment was deleted';
    if (!(STORED as readonly string[]).includes(seg.status))
      throw new PermanentError(`The audio segment is ${seg.status}, not stored audio.`);
    if (!(await ffmpegAvailable(env.ffmpegPath))) {
      // Not a failure of the audio: done with a note, and a worker that has ffmpeg picks the
      // segment up again at startup (backfillWaveforms).
      const note = `Skipped: ffmpeg not found on the worker (FFMPEG_PATH=${env.ffmpegPath})`;
      console.warn(`job ${job.id} (waveform): ${note}`);
      return note;
    }

    await setProgress(job, 'Computing waveform');
    const { peaks, durationSec } = await computePeaks(
      env.ffmpegPath,
      await presignServerGet(seg.objectKey),
    );
    const key = peaksKeyFor(seg.sessionId, seg.id);
    await putObjectBody(key, encodePeaks(peaks, durationSec), 'application/json');
    const row = await updateSegment(seg.id, {
      peaksKey: key,
      ...(seg.durationSec === null && durationSec > 0 ? { durationSec } : {}),
    });
    if (!row) {
      await deleteObject(key).catch(() => {});
      return 'Audio segment was deleted';
    }
    return `Waveform: ${peaks.length} peaks over ${Math.round(durationSec)} s`;
  },
};

/**
 * Queue a waveform job for stored audio without peaks: segments from before waveforms existed,
 * and ones whose job was skipped on a worker without ffmpeg. Segments with a queued, running or
 * failed waveform job are left alone (a failed one is not retried on every restart; users retry it
 * with media.rewaveform). Runs at
 * worker startup when ffmpeg is available; an advisory lock keeps simultaneous starts from
 * queueing twice. Queues at most BACKFILL_MAX per run. Returns the number of jobs queued.
 */
/** Waveform jobs one backfill queues at most; the next worker start continues. */
export const BACKFILL_MAX = 200;

export async function backfillWaveforms(): Promise<number> {
  const queued = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('autologger:waveform-backfill'))`);
    const rows = await tx
      .select({ id: audioSegments.id, sessionId: audioSegments.sessionId })
      .from(audioSegments)
      .where(
        and(
          isNull(audioSegments.peaksKey),
          inArray(audioSegments.status, [...STORED]),
          sql`not exists (select 1 from ${jobs} j where j.kind = 'waveform'
            and j.status in ('queued', 'running', 'failed')
            and j.payload->>'segmentId' = ${audioSegments.id})`,
        ),
      )
      .orderBy(audioSegments.createdAt)
      .limit(BACKFILL_MAX);
    const base = Date.now();
    const out: JobRow[] = [];
    for (const [i, r] of rows.entries()) {
      out.push(
        await enqueueJob(
          tx,
          { kind: 'waveform', sessionId: r.sessionId, actorId: null, payload: { segmentId: r.id } },
          { at: new Date(base + i) },
        ),
      );
    }
    return out;
  });
  for (const j of queued)
    publish(`session:${j.sessionId}`, changeMessage('job', 'upsert', j.id, toJob(j)));
  return queued.length;
}

const compilationIdOf = (job: JobRow) => (job.payload as { compilationId?: string }).compilationId;

type CompilationRow = typeof compilations.$inferSelect;

/** Update a compilation and tell the show (web list, compilations.get waiters). Null: deleted. */
async function updateCompilation(
  id: string,
  set: Partial<typeof compilations.$inferInsert>,
): Promise<CompilationRow | null> {
  const [row] = await db
    .update(compilations)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(compilations.id, id))
    .returning();
  if (row) publish(`show:${row.showId}`, compilationMessage(row.showId, row.id, row.status));
  return row ?? null;
}

/** Thrown between steps when the compilation was deleted meanwhile; ends the job quietly. */
class CompilationGone extends Error {}

const compile: Handler = {
  async run(job) {
    requireStorage();
    const compilationId = compilationIdOf(job);
    if (!compilationId) throw new PermanentError('Job payload has no compilationId.');
    const [found] = await db.select().from(compilations).where(eq(compilations.id, compilationId));
    if (!found) return 'Compilation was deleted';
    if (!env.youtubeEnabled)
      throw new PermanentError('YouTube downloads are disabled on the worker (YOUTUBE_IMPORT).');
    if (!(await ffmpegAvailable(env.ffmpegPath)))
      throw new PermanentError(`ffmpeg not found on the worker (FFMPEG_PATH=${env.ffmpegPath}).`);

    const clips = found.clips;
    const n = clips.length;
    const step = async (progress: string) => {
      await setProgress(job, progress);
      const row = await updateCompilation(compilationId, {
        status: 'running',
        progress,
        error: null,
      });
      if (!row) throw new CompilationGone();
    };

    const dir = await mkdtemp(join(tmpdir(), 'autologger-compile-'));
    try {
      await step(`clip 0/${n}: starting`);
      // Sessions may have been re-imported or deleted since the compilation was created.
      const sources = await resolveClipSources(db, clips, found.showId);
      const bad = sources.findIndex((s) => 'error' in s);
      if (bad !== -1)
        throw new PermanentError(
          `Clip ${bad + 1} cannot be compiled any more: ${(sources[bad] as { error: string }).error}.`,
        );
      const parts: string[] = [];
      for (const [i, src] of (sources as ClipSource[]).entries()) {
        await step(`clip ${i + 1}/${n}: downloading`);
        const raw = await downloadSection(
          env.ytDlpPath,
          env.ffmpegPath,
          src.url,
          src.fromSec,
          src.toSec,
          dir,
          `raw-${i}`,
        );
        await step(`clip ${i + 1}/${n}: encoding`);
        const part = join(dir, `part-${String(i).padStart(3, '0')}.mp4`);
        await normalizeClip(env.ffmpegPath, raw, part, src.toSec - src.fromSec);
        await rm(raw, { force: true });
        parts.push(part);
      }
      await step(`clip ${n}/${n}: joining`);
      const out = join(dir, 'compilation.mp4');
      await concatClips(env.ffmpegPath, parts, join(dir, 'parts.txt'), out);
      const measured = await probeDuration(env.ffmpegPath, out);
      await step('Storing video');
      const key = compilationKeyFor(found.showId, compilationId);
      const size = await putObjectFromFile(key, out, 'video/mp4');
      const row = await updateCompilation(compilationId, {
        status: 'ready',
        progress: null,
        error: null,
        objectKey: key,
        sizeBytes: size,
        ...(measured ? { durationSec: measured } : {}),
      });
      if (!row) {
        await deleteObject(key).catch(() => {});
        return 'Compilation was deleted';
      }
      return `Compiled ${n} clip${n === 1 ? '' : 's'}, ${Math.round(row.durationSec)} s, ${Math.round(size / 1024 / 1024)} MB`;
    } catch (e) {
      if (e instanceof CompilationGone) return 'Compilation was deleted';
      // Retried unless permanent or out of attempts (then onFinalFailure marks it failed).
      await updateCompilation(compilationId, {
        status: 'queued',
        progress: `Retrying after an error: ${(e as Error).message}`.slice(0, 1000),
      }).catch(() => {});
      throw e;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  },
  async onFinalFailure(job, message) {
    const compilationId = compilationIdOf(job);
    if (!compilationId) return;
    await updateCompilation(compilationId, {
      status: 'failed',
      progress: null,
      error: message.slice(0, 1000),
    });
  },
};

export const handlers: Record<JobRow['kind'], Handler> = {
  transcribe,
  youtube_import: youtubeImport,
  waveform,
  compile,
};
