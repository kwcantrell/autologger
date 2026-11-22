// Video compilations: one MP4 the worker builds from ranges of a show's YouTube-sourced sessions
// (media/compilations.ts, worker `compile` job), or the local import helper builds on the user's
// computer and uploads (`buildLocally`: compilations.createUpload / completeUpload). Compilations are show-level output, not session
// content, so they are not in the change log; deleting one removes its video for good. The
// "Compilation" events create logs in the source sessions are content: recorded and undoable.

import type { Compilation } from '@autologger/contract';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { requireSession, requireShow, type SessionRow } from '../core/authz.ts';
import { type BusMessage, changeMessage, subscribeAll, type Topic } from '../core/bus.ts';
import { badRequest, conflict, notFound, unavailable } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import { type Ctx, defineOp, type OpWatch } from '../core/op.ts';
import { schema } from '../db/client.ts';
import type { CompilationClipRow } from '../db/schema.ts';
import { env, storageConfigured } from '../env.ts';
import { type ClipSource, compilationMessage, resolveClipSources } from '../media/compilations.ts';
import { enqueueJob, toJob, withJobEstimates } from '../media/jobs.ts';
import {
  compilationKeyFor,
  deleteObject,
  headObject,
  PLAYBACK_URL_TTL_SEC,
  presignPlayback,
  presignUpload,
  requireStorage,
} from '../media/s3.ts';
import { deleteEvent, insertEvent, publishEvents } from './events.ts';
import { toCompilation, userRefs } from './map.ts';
import { publishSession } from './sessions.ts';

const { compilations, events, jobs, sessions } = schema;
type Row = typeof compilations.$inferSelect;
type EventRow = typeof events.$inferSelect;

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
  const estimates = await buildEstimates(ctx, rows);
  const expiresAt = new Date(Date.now() + PLAYBACK_URL_TTL_SEC * 1000).toISOString();
  return Promise.all(
    rows.map(async (r) => {
      const c = { ...toCompilation(r, users, titles), ...estimates.get(r.id) };
      if (r.status !== 'ready' || !r.objectKey || !storageConfigured) return c;
      return {
        ...c,
        url: await presignPlayback(r.objectKey, `${r.title}.mp4`),
        urlExpiresAt: expiresAt,
      };
    }),
  );
}

/** What a compilation waiting for the import helper says while queued. */
const localProgress = (id: string) =>
  `Waiting for a local build: run autologger-import compile ${id}`;

/** Clip length as m:ss (h:mm:ss from an hour), for the event message. */
function clipLength(sec: number): string {
  const t = Math.round(sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const ss = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * Log one "Compilation" event per clip at its startSec in the clip's session (the events.create
 * path: recorded in this op's change group, published to each session). Returns the event ids in
 * clip order.
 */
async function logClipEvents(
  ctx: Ctx,
  title: string,
  clips: { sessionId: string; startSec: number; endSec: number; label?: string }[],
): Promise<string[]> {
  const ids: string[] = [];
  const bySession = new Map<string, { session: SessionRow; rows: EventRow[] }>();
  for (const [i, c] of clips.entries()) {
    let s = bySession.get(c.sessionId);
    if (!s) {
      const { session } = await requireSession(ctx, c.sessionId, 'write', 'share');
      s = { session, rows: [] };
      bySession.set(c.sessionId, s);
    }
    const row = await insertEvent(ctx, s.session, {
      category: 'Compilation',
      message: `Compilation "${title}" · clip ${i + 1}${c.label ? `: ${c.label}` : ''} (${clipLength(c.endSec - c.startSec)})`,
      atSec: c.startSec,
    });
    s.rows.push(row);
    ids.push(row.id);
  }
  for (const { session, rows } of bySession.values()) await publishEvents(ctx, session, rows);
  return ids;
}

/** Delete the clip events of a compilation that still exist (each delete recorded, undoable). */
async function deleteClipEvents(ctx: Ctx, clips: CompilationClipRow[]): Promise<void> {
  const ids = clips.flatMap((c) => (c.eventId ? [c.eventId] : []));
  if (!ids.length) return;
  const rows = await ctx.db.select().from(events).where(inArray(events.id, ids));
  const bySession = new Map<string, EventRow[]>();
  for (const r of rows) bySession.set(r.sessionId, [...(bySession.get(r.sessionId) ?? []), r]);
  for (const [sessionId, list] of bySession) {
    const { session } = await requireSession(ctx, sessionId, 'write', 'share');
    for (const row of list) await deleteEvent(ctx, session, row);
    await publishSession(ctx, session.id);
  }
}

/**
 * queuePosition / etaSec of unfinished compilations, from their queued or running compile job
 * (jobs.list's estimates). One indexed query (jobs_show) plus the estimate's own.
 */
async function buildEstimates(
  ctx: Ctx,
  rows: Row[],
): Promise<Map<string, Pick<Compilation, 'queuePosition' | 'etaSec'>>> {
  const out = new Map<string, Pick<Compilation, 'queuePosition' | 'etaSec'>>();
  const open = rows.filter((r) => r.status === 'queued' || r.status === 'running');
  if (!open.length) return out;
  const jobRows = await ctx.db
    .select()
    .from(jobs)
    .where(
      and(
        inArray(jobs.showId, [...new Set(open.map((r) => r.showId))]),
        eq(jobs.kind, 'compile'),
        inArray(jobs.status, ['queued', 'running']),
        inArray(
          sql`${jobs.payload}->>'compilationId'`,
          open.map((r) => r.id),
        ),
      ),
    );
  for (const j of await withJobEstimates(ctx.db, jobRows.map(toJob))) {
    if (!j.compilationId) continue;
    out.set(j.compilationId, {
      ...(j.queuePosition !== undefined ? { queuePosition: j.queuePosition } : {}),
      ...(j.etaSec !== undefined ? { etaSec: j.etaSec } : {}),
    });
  }
  return out;
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

/**
 * The clips' YouTube sources, after checking the server can build videos at all; any clip that
 * cannot be compiled (not from YouTube, outside the video, not in the show) is a bad_request.
 */
async function requireCompilable(
  ctx: Ctx,
  clips: { sessionId: string; startSec: number; endSec: number }[],
  showId: string,
  buildLocally = false,
) {
  // A local build downloads on the user's computer: the server only stores the result.
  if (!buildLocally && !env.youtubeEnabled)
    throw unavailable(
      'YouTube downloads are disabled on this server (YOUTUBE_IMPORT). Create the compilation with buildLocally: true and build it with the local import helper instead.',
    );
  requireStorage();
  const sources = await resolveClipSources(ctx.db, clips, showId, { allowPrivate: buildLocally });
  const problems = sources.flatMap((s, i) =>
    'error' in s ? [`clip ${i + 1} (sessionId ${clips[i]!.sessionId}): ${s.error}`] : [],
  );
  if (problems.length)
    throw badRequest(
      `${problems.length === 1 ? 'This clip cannot' : `${problems.length} clips cannot`} be compiled: ${problems.slice(0, 20).join('; ')}${problems.length > 20 ? `; and ${problems.length - 20} more` : ''}. Only sessions imported from YouTube, with ranges inside the video, can be compiled.`,
    );
  return sources;
}

defineOp({
  name: 'compilations.create',
  description:
    'Build one MP4 video from ranges of a show\'s sessions that were imported from YouTube (sessions_get: sourceKind "youtube" with a sourceUrl; media_importYoutube / media_importPlaylist). showId from shows_list; needs write access to the show. clips: 1–100 ranges in play order, each {sessionId, startSec, endSec, label?} in SECONDS FROM THE SESSION START — the same @seconds as transcript_text, search hits and topics — each 1 s to 20 min long, together at most 3 hours. Every session must belong to this show and its range must lie within the session\'s stored YouTube audio; otherwise the call fails with bad_request listing the offending clips (e.g. "clip 2 (sessionId …): the session was not imported from YouTube") and nothing is created. Sessions recorded or uploaded in the app have no video and cannot be compiled. The server then downloads just those sections of the YouTube videos (≤720p), re-encodes them to one H.264/AAC MP4 (1280×720, 30 fps) and stores it; this runs in the background and takes roughly a few seconds per clip-minute plus download time. Returns the Compilation with status "queued". Wait for it with compilations_get {compilationId, waitSec: 55} in a loop until status is "ready" (then url is a presigned download link valid about 1 hour — call compilations_get again for a fresh one, do not store it) or "failed" (error says why; compilations_retry builds it again when the cause was temporary). progress reads like "clip 3/12" meanwhile. Users see and play compilations in the web app\'s Compilations page. Side effect: unless logEvents is false, it also logs one event per clip in the clip\'s session — category "Compilation" (a free label, grey marker), at the clip\'s startSec, message like `Compilation "Best bits" · clip 3: label (0:42)` (clip length) — so operators and agents see which moments were already clipped (events_list; each clip\'s eventId in the result). These events are in the change log as one group with this call: changes_revertGroup on it removes them (the compilation itself stays; delete it with compilations_delete). compilations_retry does not log them again. Pass logEvents: false to skip them (e.g. for a throwaway draft). buildLocally: true (default false) builds the video on the user\'s own computer with the AutoLogger import helper instead of the server — use it when the server cannot download the videos: a clip error says the video is private (imported with the helper), or the server\'s compile job failed with YouTube\'s bot check. The clips are checked the same way (private videos allowed) but no compile job is queued: the compilation stays "queued" (progress "Waiting for a local build…") until the user runs `autologger-import compile <compilationId>` (docs/importer.md), which downloads the sections with their browser cookies, encodes the same 720p H.264/AAC MP4 and uploads it (compilations_createUpload, compilations_completeUpload); then it is "ready" like any other. Tell the user the command to run.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { showId, title, clips, logEvents, buildLocally }) {
    await requireShow(ctx, showId, 'write');
    const sources = await requireCompilable(ctx, clips, showId, buildLocally);
    const eventIds = logEvents ? await logClipEvents(ctx, title, clips) : [];
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
            ...(eventIds[i] ? { eventId: eventIds[i] } : {}),
          };
        }),
        durationSec: clips.reduce((n, c) => n + (c.endSec - c.startSec), 0),
        progress: buildLocally ? localProgress(id) : 'Queued',
        buildLocally,
        createdBy: ctx.actor.user.id,
      })
      .returning();
    if (buildLocally) {
      ctx.publish(`show:${showId}`, compilationMessage(showId, id, 'queued'));
      const [out] = await toEntities(ctx, [row!]);
      return out!;
    }
    const job = await enqueueJob(ctx.db, {
      kind: 'compile',
      sessionId: null,
      showId,
      actorId: ctx.actor.user.id,
      payload: { compilationId: id },
    });
    ctx.publish(`show:${showId}`, changeMessage('job', 'upsert', job.id, toJob(job)));
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
    'One video compilation (compilationId from compilations_create or compilations_list): status "queued" | "running" | "ready" | "failed", progress while working (e.g. "clip 3/12"), error when failed, the clips (session seconds), durationSec (seconds; the sum of the clip lengths until ready, then the measured video length) and sizeBytes. While it waits for the worker it includes queuePosition (queued only: how many jobs the worker starts before this build, 0 = next) and etaSec (queued or running: rough seconds until ready, from recent builds\' time per clip second; absent without history) — use etaSec to choose waitSec and how long to keep waiting, not as a deadline. When ready it includes url: a presigned link to the MP4 valid about 1 hour (urlExpiresAt) — fetch a fresh one with this call rather than storing it. To wait for a compilation, pass waitSec (1–55; longer waits outlast the ~60 s request timeout of MCP clients): while it is queued or running the call holds until its status changes (or it is deleted), then returns it — or after waitSec seconds unchanged. Call it again in a loop until ready or failed; no separate sleep is needed. Needs read access to the show.',
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
  description: `The video compilations of a show (showId from shows_list), newest first (at most ${LIST_MAX}), each as in compilations_get: status, progress, clips, durationSec and, when ready, a url valid about 1 hour. Queued compilations include queuePosition (jobs the worker starts before this build, 0 = next) and queued or running ones etaSec (rough seconds until ready, from recent builds' time per clip second; absent without history) — both also in compilations_get. The build itself is a compile job in jobs_list with showId. Needs read access to the show.`,
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
    'Delete a video compilation and its stored MP4 (compilationId from compilations_list). A compilation still being built is cancelled. Deleting the video cannot be undone (the sessions and their media are not affected; create it again with compilations_create). It also deletes the "Compilation" events compilations_create logged in the source sessions (those still there; events moved or edited since are deleted too). Those event deletes are in the change log as one group: changes_revertGroup on it restores the events, not the video. Needs write access to the show. Returns {ok: true}.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { compilationId }) {
    const row = await loadCompilation(ctx, compilationId, 'write');
    await deleteClipEvents(ctx, row.clips);
    await ctx.db.delete(compilations).where(eq(compilations.id, row.id));
    // A queued build has nothing left to do; a running one finds the row gone and cleans up.
    // Its failures (and this cancellation) are dismissed: nothing is left to retry.
    const now = new Date();
    const ofThis = and(
      eq(jobs.kind, 'compile'),
      sql`${jobs.payload}->>'compilationId' = ${row.id}`,
    );
    await ctx.db
      .update(jobs)
      .set({ status: 'failed', error: 'Compilation deleted.', dismissedAt: now, updatedAt: now })
      .where(and(ofThis, eq(jobs.status, 'queued')));
    await ctx.db
      .update(jobs)
      .set({ dismissedAt: now })
      .where(and(ofThis, eq(jobs.status, 'failed'), isNull(jobs.dismissedAt)));
    ctx.publish(`show:${row.showId}`, { type: 'invalidate', entity: 'job' });
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

defineOp({
  name: 'compilations.retry',
  description:
    'Build a failed video compilation again (compilationId from compilations_list or compilations_get with status "failed"; jobs_list with showId also lists its failed compile job, with compilationId). Use it when the error looks temporary (a YouTube download or network error, the worker restarting) instead of deleting and re-creating the compilation: it keeps the same compilationId, title and clips. The clips are checked again first, like compilations_create: if a session was deleted or re-imported without its YouTube video, the call fails with bad_request naming the clips and nothing changes — create a new compilation without them instead. Only a compilation with status "failed" can be retried (conflict otherwise; a queued or running one is already being built, a ready one has its video). Resets it to status "queued" (error cleared) and queues a new compile job; then wait with compilations_get {compilationId, waitSec: 55} as after compilations_create. Needs write access to the show. Returns the Compilation.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { compilationId }) {
    const found = await loadCompilation(ctx, compilationId, 'write');
    if (found.status !== 'failed')
      throw conflict(
        `Only a failed compilation can be retried; this one is ${found.status === 'ready' ? 'ready' : 'already being built'}.`,
      );
    await requireCompilable(ctx, found.clips, found.showId);
    // Conditional on still being failed, so two concurrent retries queue one build.
    const [row] = await ctx.db
      .update(compilations)
      .set({ status: 'queued', progress: 'Queued', error: null, updatedAt: new Date() })
      .where(and(eq(compilations.id, found.id), eq(compilations.status, 'failed')))
      .returning();
    if (!row) throw conflict('This compilation is already being built again.');
    // The new job supersedes the failed one in the web jobs dialog (same compilationId).
    const job = await enqueueJob(ctx.db, {
      kind: 'compile',
      sessionId: null,
      showId: row.showId,
      actorId: ctx.actor.user.id,
      payload: { compilationId: row.id },
    });
    ctx.publish(`show:${row.showId}`, changeMessage('job', 'upsert', job.id, toJob(job)));
    ctx.publish(`show:${row.showId}`, compilationMessage(row.showId, row.id, 'queued'));
    const [out] = await toEntities(ctx, [row]);
    return out!;
  },
});

/** A local-build compilation, for its upload ops; anything else is a conflict. */
async function loadLocalBuild(ctx: Ctx, compilationId: string) {
  requireStorage();
  const row = await loadCompilation(ctx, compilationId, 'write');
  if (!row.buildLocally)
    throw conflict(
      'This compilation is built by the server. Create one with buildLocally: true to build it with the import helper.',
    );
  return row;
}

defineOp({
  name: 'compilations.createUpload',
  description:
    'For a compilation created with buildLocally: true (compilationId from compilations_create or compilations_list): what to build and where to upload it. Normally the AutoLogger import helper calls this (`autologger-import compile <compilationId>`, docs/importer.md); agents rarely need it. Returns {compilation, sources, uploadUrl, headers}: sources has one entry per clip in play order, {sessionId, url (the YouTube video), fromSec, toSec} in VIDEO seconds (session seconds minus where the video starts in the session); uploadUrl is a presigned PUT for the MP4 (send exactly headers), valid 15 minutes — call this again for a fresh one after a long build. Writes nothing. Fails with bad_request when a clip cannot be built any more (session deleted or re-imported), conflict for a server-built or already ready compilation. Needs write access to the show.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { compilationId }) {
    const row = await loadLocalBuild(ctx, compilationId);
    if (row.status === 'ready') throw conflict('This compilation is already ready.');
    const sources = await requireCompilable(ctx, row.clips, row.showId, true);
    const key = compilationKeyFor(row.showId, row.id);
    const [compilation] = await toEntities(ctx, [row]);
    return {
      compilation: compilation!,
      sources: (sources as ClipSource[]).map((s) => ({
        sessionId: s.sessionId,
        url: s.url,
        fromSec: s.fromSec,
        toSec: s.toSec,
      })),
      uploadUrl: await presignUpload(key, 'video/mp4'),
      headers: { 'Content-Type': 'video/mp4' },
    };
  },
});

defineOp({
  name: 'compilations.completeUpload',
  description:
    'Finish a local build (buildLocally) once the MP4 was PUT to the uploadUrl of compilations_createUpload: checks the video arrived in storage and marks the compilation "ready" (url then plays or downloads it, as for server-built ones). durationSec: the video\'s measured length in seconds (default: the sum of the clip lengths). Calling it again for a ready compilation returns it unchanged. Fails with conflict when nothing was uploaded yet. Normally called by the import helper (`autologger-import compile`). Needs write access to the show.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { compilationId, durationSec }) {
    const found = await loadLocalBuild(ctx, compilationId);
    if (found.status === 'ready') return (await toEntities(ctx, [found]))[0]!;
    const key = compilationKeyFor(found.showId, found.id);
    const head = await headObject(key);
    if (!head || head.size === 0)
      throw conflict('The video has not arrived in storage yet. PUT the MP4 first.');
    const [row] = await ctx.db
      .update(compilations)
      .set({
        status: 'ready',
        progress: null,
        error: null,
        objectKey: key,
        sizeBytes: head.size,
        ...(durationSec ? { durationSec } : {}),
        updatedAt: new Date(),
      })
      .where(eq(compilations.id, found.id))
      .returning();
    ctx.publish(`show:${row!.showId}`, compilationMessage(row!.showId, row!.id, 'ready'));
    return (await toEntities(ctx, [row!]))[0]!;
  },
});
