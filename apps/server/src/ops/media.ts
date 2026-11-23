// Media: audio segments (recorded / uploaded / YouTube), playback URLs, transcription jobs.
//
// Upload flow: media.createUpload (row status 'uploading' + presigned PUT) → browser PUTs the
// bytes straight to S3 → media.completeUpload (verifies the object, status 'ready', enqueues
// `transcribe`). The worker (src/worker) does the Deepgram and yt-dlp work.

import type { AudioSegment, Job, PlaylistImport, YoutubeAccess } from '@autologger/contract';
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { requireSession, requireShow, requireTeamRole } from '../core/authz.ts';
import { type BusMessage, changeMessage, subscribeAll, type Topic } from '../core/bus.ts';
import { badRequest, conflict, notFound, unavailable } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import { type Actor, type Ctx, defineOp, type OpWatch } from '../core/op.ts';
import { db, schema } from '../db/client.ts';
import { env, storageConfigured, transcriptionConfigured } from '../env.ts';
import { PermanentError } from '../media/deepgram.ts';
import { enqueueJob, type JobRow, jobTopic, toJob, withJobEstimates } from '../media/jobs.ts';
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
import { activeTranscribeJob, lockSession, nextSegmentSlot, STORED } from '../media/segments.ts';
import {
  isYoutubeUrl,
  listPlaylist,
  type Playlist,
  type PlaylistEntry,
  videoDuration,
  watchUrl,
  YoutubeAuthError,
  youtubePlaylistId,
  youtubeVideoId,
} from '../media/youtube.ts';
import {
  type ParsedCookies,
  parseYoutubeCookies,
  rotatedCookies,
  SIGNED_OUT_MESSAGE,
  youtubeCookiesForShow,
} from '../media/youtubeCookies.ts';
import { toAudioSegment } from './map.ts';
import { publishSession, reserveEpisodes } from './sessions.ts';

const { audioSegments, compilations, jobs, sessions, teamYoutubeCookies } = schema;

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
  const topic = jobTopic(job);
  if (topic) ctx.publish(topic, changeMessage('job', 'upsert', job.id, toJob(job)));
}

/** Waveform peaks for a newly stored segment (runs whether or not Deepgram is configured). */
async function enqueueWaveform(ctx: Ctx, seg: SegmentRow): Promise<JobRow> {
  const job = await enqueueJob(ctx.db, {
    kind: 'waveform',
    sessionId: seg.sessionId,
    actorId: ctx.actor.user.id,
    payload: { segmentId: seg.id },
  });
  publishJob(ctx, job);
  return job;
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
    'Audio segments of a session in order, with their session start time, duration, transcription status (uploading, ready, transcribing, transcribed, failed) and hasWaveform (waveform peaks computed).',
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
    'Start uploading one audio segment of a session (sessionId from sessions_list; needs write access). Returns {segment, uploadUrl, headers}: a presigned PUT URL valid for 15 minutes; PUT the bytes with exactly those headers, then call media_completeUpload with segment.id (that queues transcription and the waveform, as for any upload). mimeType must be audio/* or video/*. origin "recorded" (a recording chunk) or "file" (a local file) is what the web app uses. origin "youtube" with youtube {url, title?, uploadDate?, private?} is for audio the client downloaded from YouTube itself — normally the AutoLogger import helper (autologger-import, docs/importer.md), which does all of this for you; use it when the server cannot download a video (media_importYoutube / media_importPlaylist fail with YouTube\'s bot check or a sign-in for a private, members-only or age-restricted video). url is the video\'s YouTube URL; title becomes the segment fileName; uploadDate (YYYY-MM-DD) replaces the session\'s episodeDate while it is still its default (the day the session was created); private: true marks audio the server could never download, so server-built compilations refuse it (compilations_create buildLocally builds them on the user\'s computer). A YouTube upload starts at session second 0 (startSec default) and replaces an unfinished (status "uploading") YouTube upload of the same session; once completed the session keeps the video as its source (sourceKind "youtube", sourceUrl). Media writes are not in the change log.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { sessionId, mimeType, origin, fileName, startSec, sizeBytes, youtube }) {
    requireStorage();
    const base = mimeType.split(';')[0]!.trim().toLowerCase();
    if (!base.startsWith('audio/') && !base.startsWith('video/')) {
      throw badRequest('Only audio or video files can be uploaded.');
    }
    const videoId = youtube ? youtubeVideoId(youtube.url) : null;
    if (youtube && !videoId)
      throw badRequest(
        'youtube.url is not a YouTube video URL (youtube.com/watch?v=… or youtu.be/…).',
      );
    const { session } = await requireSession(ctx, sessionId, 'write');
    await lockSession(ctx.db, sessionId);
    if (youtube) {
      await dropUnfinishedYoutubeUploads(ctx, sessionId);
      await applyUploadDate(ctx, session, youtube.uploadDate);
    }
    const slot = await nextSegmentSlot(ctx.db, sessionId);
    const id = newId('aud');
    const objectKey = objectKeyFor(sessionId, id, extForMime(mimeType, fileName));
    const [row] = await ctx.db
      .insert(audioSegments)
      .values({
        id,
        sessionId,
        ordinal: slot.ordinal,
        startSec: startSec ?? (youtube ? 0 : slot.endSec),
        mimeType,
        origin,
        fileName: youtube?.title ?? fileName ?? null,
        sourceUrl: videoId ? watchUrl(videoId) : null,
        sourcePrivate: youtube?.private ?? false,
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

/**
 * Delete a session's unfinished YouTube uploads (status uploading), so the import helper can
 * start over after an interrupted upload instead of leaving a dead segment behind.
 */
async function dropUnfinishedYoutubeUploads(ctx: Ctx, sessionId: string): Promise<void> {
  const stale = await ctx.db
    .delete(audioSegments)
    .where(
      and(
        eq(audioSegments.sessionId, sessionId),
        eq(audioSegments.origin, 'youtube'),
        eq(audioSegments.status, 'uploading'),
      ),
    )
    .returning();
  for (const r of stale)
    ctx.publish(`session:${sessionId}`, changeMessage('audio_segment', 'delete', r.id));
  if (stale.length && storageConfigured)
    ctx.afterCommit(async () => {
      for (const r of stale) await deleteObject(r.objectKey).catch(() => {});
    });
}

/** A YouTube upload date replaces the episode date only while it is the default (creation day). */
async function applyUploadDate(
  ctx: Ctx,
  session: { id: string; episodeDate: string | null; createdAt: Date },
  uploadDate: string | undefined,
): Promise<void> {
  const isDefault =
    !session.episodeDate || session.episodeDate === session.createdAt.toISOString().slice(0, 10);
  if (!uploadDate || !isDefault || uploadDate === session.episodeDate) return;
  await ctx.db
    .update(sessions)
    .set({ episodeDate: uploadDate, updatedAt: new Date() })
    .where(eq(sessions.id, session.id));
}

defineOp({
  name: 'media.completeUpload',
  description:
    'Finish an upload started with media_createUpload once the PUT succeeded (segmentId = segment.id from media_createUpload; durationSec = the audio length in seconds, when known). Marks the segment ready and queues its transcription (when Deepgram is configured) and waveform; wait for the transcript with jobs_list (kinds ["transcribe"]). transcribe: false (default true) only stores the audio and draws its waveform, without transcribing it (transcribe later with media_retranscribe), like media_importYoutube transcribe: false. A YouTube upload (origin "youtube") also makes the video the session\'s source (sourceKind "youtube", sourceUrl), so it can be compiled. Fails with conflict when the bytes have not arrived in storage (PUT first). Calling it again for a finished segment changes nothing (it only fills in a missing durationSec).',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { segmentId, durationSec, transcribe }) {
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
    if (row.origin === 'youtube' && row.sourceUrl) {
      // As the worker's import: the latest YouTube audio is the session's source.
      await ctx.db
        .update(sessions)
        .set({ sourceKind: 'youtube', sourceUrl: row.sourceUrl, updatedAt: new Date() })
        .where(eq(sessions.id, session.id));
    } else if (!session.sourceKind) {
      await ctx.db
        .update(sessions)
        .set({ sourceKind: row.origin, updatedAt: new Date() })
        .where(eq(sessions.id, session.id));
    }
    if (transcriptionConfigured && transcribe) await enqueueTranscribe(ctx, after!);
    await enqueueWaveform(ctx, after!);
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
  name: 'media.waveform',
  description:
    "Waveform peaks of a session's audio for drawing the timeline: one entry per audio segment whose peaks are computed (the worker's waveform job runs after an upload or import; segments without peaks yet are left out, and media.list shows hasWaveform). Each entry has the segment's session startSec and a presigned GET url (valid 1 hour) to a JSON object {version: 1, peaksPerSec, durationSec, peaks}: peaks is base64 of one byte per 1/peaksPerSec seconds of the segment (max |sample| scaled to 0–255), and peak i sits at session second startSec + i / peaksPerSec.",
  kind: 'read',
  surfaces: ['web'],
  async run(ctx, { sessionId }) {
    await requireSession(ctx, sessionId, 'read');
    requireStorage();
    const rows = await ctx.db
      .select()
      .from(audioSegments)
      .where(and(eq(audioSegments.sessionId, sessionId), isNotNull(audioSegments.peaksKey)))
      .orderBy(asc(audioSegments.ordinal));
    const expiresAt = new Date(Date.now() + PLAYBACK_URL_TTL_SEC * 1000).toISOString();
    return Promise.all(
      rows.map(async (r) => ({
        segmentId: r.id,
        startSec: r.startSec,
        durationSec: r.durationSec,
        url: await presignPlayback(r.peaksKey!),
        expiresAt,
      })),
    );
  },
});

defineOp({
  name: 'media.importYoutube',
  description:
    'Import the audio of one YouTube video into an existing session. Runs in the background: the worker downloads the audio, stores it and transcribes it. If the session\'s episodeDate is still its default (the day it was created), it is set to the video\'s upload date. Playlist URLs are rejected: use media.importPlaylist to import a whole playlist into a show. Returns the job; wait for it with jobs.list (waitSec; kinds ["youtube_import","transcribe"] leaves out the cosmetic waveform job queued after the download). transcribe: false (default true) only downloads the audio and draws its waveform, without transcribing it (transcribe later with media_retranscribe). Before queuing it reads the video length from YouTube (a few seconds, no download) so sessions.get transcriptJob.etaSec can include the transcription time; if that read is slow or fails the import is still queued, with a download-only estimate. That read also checks access: if YouTube demands a sign-in (its bot check on this server, or a private, members-only or age-restricted video) the call fails with bad_request explaining it and queues nothing. Retrying will not help: the team needs a (fresh) YouTube sign-in. Check media_youtubeAccess, then ask the user to sign in to YouTube in a browser and, once they agree to send its cookies, set them with media_setYoutubeCookies (team owner/admin) and retry. Only if they decline, tell the user, who can instead import the video from their own computer with the AutoLogger import helper (`autologger-import video <url> --session <sessionId>`, docs/importer.md), which also reads private videos.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  // Validate and authorize, then read the video length, before the op's transaction opens.
  async prepare(actor, { sessionId, url }): Promise<number | null> {
    requireYoutube();
    if (!isYoutubeUrl(url))
      throw badRequest('That is not a YouTube URL (youtube.com or youtu.be).');
    if (youtubePlaylistId(url) && !youtubeVideoId(url))
      throw badRequest(
        'That is a playlist URL. Use media.importPlaylist with the showId to create one session per video.',
      );
    const { show } = await db.transaction((tx) =>
      requireSession(prepareCtx(actor, tx, 'media.importYoutube'), sessionId, 'write'),
    );
    return probeVideo(url, show.id, 'Nothing was queued.');
  },
  async run(ctx, { sessionId, url, transcribe }, durationSec) {
    await requireSession(ctx, sessionId, 'write');
    const job = await enqueueJob(ctx.db, {
      kind: 'youtube_import',
      sessionId,
      actorId: ctx.actor.user.id,
      // durationSec lets sessions.get estimate the transcription that follows the download.
      payload: {
        url,
        ...(durationSec ? { durationSec } : {}),
        ...(transcribe ? {} : { transcribe: false }),
      },
    });
    publishJob(ctx, job);
    return toJob(job);
  },
});

/** Concurrent yt-dlp video-length reads allowed per server process; beyond it, length unknown. */
const MAX_VIDEO_PROBES = 4;
const VIDEO_PROBE_TIMEOUT_MS = 15_000;
let videoProbes = 0;

/**
 * Read a video's length (seconds; null when unknown) with the same yt-dlp format selection and
 * access settings as the worker's download, without downloading it. It doubles as a probe: when
 * YouTube demands a sign-in (bot check, private or age-restricted video) the op fails with
 * bad_request instead of queuing a job that cannot succeed. Anything else (yt-dlp missing on
 * this host, timeout, too many probes at once) never blocks the import: the length is just null.
 */
async function probeVideo(
  url: string,
  showId: string,
  nothingDone: string,
): Promise<number | null> {
  if (videoProbes >= MAX_VIDEO_PROBES) return null;
  videoProbes++;
  try {
    return await videoDuration(
      env.ytDlpPath,
      url,
      VIDEO_PROBE_TIMEOUT_MS,
      await youtubeCookiesForShow(showId),
    );
  } catch (e) {
    if (e instanceof YoutubeAuthError) throw badRequest(`${e.message} ${nothingDone}`);
    console.warn(`video length of ${url}: ${(e as Error).message}`);
    return null;
  } finally {
    videoProbes--;
  }
}

/** A Ctx for authorizing in `prepare`: reads only, outside the op's transaction. */
function prepareCtx(actor: Actor, tx: Ctx['db'], op: Ctx['op']): Ctx {
  return {
    actor,
    db: tx,
    op,
    groupId: '',
    record: () => Promise.reject(new Error('read-only')),
    recordMany: () => Promise.reject(new Error('read-only')),
    publish: () => {},
    afterCommit: () => {},
  };
}

/** A playlist to import: read by the server's yt-dlp, or listed by the client (`local`). */
type ImportList = {
  title: string | null;
  entries: (PlaylistEntry & { uploadDate?: string })[];
  local?: boolean;
};

/** The client's own video list (local import helper) as an import list; no yt-dlp here. */
function clientList(
  videos: { url: string; title: string; durationSec?: number | null; uploadDate?: string }[],
): ImportList {
  requireStorage();
  const entries = videos.map((v, i) => {
    const videoId = youtubeVideoId(v.url);
    if (!videoId) throw badRequest(`videos[${i}].url is not a YouTube video URL.`);
    return {
      videoId,
      title: v.title,
      durationSec: v.durationSec ?? null,
      available: true,
      ...(v.uploadDate ? { uploadDate: v.uploadDate } : {}),
    };
  });
  return { title: null, entries, local: true };
}

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
    'Import a whole YouTube playlist into a show in one call: one new session per video, each with a queued youtube_import job (download + transcription run in the background; poll jobs.list with showId, status ["queued","running"] and kinds ["youtube_import","transcribe"] until empty; waveform jobs that follow are cosmetic). showId comes from shows.list (needs write access). url is a YouTube URL with a list= parameter. Videos already in the show (a session whose sourceUrl is the same video, or one with a queued/running import of it) and private/deleted videos are skipped, so calling it again later imports only new videos. Session titles come from titleTemplate (placeholders {title} = video title, {episode} = episode number; default "{title}"); episode numbers are taken from the show counter in import order. order "playlist" (default) keeps the playlist order; "reverse" imports the last video first (use it when the playlist lists newest first, so episode 1 is the oldest). episodeDate is set to each video\'s YouTube upload date when its import job runs. Up to 200 videos per playlist. keyTerms: per-episode transcription key terms (guest names, jargon) as {videoId: [terms]} (videoId as in the dryRun created list; same limits per video as sessions_create keyTerms): each new session is created with them before its job is queued, so its first transcription already uses them — prefer this to sessions_update after the call, which races the transcription (a short video can be transcribed seconds after the call). Videos without an entry get no session terms (the show\'s key terms still apply); entries for skipped videos are ignored (their sessions already exist: use sessions_update, then media_retranscribe); a videoId not in the playlist fails the call with bad_request. transcribe: false (default true) only downloads each video\'s audio and draws its waveform, without transcribing (transcribe later with media_retranscribe per session); it applies to server downloads (url); for videos the import helper uploads, media_completeUpload takes transcribe: false instead (helper option --no-transcribe). Agents cannot delete sessions (deleting is web-only), so for an unfamiliar playlist call it first with dryRun: true (then call it again with the same arguments plus keyTerms, if any): it returns the same created/skipped lists (dryRun true, sessionId and jobId null) without writing anything. A session whose import job fails stays in the show (and is skipped on re-runs): retry it with media.importYoutube on that sessionId. Returns {playlistTitle, dryRun, created [{sessionId, title, episode, videoId, durationSec, jobId}], skipped [{videoId, title, reason, sessionId}]}; durationSec is in seconds (null if YouTube did not say). Fails with unavailable when the server is busy reading other playlists: retry shortly. Before creating sessions (not on dryRun) it checks that the first video can be downloaded (a few seconds, no download): if YouTube demands a sign-in (its bot check on this server, or a private/members-only/age-restricted video) the call fails with bad_request explaining it and creates no sessions. Retrying will not help: the team needs a (fresh) YouTube sign-in. Check media_youtubeAccess, then ask the user to sign in to YouTube in a browser and, once they agree to send its cookies, set them with media_setYoutubeCookies (team owner/admin) and retry. Only if they decline, tell the user, who can import the playlist from their own computer instead with the AutoLogger import helper (`autologger-import playlist <url> --show <showId>`, docs/importer.md) — also the only way to import a private playlist. The helper calls this op with videos instead of url: a list it read itself, each {url (YouTube video URL), title, durationSec?, uploadDate? (YYYY-MM-DD)}, in playlist order. Then sessions are created the same way (same skipping, titles, episodes, order, dryRun; episodeDate = uploadDate, else today) but nothing is downloaded or queued (jobId null; playlistTitle null): the client uploads each video\'s audio with media_createUpload origin "youtube" and media_completeUpload.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  // Authorize, then run yt-dlp, before the op's transaction opens.
  async prepare(actor, { showId, url, videos, order, dryRun }): Promise<ImportList> {
    await db.transaction((tx) =>
      requireShow(prepareCtx(actor, tx, 'media.importPlaylist'), showId, 'write'),
    );
    if (videos) return clientList(videos);
    requireYoutube();
    const listId = youtubePlaylistId(url!);
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
        {
          maxEntries: MAX_PLAYLIST_VIDEOS + 1,
          timeoutMs: PLAYLIST_TIMEOUT_MS,
          cookies: await youtubeCookiesForShow(showId),
        },
      );
    } catch (e) {
      console.warn(`playlist ${listId}: ${(e as Error).message}`);
      if (e instanceof YoutubeAuthError) throw badRequest(`${e.message} No sessions were created.`);
      if (e instanceof PermanentError) throw unavailable((e as Error).message);
      throw unavailable(
        'Could not read the playlist. Check that it exists and is public or unlisted, then retry.',
      );
    } finally {
      playlistResolutions--;
    }
    if (playlist.entries.length > MAX_PLAYLIST_VIDEOS)
      throw badRequest(`The playlist has more than ${MAX_PLAYLIST_VIDEOS} videos.`);
    if (playlist.entries.length === 0) throw badRequest('The playlist is empty or not public.');
    // Listing works without a sign-in even when downloads don't: probe the first video before
    // creating sessions that could only fail (agents cannot delete them).
    if (!dryRun) {
      const first = (order === 'reverse' ? playlist.entries.toReversed() : playlist.entries).find(
        (e) => e.available,
      );
      if (first) await probeVideo(watchUrl(first.videoId), showId, 'No sessions were created.');
    }
    return playlist;
  },
  async run(
    ctx,
    { showId, order, titleTemplate, dryRun, transcribe, keyTerms },
    playlist,
  ): Promise<PlaylistImport> {
    const local = Boolean(playlist.local);
    // A key for a video that isn't in the list is most likely a typo: say so, create nothing.
    const listed = new Set(playlist.entries.map((e) => e.videoId));
    const stray = Object.keys(keyTerms ?? {}).filter((v) => !listed.has(v));
    if (stray.length)
      throw badRequest(
        `keyTerms names videos that are not in the playlist: ${stray.slice(0, 10).join(', ')}. Use the videoId values of a dryRun.`,
      );
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
          episodeDate: e.uploadDate ?? today,
          frameRate: show.defaultFrameRate,
          sourceKind: 'youtube',
          sourceUrl: videoUrl,
          // Set with the session, before its job exists, so its first transcription uses them.
          keyTerms: [...new Set(keyTerms?.[e.videoId] ?? [])],
          createdBy: ctx.actor.user.id,
        });
        item.sessionId = sessionId;
        // The import helper uploads the audio itself (media.createUpload origin youtube).
        if (local) continue;
        const job = await enqueueJob(
          ctx.db,
          {
            kind: 'youtube_import',
            sessionId,
            actorId: ctx.actor.user.id,
            payload: {
              url: videoUrl,
              // Lets sessions.get estimate the transcription that follows the download.
              ...(e.durationSec ? { durationSec: e.durationSec } : {}),
              ...(transcribe ? {} : { transcribe: false }),
            },
          },
          { at: new Date(base + i) },
        );
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
  name: 'media.rewaveform',
  description:
    "Compute the waveform peaks of stored audio again, e.g. after a failed waveform job (the worker's startup backfill doesn't retry those). With segmentId, that segment (even if it has peaks); without, every stored segment of the session that has no peaks. A segment whose waveform job is already queued or running keeps that job. Not a content change (nothing to undo). Returns the jobs.",
  kind: 'write',
  surfaces: ['web'],
  async run(ctx, { sessionId, segmentId }) {
    requireStorage();
    await requireSession(ctx, sessionId, 'write');
    const rows = await ctx.db
      .select()
      .from(audioSegments)
      .where(
        segmentId
          ? and(eq(audioSegments.sessionId, sessionId), eq(audioSegments.id, segmentId))
          : and(eq(audioSegments.sessionId, sessionId), isNull(audioSegments.peaksKey)),
      )
      .orderBy(asc(audioSegments.ordinal));
    if (segmentId && rows.length === 0) throw notFound('Audio segment');
    const stored = rows.filter((r) => (STORED as readonly string[]).includes(r.status));
    if (segmentId && stored.length === 0) throw conflict('This segment is still uploading.');
    const out: JobRow[] = [];
    for (const seg of stored)
      out.push(
        (await activeTranscribeJob(ctx.db, seg.id, 'waveform')) ??
          (await enqueueWaveform(ctx, seg)),
      );
    return out.map(toJob);
  },
});

defineOp({
  name: 'media.delete',
  description:
    'Delete one audio segment, its stored audio, waveform and transcript. Its queued transcribe/waveform jobs are cancelled (failed, "Audio segment deleted.") and they and its earlier failed jobs are dismissed, so jobs.list hideDismissed leaves them out.',
  kind: 'write',
  surfaces: ['web'],
  async run(ctx, { segmentId }) {
    const { row, session } = await loadSegment(ctx, segmentId, 'write');
    // Transcript rows cascade with the segment.
    await ctx.db.delete(audioSegments).where(eq(audioSegments.id, segmentId));
    // The segment's jobs can't run or be retried any more: cancel the queued ones and dismiss
    // them and earlier failures, so they aren't reported as open failures (hideDismissed).
    // A running job's next attempt finds the segment gone and ends as done in the worker.
    const now = new Date();
    const segmentJobs = and(
      inArray(jobs.kind, ['transcribe', 'waveform']),
      eq(jobs.sessionId, session.id),
      sql`${jobs.payload}->>'segmentId' = ${segmentId}`,
    );
    await ctx.db
      .update(jobs)
      .set({ status: 'failed', error: 'Audio segment deleted.', dismissedAt: now, updatedAt: now })
      .where(and(segmentJobs, eq(jobs.status, 'queued')));
    await ctx.db
      .update(jobs)
      .set({ dismissedAt: now })
      .where(and(segmentJobs, eq(jobs.status, 'failed'), isNull(jobs.dismissedAt)));
    if (storageConfigured) {
      ctx.afterCommit(async () => {
        for (const key of [row.objectKey, row.peaksKey]) {
          if (!key) continue;
          try {
            await deleteObject(key);
          } catch (e) {
            console.warn(`could not delete object ${key}: ${(e as Error).message}`);
          }
        }
      });
    }
    ctx.publish(`session:${session.id}`, changeMessage('audio_segment', 'delete', segmentId));
    ctx.publish(`session:${session.id}`, { type: 'invalidate', entity: 'transcript_segment' });
    ctx.publish(`session:${session.id}`, { type: 'invalidate', entity: 'job' });
    await publishSession(ctx, session.id);
    return { deleted: true as const };
  },
});

/**
 * Long-poll for jobs.list. Starts listening on the realtime bus before the op's transaction (so
 * a change committed meanwhile isn't missed); `wait` then resolves when a listed unfinished job
 * changes status or is deleted, or a job is queued in one of their sessions (or, listing a show,
 * a show-level job such as a compile is queued in the show) — or on timeout or abort. Worker
 * updates reach the bus through Postgres NOTIFY on the shared LISTEN connection, so waiting holds
 * no database connection.
 */
function watchJobs(ms: number, showId: string | undefined, signal?: AbortSignal): OpWatch<Job[]> {
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
      const topics = new Set<Topic>(
        [...pending.values()].flatMap((j): Topic[] =>
          j.sessionId ? [`session:${j.sessionId}`] : [],
        ),
      );
      // Show-level jobs (compile) publish on the show's topic.
      if (showId && pending.size) topics.add(`show:${showId}`);
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
    'Background jobs (transcription, YouTube import, waveform, video compilation), newest first, with status, progress and errors. waveform jobs only draw the timeline waveform in the web app (cosmetic, run after everything else): when waiting for imports or transcripts, pass kinds ["youtube_import","transcribe"] or ignore them. Pass exactly one of sessionId (one session) or showId (every session of the show — each job then includes sessionId and sessionTitle, so one call answers "is the playlist import finished?"; it also lists the show\'s compile jobs, which have sessionId null and instead compilationId and compilationTitle (absent once the compilation was deleted) — the compilation itself is compilations_get; retry a failed compile job with compilations_retry {compilationId}). Transcribe and waveform jobs include segmentId, the audio segment they are for (media_list); retry a failed transcription of just that segment with media_retranscribe and that segmentId (without segmentId it redoes every segment and loses manual edits). youtube_import jobs include sourceUrl, the video URL being imported: retry a failed import with media_importYoutube with that url and the job sessionId. An import or compile job whose error starts "YouTube is blocking this server\'s downloads (bot check)" or "YouTube requires a signed-in account" failed at once without retries: the team needs a (fresh) YouTube sign-in (media_youtubeAccess shows its state; a team owner/admin sets it with media_setYoutubeCookies) or the video is private/age-restricted for that account, so retrying will not help until that is fixed; tell the user. Optional kinds filters to the given job kinds; optional status filters to the given states (e.g. ["queued","running"] for unfinished work; an empty result means nothing is pending); limit defaults to 100 (max 500). Queued jobs include queuePosition: how many jobs the worker will start before this one, 0 = next. It counts every runnable queued job on the server (all teams and shows; only the number is exposed); a job waiting to retry after a failure has no queuePosition until its retry time. startedAt is when the current attempt started (null while queued). Queued (with a queuePosition) and running jobs include etaSec: a rough estimate of seconds until the job finishes, from the median duration of the last 20 finished jobs of the same kind (transcriptions scaled by their audio length), the jobs ahead in the queue, the time left on running jobs and the total job slots of the workers currently running (compile jobs scaled by their total clip seconds); 0 on a running job means it is taking longer than usual. It is absent when there is no finished history to estimate from. Use it to choose waitSec, not as a deadline. To wait for jobs, pass waitSec (1–55): if any listed job is queued or running, the call holds until one of them changes status (starts, finishes, fails) or a new job is queued in one of their sessions, then returns the fresh list — or returns after waitSec seconds when nothing changed. Call it again in a loop until the result is empty / all done; no separate sleep is needed. Without waitSec the call returns at once; do not poll it in a tight loop. A failed job that someone acknowledged (jobs.dismiss) has dismissedAt set; hideDismissed: true leaves those failures out (e.g. status ["failed"] with hideDismissed lists the failures nobody has dealt with yet). Deleting an audio segment dismisses its transcribe and waveform jobs automatically.',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  watch: ({ waitSec, showId }, signal) =>
    waitSec ? watchJobs(waitSec * 1000, showId, signal) : null,
  async run(ctx, { sessionId, showId, status, kinds, limit, hideDismissed }) {
    const statusCond = and(
      status ? inArray(jobs.status, status) : undefined,
      kinds ? inArray(jobs.kind, kinds) : undefined,
      hideDismissed ? isNull(jobs.dismissedAt) : undefined,
    );
    if (sessionId) {
      await requireSession(ctx, sessionId, 'read');
      const rows = await ctx.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.sessionId, sessionId), statusCond))
        .orderBy(desc(jobs.createdAt))
        .limit(limit);
      return withJobEstimates(ctx.db, rows.map(toJob));
    }
    // Read access is per show, so every session of a readable show is readable.
    await requireShow(ctx, showId!, 'read');
    // Session jobs and show-level jobs (compile: jobs.show_id) as two indexed queries, merged.
    const [rows, showRows] = await Promise.all([
      ctx.db
        .select({ job: jobs, sessionTitle: sessions.title })
        .from(jobs)
        .innerJoin(sessions, eq(sessions.id, jobs.sessionId))
        .where(and(eq(sessions.showId, showId!), statusCond))
        .orderBy(desc(jobs.createdAt))
        .limit(limit),
      ctx.db
        .select({ job: jobs, compilationTitle: compilations.title })
        .from(jobs)
        .leftJoin(compilations, sql`${compilations.id} = ${jobs.payload}->>'compilationId'`)
        .where(and(eq(jobs.showId, showId!), statusCond))
        .orderBy(desc(jobs.createdAt))
        .limit(limit),
    ]);
    const merged = [
      ...rows.map((r) => ({ row: r.job, job: { ...toJob(r.job), sessionTitle: r.sessionTitle } })),
      ...showRows.map((r) => ({
        row: r.job,
        job: {
          ...toJob(r.job),
          ...(r.compilationTitle !== null ? { compilationTitle: r.compilationTitle } : {}),
        },
      })),
    ]
      .sort(
        (a, b) =>
          b.row.createdAt.getTime() - a.row.createdAt.getTime() || (a.row.id < b.row.id ? 1 : -1),
      )
      .slice(0, limit);
    return withJobEstimates(
      ctx.db,
      merged.map((m) => m.job),
    );
  },
});

defineOp({
  name: 'jobs.dismiss',
  description:
    "Acknowledge a failed background job (jobId from jobs.list) so it stops being reported as an open failure: sets its dismissedAt, and jobs.list with hideDismissed: true leaves it out. Use it once a failure has been dealt with or cannot be fixed (e.g. a private or deleted video). It does not retry, delete or change anything else; the job and its error stay readable in jobs.list. Only failed jobs can be dismissed (other states are a conflict error); dismissing one again returns it unchanged. Works for session jobs and show-level compile jobs. Needs write access to the job's show. Returns the job.",
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { jobId }) {
    const [row] = await ctx.db.select().from(jobs).where(eq(jobs.id, jobId));
    if (!row || !(row.sessionId || row.showId)) throw notFound('Job');
    try {
      if (row.sessionId) await requireSession(ctx, row.sessionId, 'write');
      else await requireShow(ctx, row.showId!, 'write');
    } catch (e) {
      if ((e as { code?: string }).code === 'not_found') throw notFound('Job');
      throw e;
    }
    if (row.status !== 'failed') throw conflict('Only failed jobs can be dismissed.');
    if (row.dismissedAt) return toJob(row);
    // Not a content write (jobs aren't in the change log), so nothing to record or undo; the
    // job's updatedAt is left alone so it still says when the job failed.
    const [next] = await ctx.db
      .update(jobs)
      .set({ dismissedAt: new Date() })
      .where(eq(jobs.id, jobId))
      .returning();
    publishJob(ctx, next!);
    return toJob(next!);
  },
});

// ── a team's YouTube sign-in for the server's yt-dlp ──────────────

/** A public video the cookie check reads (metadata only): YouTube's first upload. */
const COOKIE_CHECK_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const COOKIE_CHECK_TIMEOUT_MS = 20_000;

/** The team a youtubeAccess call is about, authorized: any member reads, owner/admin writes. */
async function youtubeTeam(
  ctx: Ctx,
  { teamId, showId }: { teamId?: string; showId?: string },
  need: 'read' | 'manage',
): Promise<string> {
  if (showId) return (await requireShow(ctx, showId, need)).show.teamId;
  await requireTeamRole(ctx, teamId!, need === 'manage' ? 'admin' : 'member');
  return teamId!;
}

async function youtubeAccessOf(ctx: Ctx, teamId: string): Promise<YoutubeAccess> {
  const [team] = await ctx.db
    .select({ name: schema.teams.name })
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId));
  const [row] = await ctx.db
    .select({ c: teamYoutubeCookies, by: schema.users.name })
    .from(teamYoutubeCookies)
    .leftJoin(schema.users, eq(schema.users.id, teamYoutubeCookies.updatedBy))
    .where(eq(teamYoutubeCookies.teamId, teamId));
  const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
  return {
    teamId,
    teamName: team?.name ?? '',
    configured: Boolean(row),
    serverCookies: Boolean(env.ytDlpCookiesFile),
    updatedAt: iso(row?.c.updatedAt),
    updatedBy: row?.c.updatedBy ? { id: row.c.updatedBy, name: row.by ?? '' } : null,
    expiresAt: iso(row?.c.expiresAt),
    lastOkAt: iso(row?.c.lastOkAt),
    lastFailedAt: iso(row?.c.lastFailedAt),
    lastError: row?.c.lastError ?? null,
  };
}

defineOp({
  name: 'media.youtubeAccess',
  description:
    "Whether a team has a YouTube sign-in for the server's YouTube downloads (media_importYoutube, media_importPlaylist, video compilations of all its shows), and how it last went. Pass teamId (teams_list) or showId (its team). Returns teamId, teamName, configured, who set it and when (updatedAt, updatedBy), expiresAt (earliest expiry of the sign-in cookies; YouTube often signs them out sooner), lastOkAt / lastFailedAt and lastError (the last time YouTube accepted or refused them), and serverCookies (the server also has instance-wide cookies, used for teams without their own). Check it before importing: when configured is false, or lastFailedAt is newer than lastOkAt, imports will likely fail with YouTube's bot check; ask the user to sign in and set it (media_setYoutubeCookies). Never returns the cookies. Any team member can read it.",
  kind: 'read',
  surfaces: ['web', 'mcp'],
  async run(ctx, input) {
    return youtubeAccessOf(ctx, await youtubeTeam(ctx, input, 'read'));
  },
});

defineOp({
  name: 'media.setYoutubeCookies',
  description:
    'Set (or with cookies: null, remove) the YouTube sign-in the server\'s yt-dlp uses for one team: every show of the team downloads as this account (media_importYoutube, media_importPlaylist, video compilations), which gets past YouTube\'s "Sign in to confirm you\'re not a bot" check on the server and reads private, members-only or age-restricted videos the account can watch. Pass teamId (teams_list) or showId (sets it for that show\'s team). yt-dlp has no YouTube login with a password, so this takes the cookies of a browser signed in to YouTube: a Netscape cookies.txt (`yt-dlp --cookies-from-browser firefox --cookies cookies.txt --skip-download <any video URL>`, or the "Get cookies.txt LOCALLY" extension) or a JSON cookie export; `autologger-import youtube-login --team <teamId> --cookies-from-browser <browser>` does it in one step without the cookies passing through an agent. The cookies give full access to that Google account: only send them when the user has agreed to it, and suggest a spare account. Only the youtube.com and google.com cookies are kept, and they must include a signed-in session (SID or LOGIN_INFO), else bad_request. Needs owner/admin of the team. The cookies are tested at once by reading a public video\'s metadata (about 5 s): `check` {ok, message} reports it (null when YouTube import is off); they are saved either way, so on check.ok false ask for fresh ones. YouTube rotates the cookies as the browser and the server use them; the server stores its refreshed copy after every run, but a copy goes stale when the browser keeps using YouTube in the same profile, so they last longest from a profile used only for this. When they stop working, imports fail with "…the cookies have probably expired": set fresh ones. Returns the team\'s youtubeAccess plus check. The cookies are never returned or recorded in the change log.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  // Authorize, parse and test the cookies with yt-dlp before the op's transaction opens.
  async prepare(actor, { teamId, showId, cookies }) {
    await db.transaction((tx) =>
      youtubeTeam(prepareCtx(actor, tx, 'media.setYoutubeCookies'), { teamId, showId }, 'manage'),
    );
    if (cookies === null) return null;
    let parsed: ParsedCookies;
    try {
      parsed = parseYoutubeCookies(cookies);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    if (!env.youtubeEnabled) return { parsed, check: null };
    let rotated: string | null = null;
    let check: { ok: boolean; message: string };
    try {
      await videoDuration(env.ytDlpPath, COOKIE_CHECK_URL, COOKIE_CHECK_TIMEOUT_MS, {
        text: parsed.text,
        report: async ({ refreshed }) => {
          rotated = refreshed;
        },
      });
      check = {
        ok: true,
        message: 'YouTube accepted the cookies: downloads for this team’s shows will use them.',
      };
    } catch (e) {
      check = {
        ok: false,
        message:
          e instanceof YoutubeAuthError
            ? `YouTube refused the cookies (${e.reason === 'bot_check' ? 'bot check' : 'sign-in required'}): they may be signed out or already rotated. Export them again from a browser signed in to YouTube.`
            : `Could not test the cookies: ${(e as Error).message.slice(0, 300)}`,
      };
    }
    // YouTube answers signed-out cookies by deleting the sign-in cookies, often without an error
    // when it isn't bot-checking this server: then the check failed after all.
    const after = rotated ? rotatedCookies(rotated) : null;
    if (after === 'signedOut') check = { ok: false, message: SIGNED_OUT_MESSAGE };
    else if (after) parsed = after;
    return { parsed, check };
  },
  async run(ctx, input, prepared) {
    const teamId = await youtubeTeam(ctx, input, 'manage');
    if (!prepared) {
      await ctx.db.delete(teamYoutubeCookies).where(eq(teamYoutubeCookies.teamId, teamId));
    } else {
      const { parsed, check } = prepared;
      const now = new Date();
      const values = {
        cookies: parsed.text,
        expiresAt: parsed.expiresAt,
        updatedBy: ctx.actor.user.id,
        updatedAt: now,
        lastOkAt: check?.ok ? now : null,
        lastFailedAt: check && !check.ok ? now : null,
        lastError: check && !check.ok ? check.message : null,
      };
      await ctx.db
        .insert(teamYoutubeCookies)
        .values({ teamId, ...values })
        .onConflictDoUpdate({ target: teamYoutubeCookies.teamId, set: values });
    }
    return { ...(await youtubeAccessOf(ctx, teamId)), check: prepared?.check ?? null };
  },
});
