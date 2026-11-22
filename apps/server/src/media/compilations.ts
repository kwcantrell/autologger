// Video compilations: which YouTube video (and where in it) a session range comes from, and the
// ffmpeg steps the worker's `compile` job runs on the downloaded sections.
//
// Time mapping: a YouTube import stores the video's audio as one audio segment placed at
// `segment.startSec` on the session clock, so session second s is video second s − startSec.

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import type { CompilationStatus } from '@autologger/contract';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { BusMessage } from '../core/bus.ts';
import { type DbOrTx, schema } from '../db/client.ts';
import { PermanentError } from './deepgram.ts';
import { STORED } from './segments.ts';
import { youtubeVideoId } from './youtube.ts';

const { audioSegments, sessions } = schema;

/** The realtime hint for one compilation (show socket → the web list; compilations.get waits). */
export function compilationMessage(
  showId: string,
  id: string,
  status: CompilationStatus | 'deleted',
): BusMessage {
  return { type: 'compilation_changed', showId, id, status };
}

/** A range may run past the end of the stored audio by this much (rounding of durations). */
const END_SLACK_SEC = 1;

export interface ClipRange {
  sessionId: string;
  startSec: number;
  endSec: number;
}

export interface ClipSource {
  sessionId: string;
  sessionTitle: string;
  showId: string;
  /** The session's YouTube URL (sessions.sourceUrl). */
  url: string;
  /** Video seconds of the range. */
  fromSec: number;
  toSec: number;
}

/**
 * Resolve each clip to its YouTube video range, or a reason it cannot be compiled. One entry per
 * clip, in order. `showId`, when given, requires every session to belong to that show.
 */
export async function resolveClipSources(
  db: DbOrTx,
  clips: ClipRange[],
  showId?: string,
): Promise<(ClipSource | { error: string })[]> {
  const ids = [...new Set(clips.map((c) => c.sessionId))];
  const sessionRows = ids.length
    ? await db
        .select({
          id: sessions.id,
          showId: sessions.showId,
          title: sessions.title,
          sourceKind: sessions.sourceKind,
          sourceUrl: sessions.sourceUrl,
        })
        .from(sessions)
        .where(inArray(sessions.id, ids))
    : [];
  const byId = new Map(sessionRows.map((s) => [s.id, s]));
  const segRows = ids.length
    ? await db
        .select({
          sessionId: audioSegments.sessionId,
          startSec: audioSegments.startSec,
          durationSec: audioSegments.durationSec,
        })
        .from(audioSegments)
        .where(
          and(
            inArray(audioSegments.sessionId, ids),
            eq(audioSegments.origin, 'youtube'),
            inArray(audioSegments.status, [...STORED]),
          ),
        )
        // The latest import is the one sessions.sourceUrl points at.
        .orderBy(desc(audioSegments.ordinal))
    : [];

  return clips.map((c) => {
    const s = byId.get(c.sessionId);
    // A session of another show is reported like a missing one (ids of other shows stay unconfirmed).
    if (!s || (showId && s.showId !== showId)) return { error: 'session not found in this show' };
    if (s.sourceKind !== 'youtube' || !s.sourceUrl || !youtubeVideoId(s.sourceUrl))
      return { error: 'the session was not imported from YouTube' };
    const seg = segRows.find((r) => r.sessionId === c.sessionId);
    if (!seg) return { error: 'the session has no stored YouTube audio' };
    const segEnd = seg.durationSec === null ? null : seg.startSec + seg.durationSec;
    if (c.startSec < seg.startSec || (segEnd !== null && c.endSec > segEnd + END_SLACK_SEC))
      return {
        error: `the range is outside the YouTube video (session ${fmt(seg.startSec)}–${segEnd === null ? '?' : fmt(segEnd)} s)`,
      };
    const toSec = segEnd === null ? c.endSec : Math.min(c.endSec, segEnd);
    return {
      sessionId: s.id,
      sessionTitle: s.title,
      showId: s.showId,
      url: s.sourceUrl,
      fromSec: c.startSec - seg.startSec,
      toSec: toSec - seg.startSec,
    };
  });
}

const fmt = (n: number) => String(Math.round(n * 10) / 10);

// ── ffmpeg ────────────────────────────────────────────────────

/** Every clip is re-encoded to this, so the parts concatenate without re-encoding again. */
export const OUTPUT = { width: 1280, height: 720, fps: 30, audioRate: 48000 } as const;

const FFMPEG_TIMEOUT_MS = 60 * 60_000;

function ffmpeg(
  ffmpegPath: string,
  args: string[],
  timeoutMs = FFMPEG_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-nostdin', '-hide_banner', '-y', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT')
        reject(new PermanentError(`ffmpeg not found (FFMPEG_PATH=${ffmpegPath}).`));
      else reject(e);
    });
    child.on('close', (code, signal) => {
      if (code === 0) return resolve(stdout);
      if (signal) return reject(new Error(`ffmpeg was stopped (${signal}).`));
      const last = stderr.trim().split('\n').at(-1) ?? '';
      reject(new Error(`ffmpeg exited with code ${code}${last ? `: ${last.slice(0, 300)}` : ''}`));
    });
  });
}

/**
 * Re-encode one downloaded section to the common format: H.264 (yuv420p) at OUTPUT size
 * (letterboxed), OUTPUT fps, AAC stereo at OUTPUT audioRate, at most `maxSec` long. A section
 * without an audio track gets silence so every part has the same streams.
 */
export async function normalizeClip(
  ffmpegPath: string,
  input: string,
  output: string,
  maxSec: number,
): Promise<void> {
  const { width: w, height: h, fps, audioRate } = OUTPUT;
  const audio = await probeHasAudio(ffmpegPath, input);
  await ffmpeg(ffmpegPath, [
    '-v',
    'error',
    '-i',
    input,
    ...(audio
      ? []
      : ['-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=${audioRate}`]),
    '-filter_complex',
    `[0:v:0]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v]`,
    '-map',
    '[v]',
    '-map',
    audio ? '0:a:0' : '1:a:0',
    '-t',
    maxSec.toFixed(3),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-ar',
    String(audioRate),
    '-ac',
    '2',
    ...(audio ? [] : ['-shortest']),
    output,
  ]);
}

/** True when the file has an audio stream (also when ffprobe cannot tell). */
function probeHasAudio(ffmpegPath: string, file: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      ffprobeFor(ffmpegPath),
      [
        '-v',
        'error',
        '-select_streams',
        'a',
        '-show_entries',
        'stream=index',
        '-of',
        'csv=p=0',
        file,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 },
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(true));
    child.on('close', (code) => resolve(code !== 0 || out.trim().length > 0));
  });
}

/** Join normalised parts (same codecs and parameters) into one MP4 with the index up front. */
export async function concatClips(
  ffmpegPath: string,
  parts: string[],
  listFile: string,
  output: string,
): Promise<void> {
  await writeFile(listFile, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  await ffmpeg(ffmpegPath, [
    '-v',
    'error',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listFile,
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    output,
  ]);
}

/** ffprobe next to ffmpeg (same package). */
export const ffprobeFor = (ffmpegPath: string) =>
  ffmpegPath.replace(/ffmpeg(\.exe)?$/i, (_m, ext: string | undefined) => `ffprobe${ext ?? ''}`);

/** Container duration in seconds, or null when ffprobe is missing or cannot tell. */
export function probeDuration(ffmpegPath: string, file: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(
      ffprobeFor(ffmpegPath),
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 },
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      const n = Number.parseFloat(out.trim());
      resolve(code === 0 && Number.isFinite(n) && n > 0 ? n : null);
    });
  });
}
