import {
  parseTimecode,
  type Session,
  type SessionDetail,
  type TranscriptJob,
  transportElapsed,
} from '@autologger/contract';
import { and, desc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import {
  readableShowCondition,
  requireSession,
  requireShow,
  showAccessMap,
} from '../core/authz.ts';
import { changeMessage } from '../core/bus.ts';
import { badRequest, conflict } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import { type Ctx, defineOp } from '../core/op.ts';
import { schema } from '../db/client.ts';
import { toJob, withJobEstimates } from '../media/jobs.ts';
import { iso, userRefs } from './map.ts';

const { jobs, sessions, shows } = schema;

const aggregates = {
  eventCount: sql<number>`(select count(*)::int from events e where e.session_id = ${sessions.id})`,
  audioSeconds: sql<number>`(select coalesce(sum(a.duration_sec), 0)::float from audio_segments a where a.session_id = ${sessions.id} and a.status <> 'failed')`,
  segTotal: sql<number>`(select count(*)::int from audio_segments a where a.session_id = ${sessions.id})`,
  segDone: sql<number>`(select count(*)::int from audio_segments a where a.session_id = ${sessions.id} and a.status = 'transcribed')`,
  segFailed: sql<number>`(select count(*)::int from audio_segments a where a.session_id = ${sessions.id} and a.status = 'failed')`,
};

function transcriptStatus(
  total: number,
  done: number,
  failed: number,
): Session['transcriptStatus'] {
  if (total === 0) return 'none';
  if (done === total) return 'done';
  if (failed > 0 && done + failed === total) return done > 0 ? 'partial' : 'failed';
  return done > 0 ? 'partial' : 'pending';
}

export async function loadSessions(
  ctx: Ctx,
  where: SQL | undefined,
  limit = 500,
): Promise<Session[]> {
  const rows = await ctx.db
    .select({ s: sessions, show: shows, ...aggregates })
    .from(sessions)
    .innerJoin(shows, eq(shows.id, sessions.showId))
    .where(and(readableShowCondition(ctx, sessions.showId), where))
    .orderBy(desc(sessions.createdAt))
    .limit(limit);
  const access = await showAccessMap(ctx, [
    ...new Map(rows.map((r) => [r.show.id, r.show])).values(),
  ]);
  const users = await userRefs(
    ctx.db,
    rows.map((r) => r.s.createdBy),
  );
  return rows
    .filter((r) => access.has(r.show.id))
    .map(({ s, show, eventCount, audioSeconds, segTotal, segDone, segFailed }) => ({
      id: s.id,
      showId: s.showId,
      showName: show.name,
      title: s.title,
      episode: s.episode,
      episodeDate: s.episodeDate,
      notes: s.notes,
      frameRate: s.frameRate,
      startOffsetFrames: s.startOffsetFrames,
      isRolling: s.isRolling,
      rollStartedAt: iso(s.rollStartedAt),
      elapsedFrames: s.elapsedFrames,
      take: s.take,
      eventCount,
      audioSeconds,
      transcriptStatus: transcriptStatus(segTotal, segDone, segFailed),
      sourceKind: s.sourceKind,
      sourceUrl: s.sourceUrl,
      keyTerms: s.keyTerms,
      archivedAt: iso(s.archivedAt),
      createdAt: s.createdAt.toISOString(),
      createdBy: s.createdBy ? (users.get(s.createdBy) ?? null) : null,
      access: access.get(show.id)!,
    }));
}

export async function getSession(ctx: Ctx, sessionId: string): Promise<Session> {
  const [s] = await loadSessions(ctx, eq(sessions.id, sessionId), 1);
  return s!;
}

/** The unfinished job expected to finish last that leads to the session's transcript, or null. */
async function transcriptJob(ctx: Ctx, sessionId: string): Promise<TranscriptJob | null> {
  const rows = await ctx.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.sessionId, sessionId), inArray(jobs.status, ['queued', 'running'])));
  if (!rows.length) return null;
  const list = await withJobEstimates(ctx.db, rows.map(toJob), { untilTranscript: true });
  // No estimate (no history, or waiting out a retry) sorts as the latest.
  const last = list.reduce((a, b) =>
    (b.etaSec ?? Number.POSITIVE_INFINITY) > (a.etaSec ?? Number.POSITIVE_INFINITY) ? b : a,
  );
  return {
    id: last.id,
    kind: last.kind,
    status: last.status as TranscriptJob['status'],
    ...(last.queuePosition !== undefined ? { queuePosition: last.queuePosition } : {}),
    ...(last.etaSec !== undefined ? { etaSec: last.etaSec } : {}),
  };
}

/** Publish the session's new state to its live subscribers. */
export async function publishSession(ctx: Ctx, sessionId: string): Promise<Session> {
  const s = await getSession(ctx, sessionId);
  ctx.publish(`session:${sessionId}`, { type: 'transport', session: s });
  ctx.publish(`session:${sessionId}`, changeMessage('session', 'upsert', sessionId, s));
  // Companion devices following the show pick the live/newest session from show-level changes.
  ctx.publish(`show:${s.showId}`, { type: 'show_changed', showId: s.showId, entity: 'show' });
  return s;
}

function defaultTitle(show: typeof shows.$inferSelect, episode: string, date: string): string {
  if (show.titleSuffix === 'episode') return `${show.code} ${episode}`.trim();
  if (show.titleSuffix === 'none') return show.name;
  return `${show.code} ${date}`;
}

/**
 * Atomically take `count` consecutive episode numbers from the show counter; returns the first.
 * Safe against concurrent session creation (one UPDATE … RETURNING).
 */
export async function reserveEpisodes(ctx: Ctx, showId: string, count: number): Promise<number> {
  const [row] = await ctx.db
    .update(shows)
    .set({ nextEpisode: sql`${shows.nextEpisode} + ${count}` })
    .where(eq(shows.id, showId))
    .returning({ next: shows.nextEpisode });
  return row!.next - count;
}

defineOp({
  name: 'sessions.list',
  description:
    'Sessions you can access, newest first. Filter by show; archived sessions are excluded unless asked for.',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  async run(ctx, { showId, includeArchived, limit }) {
    if (showId) await requireShow(ctx, showId, 'read');
    return loadSessions(
      ctx,
      and(
        showId ? eq(sessions.showId, showId) : undefined,
        includeArchived ? undefined : isNull(sessions.archivedAt),
      ),
      limit,
    );
  },
});

defineOp({
  name: 'sessions.get',
  description:
    'One session: metadata, transport state, frame rate, event count and transcript status. transcriptJob is the queued or running background job that will produce the transcript, or null when none is (then transcriptStatus is final: done, partial, failed or none): {id, kind, status, queuePosition?, etaSec?}. kind is "transcribe", or "youtube_import" while a YouTube import is still downloading (its transcription is queued when the download finishes). With several (one per audio segment) it is the one expected to finish last. queuePosition means the same as in jobs.list; etaSec is a rough estimate in seconds until the transcript is ready: for a youtube_import it includes the expected transcription time when the video length is known (playlist imports), otherwise (media.importYoutube) it covers the download only, an underestimate; wait for the job with jobs.list (sessionId, waitSec).',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  async run(ctx, { sessionId }): Promise<SessionDetail> {
    await requireSession(ctx, sessionId, 'read');
    const session = await getSession(ctx, sessionId);
    return { ...session, transcriptJob: await transcriptJob(ctx, sessionId) };
  },
});

defineOp({
  name: 'sessions.create',
  description:
    "Create a session in a show. Title defaults from the show code and date or episode number. Omit `episode` to take the show's next episode number; the counter is advanced atomically, so parallel calls get distinct numbers. An explicit whole-number `episode` (e.g. \"19\") at or above the counter moves it past that number (next default becomes 20); non-numeric episodes (e.g. \"12b\") leave it alone. `keyTerms`: names and jargon to favour when this session's audio is transcribed (e.g. the guest's name), at most 50 terms of up to 50 characters and 1000 characters in total. They are sent before the show's key terms; if the two lists together exceed those limits, the show terms that don't fit are dropped. Prefer session terms for anything that is not said in every session: the transcriber pushes key terms into audio that doesn't contain them.",
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, input) {
    const { show } = await requireShow(ctx, input.showId, 'write');
    const frameRate = input.frameRate ?? show.defaultFrameRate;
    let startOffsetFrames = 0;
    if (input.startTimecode) {
      const f = parseTimecode(input.startTimecode, frameRate);
      if (f === null) throw badRequest('Start timecode is not valid for this frame rate.');
      startOffsetFrames = f;
    }
    const date = input.episodeDate ?? new Date().toISOString().slice(0, 10);
    // Advance the show's counter atomically in this transaction: the row lock serializes parallel
    // creates, so each default number is handed out once.
    let episode = input.episode;
    if (!episode) {
      const [row] = await ctx.db
        .update(shows)
        .set({ nextEpisode: sql`${shows.nextEpisode} + 1` })
        .where(eq(shows.id, show.id))
        .returning({ next: shows.nextEpisode });
      episode = String(row!.next - 1);
    } else if (/^\d{1,9}$/.test(episode)) {
      await ctx.db
        .update(shows)
        .set({ nextEpisode: sql`greatest(${shows.nextEpisode}, ${Number(episode) + 1})` })
        .where(eq(shows.id, show.id));
    }
    const id = newId('ses');
    await ctx.db.insert(sessions).values({
      id,
      showId: show.id,
      title: input.title || defaultTitle(show, episode, date),
      episode,
      episodeDate: date,
      notes: input.notes ?? '',
      keyTerms: [...new Set(input.keyTerms ?? [])],
      frameRate,
      startOffsetFrames,
      createdBy: ctx.actor.user.id,
    });
    ctx.publish(`show:${show.id}`, { type: 'show_changed', showId: show.id, entity: 'show' });
    return getSession(ctx, id);
  },
});

defineOp({
  name: 'sessions.update',
  description:
    "Edit session metadata; only the fields you pass change. Frame rate and start timecode can only change while the transport is stopped. `keyTerms` replaces this session's transcription key terms (same limits as in sessions_create; [] clears them); they apply to transcriptions that run from now on, so re-transcribe (media_retranscribe) to use them on audio already transcribed. Metadata and key-term changes are not in the change log and cannot be undone from it.",
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { sessionId, startTimecode, ...patch }) {
    const { session } = await requireSession(ctx, sessionId, 'write');
    const set: Partial<typeof sessions.$inferInsert> = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined),
    );
    if ((set.frameRate !== undefined || startTimecode) && session.isRolling) {
      throw conflict('Stop the transport before changing frame rate or start timecode.');
    }
    if (set.keyTerms) set.keyTerms = [...new Set(set.keyTerms)];
    if (startTimecode) {
      const f = parseTimecode(startTimecode, set.frameRate ?? session.frameRate);
      if (f === null) throw badRequest('Start timecode is not valid for this frame rate.');
      set.startOffsetFrames = f;
    }
    await ctx.db
      .update(sessions)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(sessions.id, sessionId));
    return publishSession(ctx, sessionId);
  },
});

defineOp({
  name: 'sessions.archive',
  description: 'Archive or restore a session.',
  kind: 'write',
  surfaces: ['web'],
  async run(ctx, { sessionId, archived }) {
    const { session } = await requireSession(ctx, sessionId, 'write');
    if (archived && session.isRolling) throw conflict('Stop the transport before archiving.');
    await ctx.db
      .update(sessions)
      .set({ archivedAt: archived ? new Date() : null })
      .where(eq(sessions.id, sessionId));
    return publishSession(ctx, sessionId);
  },
});

defineOp({
  name: 'sessions.delete',
  description: 'Permanently delete a session and everything in it (owner/admin).',
  kind: 'write',
  surfaces: ['web'],
  async run(ctx, { sessionId }) {
    await requireSession(ctx, sessionId, 'manage');
    await ctx.db.delete(sessions).where(eq(sessions.id, sessionId));
    ctx.publish(`session:${sessionId}`, { type: 'closed', reason: 'deleted' });
    return { deleted: true };
  },
});

// ── transport ────────────────────────────────────────────────

defineOp({
  name: 'transport.start',
  description: 'Start rolling the session clock. Each start begins a new take.',
  kind: 'write',
  surfaces: ['web', 'companion'],
  async run(ctx, { sessionId }) {
    const { session } = await requireSession(ctx, sessionId, 'write');
    if (session.archivedAt) throw conflict('This session is archived.');
    if (!session.isRolling) {
      await ctx.db
        .update(sessions)
        .set({
          isRolling: true,
          rollStartedAt: new Date(),
          take: session.take + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(sessions.id, sessionId), eq(sessions.isRolling, false)));
    }
    return publishSession(ctx, sessionId);
  },
});

defineOp({
  name: 'transport.stop',
  description: 'Stop the session clock; elapsed time is kept.',
  kind: 'write',
  surfaces: ['web', 'companion'],
  async run(ctx, { sessionId }) {
    const { session } = await requireSession(ctx, sessionId, 'write');
    if (session.isRolling) {
      const elapsed = transportElapsed({
        isRolling: true,
        rollStartedAt: iso(session.rollStartedAt),
        elapsedFrames: session.elapsedFrames,
        take: session.take,
        frameRate: session.frameRate,
        startOffsetFrames: session.startOffsetFrames,
      });
      await ctx.db
        .update(sessions)
        .set({
          isRolling: false,
          rollStartedAt: null,
          elapsedFrames: elapsed,
          updatedAt: new Date(),
        })
        .where(eq(sessions.id, sessionId));
    }
    return publishSession(ctx, sessionId);
  },
});

defineOp({
  name: 'transport.reset',
  description: 'Reset the stopped session clock to its start timecode.',
  kind: 'write',
  surfaces: ['web'],
  async run(ctx, { sessionId }) {
    const { session } = await requireSession(ctx, sessionId, 'write');
    if (session.isRolling) throw conflict('Stop the transport before resetting it.');
    await ctx.db
      .update(sessions)
      .set({ elapsedFrames: 0, updatedAt: new Date() })
      .where(eq(sessions.id, sessionId));
    return publishSession(ctx, sessionId);
  },
});
