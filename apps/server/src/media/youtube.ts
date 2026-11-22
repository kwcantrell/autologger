// YouTube import via yt-dlp. Downloads the best audio-only stream as-is (no ffmpeg re-encode).

import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '../env.ts';
import { PermanentError } from './deepgram.ts';

const YT_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
]);

export function isYoutubeUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (
      (u.protocol === 'https:' || u.protocol === 'http:') && YT_HOSTS.has(u.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** The 11-character video id of a YouTube URL (watch, youtu.be, shorts, live, embed), or null. */
export function youtubeVideoId(raw: string | null | undefined): string | null {
  if (!raw || !isYoutubeUrl(raw)) return null;
  const u = new URL(raw);
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  const id = host.endsWith('youtu.be')
    ? parts[0]
    : ['shorts', 'live', 'embed', 'v'].includes(parts[0] ?? '')
      ? parts[1]
      : u.searchParams.get('v');
  return id && VIDEO_ID.test(id) ? id : null;
}

/** The playlist id (`list=`) of a YouTube URL, or null. */
export function youtubePlaylistId(raw: string): string | null {
  if (!isYoutubeUrl(raw)) return null;
  const id = new URL(raw).searchParams.get('list');
  return id && /^[A-Za-z0-9_-]{2,64}$/.test(id) ? id : null;
}

export const watchUrl = (videoId: string) => `https://www.youtube.com/watch?v=${videoId}`;

const MIME_BY_EXT: Record<string, string> = {
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  webm: 'audio/webm',
  opus: 'audio/ogg',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
};

export interface Download {
  dir: string;
  path: string;
  ext: string;
  mimeType: string;
  title: string | null;
  durationSec: number | null;
  /** Upload date as YYYY-MM-DD, when yt-dlp reports one. */
  uploadDate: string | null;
  cleanup(): Promise<void>;
}

/**
 * Thrown when YouTube refuses the download until someone signs in: its bot check ("Sign in to
 * confirm you're not a bot", usually for a datacenter IP) or a private, members-only or
 * age-restricted video. Retrying won't help, so it is permanent.
 */
export class YoutubeAuthError extends PermanentError {
  readonly reason: 'bot_check' | 'restricted';
  constructor(reason: 'bot_check' | 'restricted', message: string) {
    super(message);
    this.reason = reason;
  }
}

// Age-restricted errors also suggest --cookies, so they are checked first.
const RESTRICTED =
  /private video|video is private|members[- ]only|join this channel|confirm your age|age[- ]restricted|inappropriate for some users/i;
const BOT_CHECK =
  /confirm you(?:'|\u2019)?re not a bot|--cookies-from-browser|use --cookies|cookies for the authentication/i;

/** The sign-in error in yt-dlp's stderr, as a YoutubeAuthError, or null for any other failure. */
export function youtubeAuthError(
  stderr: string,
  cookiesConfigured: boolean,
): YoutubeAuthError | null {
  const line =
    stderr
      .split('\n')
      .filter((l) => RESTRICTED.test(l) || BOT_CHECK.test(l))
      .at(0)
      ?.trim()
      .slice(0, 200) ?? '';
  if (!line) return null;
  const detail = ` (yt-dlp: ${line})`;
  if (RESTRICTED.test(stderr))
    return new YoutubeAuthError(
      'restricted',
      cookiesConfigured
        ? `YouTube requires a signed-in account for this video (private, members-only or age-restricted), and the account in YTDLP_COOKIES_FILE cannot watch it (or its cookies have expired).${detail}`
        : `YouTube requires a signed-in account for this video (private, members-only or age-restricted). Configure YTDLP_COOKIES_FILE with an account that can watch it on the server and worker; see docs/media.md.${detail}`,
    );
  return new YoutubeAuthError(
    'bot_check',
    cookiesConfigured
      ? `YouTube is blocking this server's downloads (bot check) even with the cookies in YTDLP_COOKIES_FILE: they have probably expired or been signed out. Export fresh cookies (and/or set YTDLP_PROXY) on the server and worker; see docs/media.md.${detail}`
      : `YouTube is blocking this server's downloads (bot check). Configure YTDLP_COOKIES_FILE (and/or YTDLP_PROXY) on the server and worker; see docs/media.md.${detail}`,
  );
}

/**
 * Run yt-dlp with the operator's YouTube access settings (YTDLP_COOKIES_FILE, YTDLP_PROXY,
 * YTDLP_EXTRA_ARGS) in front of `args`. Every yt-dlp call goes through here.
 */
async function run(
  cmd: string,
  args: string[],
  timeoutMs?: number,
): Promise<{ stdout: string; stderr: string }> {
  const pre: string[] = [];
  let cookieDir: string | null = null;
  if (env.ytDlpCookiesFile) {
    // yt-dlp saves cookies back on exit: give each run a private copy, so a read-only mount
    // works and concurrent runs never write the same file.
    cookieDir = await mkdtemp(join(tmpdir(), 'autologger-ytc-'));
    const copy = join(cookieDir, 'cookies.txt');
    try {
      await copyFile(env.ytDlpCookiesFile, copy);
      await chmod(copy, 0o600);
    } catch (e) {
      await rm(cookieDir, { recursive: true, force: true });
      throw new PermanentError(
        `Cannot read YTDLP_COOKIES_FILE (${env.ytDlpCookiesFile}): ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}.`,
      );
    }
    pre.push('--cookies', copy);
  }
  if (env.ytDlpProxy) pre.push('--proxy', env.ytDlpProxy);
  pre.push(...env.ytDlpExtraArgs);
  try {
    return await spawnYtDlp(cmd, [...pre, ...args], timeoutMs);
  } finally {
    if (cookieDir) await rm(cookieDir, { recursive: true, force: true }).catch(() => {});
  }
}

function spawnYtDlp(
  cmd: string,
  args: string[],
  timeoutMs?: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT')
        reject(
          new PermanentError(
            `yt-dlp not found (YTDLP_PATH=${cmd}). Install yt-dlp on the worker host.`,
          ),
        );
      else reject(e);
    });
    child.on('close', (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else if (signal && timeoutMs)
        reject(new Error(`yt-dlp did not finish within ${Math.round(timeoutMs / 1000)} seconds.`));
      else {
        const auth = youtubeAuthError(stderr, Boolean(env.ytDlpCookiesFile));
        if (auth) return reject(auth);
        const last =
          stderr
            .trim()
            .split('\n')
            .filter((l) => l.includes('ERROR'))
            .at(-1) ??
          stderr.trim().split('\n').at(-1) ??
          '';
        reject(
          new Error(`yt-dlp exited with code ${code}${last ? `: ${last.slice(0, 300)}` : ''}`),
        );
      }
    });
  });
}

/** yt-dlp format for audio imports: the best audio-only stream, as-is. */
const AUDIO_FORMAT = 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio';

export async function downloadAudio(ytDlpPath: string, url: string): Promise<Download> {
  const dir = await mkdtemp(join(tmpdir(), 'autologger-yt-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    const { stdout } = await run(ytDlpPath, [
      '-f',
      AUDIO_FORMAT,
      '--no-playlist',
      '--no-progress',
      '--no-simulate',
      '--dump-json',
      '-o',
      join(dir, 'audio.%(ext)s'),
      url,
    ]);
    const file = (await readdir(dir)).find((f) => f.startsWith('audio.') && !f.endsWith('.part'));
    if (!file) throw new Error('yt-dlp finished but produced no audio file.');
    let info: { title?: string; duration?: number; upload_date?: string } = {};
    try {
      info = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}');
    } catch {
      /* metadata is optional */
    }
    const ext = file.slice('audio.'.length).toLowerCase();
    return {
      dir,
      path: join(dir, file),
      ext,
      mimeType: MIME_BY_EXT[ext] ?? 'application/octet-stream',
      title: info.title ?? null,
      durationSec: typeof info.duration === 'number' ? info.duration : null,
      uploadDate: isoDate(info.upload_date),
      cleanup,
    };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

/** yt-dlp's YYYYMMDD as YYYY-MM-DD. */
function isoDate(d: unknown): string | null {
  return typeof d === 'string' && /^\d{8}$/.test(d)
    ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
    : null;
}

/**
 * One video's length in seconds from its metadata, without downloading anything; null when
 * yt-dlp does not report one. Resolves the same audio format as downloadAudio, so it doubles as
 * a cheap probe: a YoutubeAuthError here means the download would hit it too. Throws when yt-dlp
 * fails or exceeds `timeoutMs`.
 */
export async function videoDuration(
  ytDlpPath: string,
  url: string,
  timeoutMs: number,
): Promise<number | null> {
  const { stdout } = await run(
    ytDlpPath,
    [
      '--ignore-config',
      '-f',
      AUDIO_FORMAT,
      '--no-playlist',
      '--skip-download',
      '--dump-json',
      '--no-warnings',
      '--',
      url,
    ],
    timeoutMs,
  );
  try {
    const d: unknown = JSON.parse(stdout.trim().split('\n').at(-1) ?? '').duration;
    return typeof d === 'number' && d > 0 ? d : null;
  } catch {
    return null;
  }
}

export interface PlaylistEntry {
  videoId: string;
  title: string;
  durationSec: number | null;
  /** False for private or deleted videos, which cannot be imported. */
  available: boolean;
}

export interface Playlist {
  title: string | null;
  entries: PlaylistEntry[];
}

/**
 * List a playlist's videos without downloading anything (`--flat-playlist`). Flat entries carry
 * id, title and duration but no upload date; the per-video import reads that.
 */
export async function listPlaylist(
  ytDlpPath: string,
  url: string,
  opts: { maxEntries: number; timeoutMs: number },
): Promise<Playlist> {
  const { stdout } = await run(
    ytDlpPath,
    [
      '--ignore-config',
      '--flat-playlist',
      '--dump-single-json',
      '--no-warnings',
      '--playlist-end',
      String(opts.maxEntries),
      '--',
      url,
    ],
    opts.timeoutMs,
  );
  let info: { title?: unknown; entries?: unknown };
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new Error('yt-dlp returned unreadable playlist data.');
  }
  const entries: PlaylistEntry[] = [];
  for (const e of Array.isArray(info.entries) ? info.entries : []) {
    const r = e as { id?: unknown; title?: unknown; duration?: unknown; availability?: unknown };
    if (typeof r.id !== 'string' || !VIDEO_ID.test(r.id)) continue;
    const title = typeof r.title === 'string' ? r.title : r.id;
    entries.push({
      videoId: r.id,
      title,
      durationSec: typeof r.duration === 'number' ? r.duration : null,
      available:
        !/^\[(private|deleted) video\]$/i.test(title) &&
        !['private', 'needs_auth', 'subscriber_only', 'premium_only'].includes(
          String(r.availability),
        ),
    });
  }
  return { title: typeof info.title === 'string' ? info.title : null, entries };
}

/** yt-dlp format for compilation clips: at most 720p, preferring streams that mux into MP4. */
const SECTION_FORMAT =
  'bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/bv*[height<=720]+ba/b[height<=720]/bv*+ba/b';

/**
 * Download only [fromSec, toSec) of a video (seconds of the video's own time) with video and
 * audio, cut on exact frames (`--force-keyframes-at-cuts` re-encodes around the cuts; yt-dlp uses
 * ffmpeg for sections). Returns the path of the file written into `dir` as `<name>.<ext>`.
 */
export async function downloadSection(
  ytDlpPath: string,
  ffmpegPath: string,
  url: string,
  fromSec: number,
  toSec: number,
  dir: string,
  name: string,
  timeoutMs = 30 * 60_000,
): Promise<string> {
  await run(
    ytDlpPath,
    [
      '-f',
      SECTION_FORMAT,
      '--merge-output-format',
      'mp4',
      '--download-sections',
      `*${fromSec.toFixed(3)}-${toSec.toFixed(3)}`,
      '--force-keyframes-at-cuts',
      ...(ffmpegPath !== 'ffmpeg' ? ['--ffmpeg-location', ffmpegPath] : []),
      '--no-playlist',
      '--no-progress',
      '--no-warnings',
      '-o',
      join(dir, `${name}.%(ext)s`),
      '--',
      url,
    ],
    timeoutMs,
  );
  // `<name>.<ext>`, not yt-dlp's leftovers (`<name>.f137.mp4`, `<name>.mp4.part`).
  const file = (await readdir(dir)).find(
    (f) => f.startsWith(`${name}.`) && /^[a-z0-9]+$/i.test(f.slice(name.length + 1)),
  );
  if (!file) throw new Error('yt-dlp finished but produced no video file.');
  return join(dir, file);
}
