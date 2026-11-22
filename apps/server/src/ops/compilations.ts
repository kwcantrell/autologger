// Video compilations: one MP4 the worker builds from ranges of a show's YouTube-sourced sessions
// (media/compilations.ts, worker `compile` job). Compilations are show-level output, not session
// content, so they are not in the change log; deleting one removes its video for good.

import type { Compilation } from '@autologger/contract';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { requireShow } from '../core/authz.ts';
import { type BusMessage, subscribeAll, type Topic } from '../core/bus.ts';
import { badRequest, notFound, unavailable } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import { type Ctx, defineOp, type OpWatch } from '../core/op.ts';
import { schema } from '../db/client.ts';
import { env, storageConfigured } from '../env.ts';
import { compilationMessage, resolveClipSources } from '../media/compilations.ts';
import { enqueueJob } from '../media/jobs.ts';
import {
  deleteObject,
  PLAYBACK_URL_TTL_SEC,
  presignPlayback,
  requireStorage,
} from '../media/s3.ts';
import { toCompilation, userRefs } from './map.ts';

const { compilations, jobs, sessions } = schema;
type Row = typeof compilations.$inferSelect;

/** compilations.list returns at most this many (newest first). */
const LIST_MAX = 200;

async function toEntities(ctx: Ctx, rows: Row[]): Promise<Compilation[]> {
  if (!rows.length) return [];
  const users = await userRefs(
    ctx.db,
    rows.map((r) => r.createdBy),
  );
  const ids = [...new Set(rows.flatMap((r) => r.clips.map((c) => c.sessionId)))];
  const titleRows = ids.length
    ? await ctx.db
        .select({ id: sessions.id, title: sessions.title })
        .from(sessions)
        .where(inArray(sessions.id, ids))
    : [];
  const titles = new Map(titleRows.map((t) => [t.id, t.title]));
  const expiresAt = new Date(Date.now() + PLAYBACK_URL_TTL_SEC * 1000).toISOString();
  return Promise.all(
    rows.map(async (r) => {
      const c = toCompilation(r, users, titles);
      if (r.status !== 'ready' || !r.objectKey || !storageConfigured) return c;
      return {
        ...c,
        url: await presignPlayback(r.objectKey, `${r.title}.mp4`),
        urlExpiresAt: expiresAt,
      };
    }),
  );
}

/** The compilation and the actor's access to its show; no access answers not_found. */
async function loadCompilation(ctx: Ctx, compilationId: string, need: 'read' | 'write') {
  const [row] = await ctx.db.select().from(compilations).where(eq(compilations.id, compilationId));
  if (!row) throw notFound('Compilation');
  try {
    await requireShow(ctx, row.showId, need);
  } catch (e) {
    if ((e as { code?: string }).code === 'not_found') throw notFound('Compilation');
    throw e;
  }
  return row;
}

defineOp({
  name: 'compilations.create',
  description:
    'Build one MP4 video from ranges of a show\'s sessions that were imported from YouTube (sessions_get: sourceKind "youtube" with a sourceUrl; media_importYoutube / media_importPlaylist). showId from shows_list; needs write access to the show. clips: 1–100 ranges in play order, each {sessionId, startSec, endSec, label?} in SECONDS FROM THE SESSION START — the same @seconds as transcript_text, search hits and topics — each 1 s to 20 min long, together at most 3 hours. Every session must belong to this show and its range must lie within the session\'s stored YouTube audio; otherwise the call fails with bad_request listing the offending clips (e.g. "clip 2 (sessionId …): the session was not imported from YouTube") and nothing is created. Sessions recorded or uploaded in the app have no video and cannot be compiled. The server then downloads just those sections of the YouTube videos (≤720p), re-encodes them to one H.264/AAC MP4 (1280×720, 30 fps) and stores it; this runs in the background and takes roughly a few seconds per clip-minute plus download time. Returns the Compilation with status "queued". Wait for it with compilations_get {compilationId, waitSec: 60} in a loop until status is "ready" (then url is a presigned download link valid about 1 hour — call compilations_get again for a fresh one, do not store it) or "failed" (error says why). progress reads like "clip 3/12" meanwhile. Users see and play compilations in the web app\'s Compilations page.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { showId, title, clips }) {
    await requireShow(ctx, showId, 'write');
    if (!env.youtubeEnabled)
      throw unavailable('YouTube downloads are disabled on this server (YOUTUBE_IMPORT).');
    requireStorage();
    const sources = await resolveClipSources(ctx.db, clips, showId);
    const problems = sources.flatMap((s, i) =>
      'error' in s ? [`clip ${i + 1} (sessionId ${clips[i]!.sessionId}): ${s.error}`] : [],
    );
    if (problems.length)
      throw badRequest(
        `${problems.length === 1 ? 'This clip cannot' : `${problems.length} clips cannot`} be compiled: ${problems.slice(0, 20).join('; ')}${problems.length > 20 ? `; and ${problems.length - 20} more` : ''}. Only sessions imported from YouTube, with ranges inside the video, can be compiled.`,
      );
    const id = newId('cmp');
    const [row] = await ctx.db
      .insert(compilations)
      .values({
        id,
        showId,
        title,
        clips: clips.map((c, i) => {
          const s = sources[i] as { sessionTitle: string };
          return {
            sessionId: c.sessionId,
            sessionTitle: s.sessionTitle,
            startSec: c.startSec,
            endSec: c.endSec,
            ...(c.label ? { label: c.label } : {}),
          };
        }),
        durationSec: clips.reduce((n, c) => n + (c.endSec - c.startSec), 0),
        progress: 'Queued',
        createdBy: ctx.actor.user.id,
      })
      .returning();
    await enqueueJob(ctx.db, {
      kind: 'compile',
      sessionId: null,
      actorId: ctx.actor.user.id,
      payload: { compilationId: id },
    });
    ctx.publish(`show:${showId}`, compilationMessage(showId, id, 'queued'));
    const [out] = await toEntities(ctx, [row!]);
    return out!;
  },
});

/**
 * Long-poll for compilations.get: listens on the bus before the transaction, then waits until
 * the compilation's status changes (or it is deleted), the timeout, or abort.
 */
function watchCompilation(ms: number, signal?: AbortSignal): OpWatch<Compilation> {
  const seen: BusMessage[] = [];
  let onMessage = (_t: Topic, m: BusMessage) => void seen.push(m);
  const unsubscribe = subscribeAll((t, m) => onMessage(t, m));
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
    wait(c) {
      if (c.status === 'ready' || c.status === 'failed' || signal?.aborted) return null;
      const relevant = (m: BusMessage) =>
        m.type === 'compilation_changed' && m.id === c.id && m.status !== c.status;
      return new Promise<void>((resolve) => {
        finish = () => {
          finish = () => {};
          resolve();
          cancel();
        };
        if (seen.some(relevant)) return finish();
        onMessage = (_t, m) => {
          if (relevant(m)) finish();
        };
        timer = setTimeout(() => finish(), ms);
        timer.unref();
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}

defineOp({
  name: 'compilations.get',
  description:
    'One video compilation (compilationId from compilations_create or compilations_list): status "queued" | "running" | "ready" | "failed", progress while working (e.g. "clip 3/12"), error when failed, the clips (session seconds), durationSec (seconds; the sum of the clip lengths until ready, then the measured video length) and sizeBytes. When ready it includes url: a presigned link to the MP4 valid about 1 hour (urlExpiresAt) — fetch a fresh one with this call rather than storing it. To wait for a compilation, pass waitSec (1–60): while it is queued or running the call holds until its status changes (or it is deleted), then returns it — or after waitSec seconds unchanged. Call it again in a loop until ready or failed; no separate sleep is needed. Needs read access to the show.',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  watch: ({ waitSec }, signal) => (waitSec ? watchCompilation(waitSec * 1000, signal) : null),
  async run(ctx, { compilationId }) {
    const row = await loadCompilation(ctx, compilationId, 'read');
    const [out] = await toEntities(ctx, [row]);
    return out!;
  },
});

defineOp({
  name: 'compilations.list',
  description: `The video compilations of a show (showId from shows_list), newest first (at most ${LIST_MAX}), each as in compilations_get: status, progress, clips, durationSec and, when ready, a url valid about 1 hour. Needs read access to the show.`,
  kind: 'read',
  surfaces: ['web', 'mcp'],
  async run(ctx, { showId }) {
    await requireShow(ctx, showId, 'read');
    const rows = await ctx.db
      .select()
      .from(compilations)
      .where(eq(compilations.showId, showId))
      .orderBy(desc(compilations.createdAt), desc(compilations.id))
      .limit(LIST_MAX);
    return toEntities(ctx, rows);
  },
});

defineOp({
  name: 'compilations.delete',
  description:
    'Delete a video compilation and its stored MP4 (compilationId from compilations_list). A compilation still being built is cancelled. This cannot be undone (the sessions and their media are not affected; create it again with compilations_create). Needs write access to the show. Returns {ok: true}.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { compilationId }) {
    const row = await loadCompilation(ctx, compilationId, 'write');
    await ctx.db.delete(compilations).where(eq(compilations.id, row.id));
    // A queued build has nothing left to do; a running one finds the row gone and cleans up.
    await ctx.db
      .update(jobs)
      .set({ status: 'failed', error: 'Compilation deleted.', updatedAt: new Date() })
      .where(
        and(
          eq(jobs.kind, 'compile'),
          eq(jobs.status, 'queued'),
          sql`${jobs.payload}->>'compilationId' = ${row.id}`,
        ),
      );
    const key = row.objectKey;
    if (key && storageConfigured)
      ctx.afterCommit(async () => {
        try {
          await deleteObject(key);
        } catch (e) {
          console.warn(`could not delete object ${key}: ${(e as Error).message}`);
        }
      });
    ctx.publish(`show:${row.showId}`, compilationMessage(row.showId, row.id, 'deleted'));
    return { ok: true as const };
  },
});
