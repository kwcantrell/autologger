// Job handlers. The worker writes directly through `db` (no executeOp): these are machine
// writes attributed to the job's actor and are not recorded in the change log.

import type { TranscriptRule } from '@autologger/contract';
import { eq, sql } from 'drizzle-orm';
import { changeMessage, publish } from '../core/bus.ts';
import { newId } from '../core/ids.ts';
import { db, schema } from '../db/client.ts';
import { env, transcriptionConfigured } from '../env.ts';
import {
  countKeyTerms,
  DEFAULT_TRANSCRIPTION_OPTIONS,
  describeKeyTermCounts,
  mapDeepgram,
  PermanentError,
  selectKeyTerms,
  type TranscriptionOptions,
  transcribeAudio,
} from '../media/deepgram.ts';
import { enqueueJob, type JobRow, toJob } from '../media/jobs.ts';
import { applyShowRules, describeRuleCounts } from '../media/rules.ts';
import { getObjectStream, objectKeyFor, putObjectFromFile, requireStorage } from '../media/s3.ts';
import { lockSession, nextSegmentSlot } from '../media/segments.ts';
import { downloadAudio } from '../media/youtube.ts';
import { toAudioSegment } from '../ops/map.ts';
import { setProgress } from './queue.ts';

const { audioSegments, transcriptSegments, sessions, shows } = schema;
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

      const { seg, transcribeJob } = await db.transaction(async (tx) => {
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
        return { seg: seg!, transcribeJob };
      });
      const topic = `session:${sessionId}` as const;
      publishSegment(seg);
      if (transcribeJob)
        publish(topic, changeMessage('job', 'upsert', transcribeJob.id, toJob(transcribeJob)));
      publish(topic, { type: 'invalidate', entity: 'session' });
      return transcribeJob ? 'Imported; transcription queued' : 'Imported';
    } finally {
      await dl.cleanup();
    }
  },
};

export const handlers: Record<JobRow['kind'], Handler> = {
  transcribe,
  youtube_import: youtubeImport,
};
