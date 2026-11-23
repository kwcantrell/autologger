#!/usr/bin/env node
// @ts-check
// AutoLogger local import helper: runs yt-dlp (and ffmpeg) on your own computer, with your
// browser's YouTube cookies, and sends only the audio or the finished compilation MP4 to
// AutoLogger. Cookies leave this machine only with `youtube-login`, which hands a team's YouTube
// sign-in to the server so it can download by itself. One dependency-free file (Node >= 22); the
// server serves it at /api/importer/autologger-import.mjs. Docs: docs/importer.md.

import { spawn } from 'node:child_process';
import { createReadStream, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const VERSION = '1.0.0';

const USAGE = `autologger-import ${VERSION} — import YouTube videos into AutoLogger from your computer

Usage:
  autologger-import playlist <playlist-url> --show <showId> [--order playlist|reverse]
                             [--title-template "{episode}: {title}"]
  autologger-import video <video-url> (--show <showId> | --session <sessionId>)
  autologger-import compile <compilationId>
  autologger-import youtube-login (--team <teamId> | --show <showId>) (--cookies-from-browser <browser> | --cookies <file>)
                             give the AutoLogger server this YouTube sign-in for the team (of the
                             show), so it imports and compiles all its shows' videos by itself
                             (sends the youtube.com/google.com cookies; use a spare account)

Options:
  --cookies-from-browser <browser>  yt-dlp reads your YouTube sign-in from this browser
                                    (chrome, firefox, edge, safari, brave, …[:profile])
  --cookies <file>                  yt-dlp cookies.txt (Netscape format) instead
  --dry-run                         show what would happen; create and upload nothing
  --keep                            keep downloaded files after uploading
  --work-dir <dir>                  where downloads go (default ~/.cache/autologger-import)
  --yt-dlp <path>                   yt-dlp binary (default: YTDLP_PATH or yt-dlp on PATH)
  --ffmpeg <path>                   ffmpeg binary for compile (default: FFMPEG_PATH or ffmpeg)
  -h, --help                        this help

Environment:
  AUTOLOGGER_URL    your AutoLogger address, e.g. https://autologger.example.com
  AUTOLOGGER_TOKEN  a personal access token (Settings › Agents › Personal access tokens)

Re-running a command resumes: videos already uploaded and clips already encoded are skipped.`;

/** Same format choices as the server (apps/server/src/media/youtube.ts). */
const AUDIO_FORMAT = 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio';
const SECTION_FORMAT =
  'bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/bv*[height<=720]+ba/b[height<=720]/bv*+ba/b';
/** Same output as the server's compile job (apps/server/src/media/compilations.ts OUTPUT). */
const OUTPUT = { width: 1280, height: 720, fps: 30, audioRate: 48000 };
const MAX_PLAYLIST_VIDEOS = 200;

/** @type {Record<string, string>} */
const MIME_BY_EXT = {
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  webm: 'audio/webm',
  opus: 'audio/ogg',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
};

/** yt-dlp availability values the AutoLogger server can never download. */
const PRIVATE_AVAILABILITY = new Set(['private', 'needs_auth', 'subscriber_only', 'premium_only']);

/** A failure to report to the user as one line (exit code 1), without a stack trace. */
export class CliError extends Error {}

// ── arguments ──────────────────────────────────────────────────

/**
 * @typedef {{
 *   command: string | undefined; target: string | undefined; show?: string; team?: string;
 *   session?: string;
 *   order: 'playlist' | 'reverse'; titleTemplate?: string; cookiesFromBrowser?: string;
 *   cookies?: string; dryRun: boolean; keep: boolean; workDir?: string; ytDlp?: string;
 *   ffmpeg?: string; help: boolean;
 * }} Args
 */

/** @param {string[]} argv @returns {Args} */
export function parseArgs(argv) {
  /** @type {Args} */
  const a = {
    command: undefined,
    target: undefined,
    order: 'playlist',
    dryRun: false,
    keep: false,
    help: false,
  };
  /** @type {Record<string, (v: string) => void>} */
  const withValue = {
    '--show': (v) => (a.show = v),
    '--team': (v) => (a.team = v),
    '--session': (v) => (a.session = v),
    '--title-template': (v) => (a.titleTemplate = v),
    '--cookies-from-browser': (v) => (a.cookiesFromBrowser = v),
    '--cookies': (v) => (a.cookies = v),
    '--work-dir': (v) => (a.workDir = v),
    '--yt-dlp': (v) => (a.ytDlp = v),
    '--ffmpeg': (v) => (a.ffmpeg = v),
    '--order': (v) => {
      if (v !== 'playlist' && v !== 'reverse')
        throw new CliError('--order is playlist or reverse.');
      a.order = v;
    },
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = /** @type {string} */ (argv[i]);
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? arg.split(/=(.*)/s) : [arg];
    const setter = withValue[/** @type {string} */ (flag)];
    if (setter) {
      const v = inline ?? argv[++i];
      if (v === undefined || v === '') throw new CliError(`${flag} needs a value.`);
      setter(v);
    } else if (arg === '--dry-run') a.dryRun = true;
    else if (arg === '--keep') a.keep = true;
    else if (arg === '-h' || arg === '--help') a.help = true;
    else if (arg.startsWith('-')) throw new CliError(`Unknown option ${arg}. See --help.`);
    else positional.push(arg);
  }
  [a.command, a.target] = positional;
  if (positional.length > 2) throw new CliError(`Unexpected argument ${positional[2]}.`);
  return a;
}

// ── output ─────────────────────────────────────────────────────

/** @param {string} line */
const say = (line) => process.stdout.write(`${line}\n`);

/** @param {number} sec */
function clock(sec) {
  const t = Math.round(sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** @param {number} n */
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

// ── AutoLogger API ─────────────────────────────────────────────

/** @typedef {(op: string, input: Record<string, unknown>) => Promise<any>} Rpc */

/**
 * POST /api/rpc/<op> with the personal access token; returns `data` or throws a CliError with
 * the server's message.
 * @param {string} baseUrl @param {string} token @returns {Rpc}
 */
export function makeRpc(baseUrl, token) {
  return async (op, input) => {
    let res;
    try {
      res = await fetch(`${baseUrl}/api/rpc/${op}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
    } catch (e) {
      throw new CliError(
        `Cannot reach AutoLogger at ${baseUrl} (${errorText(e)}). Check AUTOLOGGER_URL.`,
      );
    }
    const body =
      /** @type {{ ok?: boolean; data?: unknown; error?: { code: string; message: string } } | null} */ (
        await res.json().catch(() => null)
      );
    if (res.status === 401)
      throw new CliError(
        'AutoLogger rejected AUTOLOGGER_TOKEN. Create a personal access token in Settings › Agents and set AUTOLOGGER_TOKEN to it.',
      );
    if (!body?.ok) {
      const err = body?.error;
      throw new CliError(
        err ? `${op}: ${err.message} (${err.code})` : `${op}: HTTP ${res.status} from ${baseUrl}`,
      );
    }
    return body.data;
  };
}

/** @param {unknown} e */
const errorText = (e) => {
  const err = /** @type {Error & { cause?: { code?: string } }} */ (e);
  return err.cause?.code ?? err.message;
};

/**
 * PUT a file to a presigned URL with the given headers, reporting progress.
 * @param {string} url @param {Record<string, string>} headers @param {string} file
 * @param {(sent: number, total: number) => void} [onProgress]
 * @returns {Promise<void>}
 */
export async function putFile(url, headers, file, onProgress) {
  const total = (await stat(file)).size;
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  await new Promise((resolvePut, reject) => {
    const req = mod.request(
      u,
      { method: 'PUT', headers: { ...headers, 'Content-Length': String(total) } },
      (res) => {
        let text = '';
        res.on('data', (d) => (text = (text + d).slice(-2000)));
        res.on('end', () => {
          const code = res.statusCode ?? 0;
          if (code >= 200 && code < 300) resolvePut(undefined);
          else
            reject(
              new CliError(
                `Upload failed: HTTP ${code} ${text.replace(/\s+/g, ' ').slice(0, 300)}`,
              ),
            );
        });
      },
    );
    req.on('error', (e) => reject(new CliError(`Upload failed: ${errorText(e)}`)));
    let sent = 0;
    const stream = createReadStream(file);
    stream.on('data', (chunk) => {
      sent += chunk.length;
      onProgress?.(sent, total);
    });
    stream.on('error', reject);
    stream.pipe(req);
  });
}

// ── tools ──────────────────────────────────────────────────────

/**
 * @typedef {{ ytDlp: string; ffmpeg: string; cookieArgs: string[]; workDir: string;
 *   keep: boolean; dryRun: boolean; rpc: Rpc }} Ctx
 */

/**
 * Run a tool, collecting stdout and the tail of stderr. Live progress goes to the terminal when
 * `liveStderr` (yt-dlp's progress bar).
 * @param {string} cmd @param {string[]} args @param {{ tool: string; hint: string; liveStderr?: boolean }} o
 * @returns {Promise<{ stdout: string; stderr: string }>}
 */
export function runTool(cmd, args, o) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-8000);
      if (o.liveStderr && process.stderr.isTTY) process.stderr.write(d);
    });
    child.on('error', (e) => {
      if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT')
        reject(new CliError(`${o.tool} not found (${cmd}). ${o.hint}`));
      else reject(e);
    });
    child.on('close', (code) => {
      if (code === 0) return resolveRun({ stdout, stderr });
      reject(new CliError(`${o.tool} failed: ${toolError(stderr, code)}`));
    });
  });
}

const YTDLP_HINT =
  'Install yt-dlp (https://github.com/yt-dlp/yt-dlp#installation, e.g. `pip install -U yt-dlp` or `brew install yt-dlp`) or pass --yt-dlp <path>.';
const FFMPEG_HINT =
  'Install ffmpeg (https://ffmpeg.org/download.html, e.g. `brew install ffmpeg` or `apt install ffmpeg`) or pass --ffmpeg <path>.';
const SIGN_IN =
  /sign in to confirm|not a bot|private video|members[- ]only|confirm your age|age[- ]restricted|cookies/i;

/** @param {string} stderr @param {number | null} code */
function toolError(stderr, code) {
  const lines = stderr.trim().split('\n');
  const line = lines.filter((l) => /ERROR/.test(l)).at(-1) ?? lines.at(-1) ?? `exit code ${code}`;
  const hint = SIGN_IN.test(stderr)
    ? ' — YouTube wants a signed-in account: pass --cookies-from-browser <browser> (one where you are signed in to YouTube) or --cookies <file>.'
    : '';
  return `${line.trim().slice(0, 400)}${hint}`;
}

/** @param {Ctx} ctx @param {string[]} args @param {boolean} [live] */
const ytDlp = (ctx, args, live = false) =>
  runTool(ctx.ytDlp, [...ctx.cookieArgs, ...args], {
    tool: 'yt-dlp',
    hint: YTDLP_HINT,
    liveStderr: live,
  });

/** @param {Ctx} ctx @param {string[]} args */
const ffmpeg = (ctx, args) =>
  runTool(ctx.ffmpeg, ['-nostdin', '-hide_banner', '-y', ...args], {
    tool: 'ffmpeg',
    hint: FFMPEG_HINT,
  });

/** ffprobe next to ffmpeg (same package). @param {string} ffmpegPath */
const ffprobeFor = (ffmpegPath) =>
  ffmpegPath.replace(/ffmpeg(\.exe)?$/i, (_m, ext) => `ffprobe${ext ?? ''}`);

/** Fail early, with an install hint, when a tool is missing. @param {Ctx} ctx @param {boolean} needFfmpeg */
async function checkTools(ctx, needFfmpeg) {
  await runTool(ctx.ytDlp, ['--version'], { tool: 'yt-dlp', hint: YTDLP_HINT });
  if (needFfmpeg) await runTool(ctx.ffmpeg, ['-version'], { tool: 'ffmpeg', hint: FFMPEG_HINT });
}

// ── YouTube ────────────────────────────────────────────────────

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
/** @param {string} id */
const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;

/** yt-dlp's YYYYMMDD as YYYY-MM-DD. @param {unknown} d */
const isoDate = (d) =>
  typeof d === 'string' && /^\d{8}$/.test(d)
    ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
    : undefined;

/**
 * @typedef {{ id: string; url: string; title: string; durationSec: number | null;
 *   uploadDate?: string; private?: boolean }} Video
 */

/** The playlist's videos, read with your cookies (so private ones are included). @param {Ctx} ctx @param {string} url */
async function listPlaylist(ctx, url) {
  const { stdout } = await ytDlp(ctx, [
    '--flat-playlist',
    '--dump-single-json',
    '--no-warnings',
    '--playlist-end',
    String(MAX_PLAYLIST_VIDEOS + 1),
    '--',
    url,
  ]);
  /** @type {{ title?: unknown; entries?: unknown }} */
  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new CliError('yt-dlp returned unreadable playlist data.');
  }
  /** @type {Video[]} */
  const videos = [];
  let unavailable = 0;
  for (const e of Array.isArray(info.entries) ? info.entries : []) {
    const r = /** @type {{ id?: unknown; title?: unknown; duration?: unknown }} */ (e);
    if (typeof r.id !== 'string' || !VIDEO_ID.test(r.id)) continue;
    const title = typeof r.title === 'string' && r.title.trim() ? r.title.trim() : r.id;
    // Entries you cannot watch even signed in.
    if (/^\[(private|deleted) video\]$/i.test(title)) {
      unavailable++;
      continue;
    }
    videos.push({
      id: r.id,
      url: watchUrl(r.id),
      title: title.slice(0, 500),
      durationSec: typeof r.duration === 'number' ? r.duration : null,
    });
  }
  if (videos.length > MAX_PLAYLIST_VIDEOS)
    throw new CliError(`The playlist has more than ${MAX_PLAYLIST_VIDEOS} videos.`);
  return { title: typeof info.title === 'string' ? info.title : null, videos, unavailable };
}

/** @param {Record<string, unknown>} info @param {string} fallbackUrl @returns {Video} */
function videoFromInfo(info, fallbackUrl) {
  const id = typeof info.id === 'string' && VIDEO_ID.test(info.id) ? info.id : null;
  const date = isoDate(info.upload_date);
  return {
    id: id ?? '',
    url: id ? watchUrl(id) : fallbackUrl,
    title: (typeof info.title === 'string' && info.title.trim()
      ? info.title.trim()
      : (id ?? 'video')
    ).slice(0, 500),
    durationSec: typeof info.duration === 'number' ? info.duration : null,
    ...(date ? { uploadDate: date } : {}),
    private: PRIVATE_AVAILABILITY.has(String(info.availability)),
  };
}

/** One video's metadata without downloading. @param {Ctx} ctx @param {string} url */
async function videoInfo(ctx, url) {
  const { stdout } = await ytDlp(ctx, [
    '-f',
    AUDIO_FORMAT,
    '--no-playlist',
    '--skip-download',
    '--dump-json',
    '--no-warnings',
    '--',
    url,
  ]);
  return videoFromInfo(parseLastJson(stdout), url);
}

/** @param {string} stdout @returns {Record<string, unknown>} */
function parseLastJson(stdout) {
  try {
    return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}');
  } catch {
    return {};
  }
}

/**
 * Download one video's best audio as-is into its own folder under the work dir (yt-dlp resumes
 * a partial download there). Returns the file and the video's metadata.
 * @param {Ctx} ctx @param {string} url @param {string} key
 */
async function downloadAudio(ctx, url, key) {
  const dir = join(ctx.workDir, key);
  await mkdir(dir, { recursive: true });
  const { stdout } = await ytDlp(
    ctx,
    [
      '-f',
      AUDIO_FORMAT,
      '--no-playlist',
      '--no-simulate',
      '--dump-json',
      '--progress',
      '-o',
      join(dir, 'audio.%(ext)s'),
      '--',
      url,
    ],
    true,
  );
  const file = (await readdir(dir)).find(
    (f) => f.startsWith('audio.') && /^[a-z0-9]+$/i.test(f.slice(6)),
  );
  if (!file) throw new CliError('yt-dlp finished but produced no audio file.');
  const ext = file.slice('audio.'.length).toLowerCase();
  return {
    dir,
    file: join(dir, file),
    mimeType: MIME_BY_EXT[ext] ?? 'application/octet-stream',
    video: videoFromInfo(parseLastJson(stdout), url),
  };
}

// ── upload one video into a session ────────────────────────────

/**
 * True when the session already has this video's audio stored (a finished upload or server
 * import), so a re-run skips it.
 * @param {Ctx} ctx @param {string} sessionId @param {string} url
 */
async function alreadyUploaded(ctx, sessionId, url) {
  /** @type {{ origin: string; status: string; sourceUrl: string | null }[]} */
  const segments = await ctx.rpc('media.list', { sessionId });
  return segments.some(
    (s) =>
      s.origin === 'youtube' &&
      s.status !== 'uploading' &&
      (s.sourceUrl === null || s.sourceUrl === url),
  );
}

/**
 * Download a video's audio and upload it into a session (media.createUpload origin youtube →
 * PUT → media.completeUpload), then remove the download unless --keep.
 * @param {Ctx} ctx @param {string} sessionId @param {string} url @param {string} label
 */
async function importInto(ctx, sessionId, url, label) {
  say(`${label} downloading…`);
  const dl = await downloadAudio(
    ctx,
    url,
    `video-${new URL(url).searchParams.get('v') ?? sessionId}`,
  );
  const size = (await stat(dl.file)).size;
  const { segment, uploadUrl, headers } = await ctx.rpc('media.createUpload', {
    sessionId,
    mimeType: dl.mimeType,
    origin: 'youtube',
    fileName: dl.file.split(/[\\/]/).at(-1),
    sizeBytes: size,
    youtube: {
      url: dl.video.url,
      title: dl.video.title,
      ...(dl.video.uploadDate ? { uploadDate: dl.video.uploadDate } : {}),
      private: Boolean(dl.video.private),
    },
  });
  let shown = -1;
  await putFile(uploadUrl, headers, dl.file, (sent, total) => {
    const pct = Math.floor((sent / total) * 100);
    if (process.stdout.isTTY && pct !== shown && pct % 10 === 0) {
      shown = pct;
      process.stdout.write(`\r${label} uploading ${mb(total)}… ${pct}%`);
    }
  });
  if (process.stdout.isTTY) process.stdout.write('\n');
  await ctx.rpc('media.completeUpload', {
    segmentId: segment.id,
    ...(dl.video.durationSec ? { durationSec: dl.video.durationSec } : {}),
  });
  if (!ctx.keep) await rm(dl.dir, { recursive: true, force: true });
  say(
    `${label} uploaded ${mb(size)}${dl.video.private ? ' (private video)' : ''}; transcription queued.`,
  );
}

// ── commands ───────────────────────────────────────────────────

/**
 * @typedef {{ sessionId: string | null; title: string; episode: string; videoId: string }} Created
 * @typedef {{ videoId: string; title: string; reason: string; sessionId: string | null }} Skipped
 */

/** @param {Ctx} ctx @param {Args} args */
async function playlistCommand(ctx, args) {
  if (!args.target)
    throw new CliError('Usage: autologger-import playlist <playlist-url> --show <showId>');
  if (!args.show)
    throw new CliError('Pass --show <showId> (shows_list or the show URL in the web app).');
  if (!/[?&]list=/.test(args.target))
    throw new CliError(
      'That is not a playlist URL (it needs a list= parameter). Use the video command for one video.',
    );
  await checkTools(ctx, false);
  say('Reading the playlist with yt-dlp…');
  const list = await listPlaylist(ctx, args.target);
  if (!list.videos.length) throw new CliError('The playlist has no videos you can watch.');
  say(
    `${list.title ?? 'Playlist'}: ${list.videos.length} video${list.videos.length === 1 ? '' : 's'}${list.unavailable ? ` (${list.unavailable} private/deleted left out)` : ''}.`,
  );
  const input = {
    showId: args.show,
    videos: list.videos.map((v) => ({ url: v.url, title: v.title, durationSec: v.durationSec })),
    order: args.order,
    ...(args.titleTemplate ? { titleTemplate: args.titleTemplate } : {}),
  };
  /** @type {{ created: Created[]; skipped: Skipped[] }} */
  const plan = await ctx.rpc('media.importPlaylist', { ...input, dryRun: true });
  for (const c of plan.created) say(`  new     #${c.episode} ${c.title}`);
  for (const s of plan.skipped) say(`  exists  ${s.title} (session ${s.sessionId})`);
  if (ctx.dryRun) {
    say(
      `Dry run: would create ${plan.created.length} session(s) and upload their audio; ${plan.skipped.length} already in the show (their audio is uploaded if missing).`,
    );
    return;
  }
  /** @type {{ created: Created[]; skipped: Skipped[] }} */
  const out = await ctx.rpc('media.importPlaylist', input);
  const todo = [
    ...out.skipped
      .filter((s) => s.sessionId)
      .map((s) => ({
        sessionId: /** @type {string} */ (s.sessionId),
        videoId: s.videoId,
        title: s.title,
        existing: true,
      })),
    ...out.created.map((c) => ({
      sessionId: /** @type {string} */ (c.sessionId),
      videoId: c.videoId,
      title: c.title,
      existing: false,
    })),
  ];
  let done = 0;
  let skipped = 0;
  /** @type {string[]} */
  const failed = [];
  for (const [i, t] of todo.entries()) {
    const label = `[${i + 1}/${todo.length}] ${t.title}:`;
    const url = watchUrl(t.videoId);
    try {
      if (
        t.existing &&
        ((await alreadyUploaded(ctx, t.sessionId, url)) ||
          (await serverImportPending(ctx, t.sessionId)))
      ) {
        skipped++;
        say(`${label} already has its audio; skipped.`);
        continue;
      }
      await importInto(ctx, t.sessionId, url, label);
      done++;
    } catch (e) {
      if (!(e instanceof CliError)) throw e;
      failed.push(t.title);
      say(`${label} FAILED: ${e.message}`);
    }
  }
  say(
    `Done: ${done} uploaded, ${skipped} already there, ${failed.length} failed.${failed.length ? ' Run the same command again to retry them.' : ''}`,
  );
  if (failed.length) throw new CliError(`${failed.length} video(s) failed.`);
}

/** A server-side import of the session is queued or running (don't upload it twice). @param {Ctx} ctx @param {string} sessionId */
async function serverImportPending(ctx, sessionId) {
  const jobs = await ctx.rpc('jobs.list', {
    sessionId,
    kinds: ['youtube_import'],
    status: ['queued', 'running'],
  });
  return Array.isArray(jobs) && jobs.length > 0;
}

/** @param {Ctx} ctx @param {Args} args */
async function videoCommand(ctx, args) {
  if (!args.target)
    throw new CliError(
      'Usage: autologger-import video <video-url> (--show <showId> | --session <sessionId>)',
    );
  if (Boolean(args.show) === Boolean(args.session))
    throw new CliError(
      'Pass exactly one of --show <showId> (new session) or --session <sessionId> (existing session).',
    );
  await checkTools(ctx, false);
  say('Reading the video with yt-dlp…');
  const video = await videoInfo(ctx, args.target);
  if (!video.id) throw new CliError('yt-dlp did not report a YouTube video id for that URL.');
  say(
    `${video.title} (${video.durationSec ? clock(video.durationSec) : 'length unknown'}${video.private ? ', private' : ''})`,
  );
  let sessionId = args.session;
  if (args.show) {
    const input = {
      showId: args.show,
      videos: [
        {
          url: video.url,
          title: video.title,
          durationSec: video.durationSec,
          ...(video.uploadDate ? { uploadDate: video.uploadDate } : {}),
        },
      ],
      ...(args.titleTemplate ? { titleTemplate: args.titleTemplate } : {}),
    };
    /** @type {{ created: Created[]; skipped: Skipped[] }} */
    const out = await ctx.rpc('media.importPlaylist', { ...input, dryRun: ctx.dryRun });
    const created = out.created[0];
    const existing = out.skipped[0];
    if (ctx.dryRun) {
      say(
        created
          ? `Dry run: would create session #${created.episode} "${created.title}" and upload the audio.`
          : `Dry run: the show already has it (session ${existing?.sessionId}); would upload the audio if missing.`,
      );
      return;
    }
    sessionId = created?.sessionId ?? existing?.sessionId ?? undefined;
    if (!sessionId) throw new CliError('AutoLogger did not create a session for the video.');
    say(
      created
        ? `Created session #${created.episode} "${created.title}" (${sessionId}).`
        : `The show already has this video (session ${sessionId}).`,
    );
  } else if (ctx.dryRun) {
    await ctx.rpc('sessions.get', { sessionId });
    say(`Dry run: would upload the audio into session ${sessionId}.`);
    return;
  }
  const id = /** @type {string} */ (sessionId);
  if (await alreadyUploaded(ctx, id, video.url)) {
    say("The session already has this video's audio; nothing to do.");
    return;
  }
  await importInto(ctx, id, video.url, `${video.title}:`);
}

/**
 * @typedef {{ sessionId: string; url: string; fromSec: number; toSec: number }} Source
 * @typedef {{ compilation: { id: string; title: string; status: string; clips: { label?: string }[] };
 *   sources: Source[]; uploadUrl: string; headers: Record<string, string> }} Plan
 */

/** @param {Ctx} ctx @param {Args} args */
async function compileCommand(ctx, args) {
  const compilationId = args.target;
  if (!compilationId) throw new CliError('Usage: autologger-import compile <compilationId>');
  /** @type {Plan} */
  const plan = await ctx.rpc('compilations.createUpload', { compilationId });
  const total = plan.sources.reduce((n, s) => n + s.toSec - s.fromSec, 0);
  say(
    `${plan.compilation.title}: ${plan.sources.length} clip${plan.sources.length === 1 ? '' : 's'}, ${clock(total)}.`,
  );
  for (const [i, s] of plan.sources.entries())
    say(
      `  clip ${i + 1}: ${s.url} ${clock(s.fromSec)}–${clock(s.toSec)}${plan.compilation.clips[i]?.label ? ` ${plan.compilation.clips[i]?.label}` : ''}`,
    );
  if (ctx.dryRun) {
    say('Dry run: would download these sections, encode one 720p MP4 and upload it.');
    return;
  }
  await checkTools(ctx, true);
  const dir = join(ctx.workDir, `compile-${compilationId}`);
  await mkdir(dir, { recursive: true });
  /** @type {string[]} */
  const parts = [];
  const n = plan.sources.length;
  for (const [i, s] of plan.sources.entries()) {
    const part = join(dir, `part-${String(i).padStart(3, '0')}.mp4`);
    parts.push(part);
    if (await exists(part)) {
      say(`[${i + 1}/${n}] already encoded; skipped.`);
      continue;
    }
    say(`[${i + 1}/${n}] downloading ${clock(s.fromSec)}–${clock(s.toSec)}…`);
    const raw = await downloadSection(ctx, s, dir, `raw-${i}`);
    say(`[${i + 1}/${n}] encoding…`);
    const tmp = join(dir, `part-${String(i).padStart(3, '0')}.tmp.mp4`);
    await normalizeClip(ctx, raw, tmp, s.toSec - s.fromSec);
    await rename(tmp, part); // only finished parts count when resuming
    await rm(raw, { force: true });
  }
  say('Joining the clips…');
  const out = join(dir, 'compilation.mp4');
  const listFile = join(dir, 'parts.txt');
  await writeFile(listFile, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  await ffmpeg(ctx, [
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
    out,
  ]);
  const durationSec = await probeDuration(ctx, out);
  const size = (await stat(out)).size;
  // A fresh upload URL: the first one may have expired during the build.
  /** @type {Plan} */
  const upload = await ctx.rpc('compilations.createUpload', { compilationId });
  say(`Uploading ${mb(size)}…`);
  await putFile(upload.uploadUrl, upload.headers, out);
  const ready = await ctx.rpc('compilations.completeUpload', {
    compilationId,
    ...(durationSec ? { durationSec } : {}),
  });
  if (!ctx.keep) await rm(dir, { recursive: true, force: true });
  say(`Ready: "${ready.title}" (${clock(ready.durationSec)}) is on the Compilations page.`);
}

/** @param {string} p */
const exists = (p) =>
  stat(p).then(
    () => true,
    () => false,
  );

/**
 * Download only [fromSec, toSec) of a video with video and audio, as the server's compile job.
 * @param {Ctx} ctx @param {Source} s @param {string} dir @param {string} name
 */
async function downloadSection(ctx, s, dir, name) {
  await ytDlp(
    ctx,
    [
      '-f',
      SECTION_FORMAT,
      '--merge-output-format',
      'mp4',
      '--download-sections',
      `*${s.fromSec.toFixed(3)}-${s.toSec.toFixed(3)}`,
      '--force-keyframes-at-cuts',
      ...(ctx.ffmpeg !== 'ffmpeg' ? ['--ffmpeg-location', ctx.ffmpeg] : []),
      '--no-playlist',
      '--progress',
      '--no-warnings',
      '-o',
      join(dir, `${name}.%(ext)s`),
      '--',
      s.url,
    ],
    true,
  );
  const file = (await readdir(dir)).find(
    (f) => f.startsWith(`${name}.`) && /^[a-z0-9]+$/i.test(f.slice(name.length + 1)),
  );
  if (!file) throw new CliError('yt-dlp finished but produced no video file.');
  return join(dir, file);
}

/**
 * Re-encode one section exactly like the server (normalizeClip): H.264 yuv420p 1280×720
 * letterboxed, 30 fps, AAC stereo 48 kHz, silence when the section has no audio.
 * @param {Ctx} ctx @param {string} input @param {string} output @param {number} maxSec
 */
async function normalizeClip(ctx, input, output, maxSec) {
  const { width: w, height: h, fps, audioRate } = OUTPUT;
  const audio = await hasAudio(ctx, input);
  await ffmpeg(ctx, [
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

/** True when the file has an audio stream (also when ffprobe cannot tell). @param {Ctx} ctx @param {string} file */
async function hasAudio(ctx, file) {
  try {
    const { stdout } = await runTool(
      ffprobeFor(ctx.ffmpeg),
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
      { tool: 'ffprobe', hint: FFMPEG_HINT },
    );
    return stdout.trim().length > 0;
  } catch {
    return true;
  }
}

/** The container duration in seconds, or null. @param {Ctx} ctx @param {string} file */
async function probeDuration(ctx, file) {
  try {
    const { stdout } = await runTool(
      ffprobeFor(ctx.ffmpeg),
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { tool: 'ffprobe', hint: FFMPEG_HINT },
    );
    const n = Number.parseFloat(stdout.trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

// ── youtube-login ──────────────────────────────────────────────

/** A public video yt-dlp opens so it reads (and writes out) the browser's YouTube cookies. */
const COOKIE_EXPORT_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

/**
 * Export the YouTube cookies (yt-dlp `--cookies-from-browser … --cookies <file>`, or the given
 * cookies.txt) and store them as the show's YouTube sign-in on the server
 * (media.setYoutubeCookies, which keeps only the youtube.com / google.com lines).
 * @param {Ctx} ctx @param {Args} args
 */
async function youtubeLoginCommand(ctx, args) {
  if (!args.show === !args.team)
    throw new CliError('youtube-login needs --team <teamId> or --show <showId> (its team).');
  if (!args.cookiesFromBrowser && !args.cookies)
    throw new CliError(
      'youtube-login needs --cookies-from-browser <browser> (one signed in to YouTube) or --cookies <file>.',
    );
  let text;
  if (args.cookies) {
    text = await readFile(resolve(args.cookies), 'utf8').catch((e) => {
      throw new CliError(`Cannot read ${args.cookies}: ${errorText(e)}`);
    });
  } else {
    await checkTools(ctx, false);
    const dir = await mkdtemp(join(tmpdir(), 'autologger-cookies-'));
    const file = join(dir, 'cookies.txt');
    try {
      say(`Reading your YouTube sign-in from ${args.cookiesFromBrowser}…`);
      // yt-dlp writes the cookie jar to --cookies on exit, even when YouTube refuses the video.
      await runTool(
        ctx.ytDlp,
        [
          '--cookies-from-browser',
          /** @type {string} */ (args.cookiesFromBrowser),
          '--cookies',
          file,
          '--skip-download',
          '--no-warnings',
          '--quiet',
          COOKIE_EXPORT_URL,
        ],
        { tool: 'yt-dlp', hint: YTDLP_HINT },
      ).catch(() => {});
      text = await readFile(file, 'utf8').catch(() => {
        throw new CliError(
          `yt-dlp could not read cookies from ${args.cookiesFromBrowser}. Close the browser (Chrome locks its cookie database) or try another browser or profile (e.g. chrome:Profile 1).`,
        );
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const target = args.team ? `team ${args.team}` : `the team of show ${args.show}`;
  if (ctx.dryRun) {
    const n = text.split('\n').filter((l) => /(^|\.)(youtube|google)\.com\t/.test(l)).length;
    say(`Dry run: would send ${n} youtube.com/google.com cookies to ${target}.`);
    return;
  }
  /** @type {{ teamId: string; teamName: string; check: { ok: boolean; message: string } | null; expiresAt: string | null }} */
  const r = await ctx.rpc('media.setYoutubeCookies', {
    ...(args.team ? { teamId: args.team } : { showId: args.show }),
    cookies: text,
  });
  say(
    `Saved the YouTube sign-in for team ${r.teamName || r.teamId}; all its shows download with it.`,
  );
  if (r.check) say(`${r.check.ok ? '✓' : '✗'} ${r.check.message}`);
  if (r.expiresAt)
    say(`The cookies expire by ${r.expiresAt.slice(0, 10)} (YouTube may sign them out sooner).`);
  say(
    'Signing out of YouTube in that browser ends the server’s sign-in too. YouTube also rotates the cookies of open YouTube tabs, which can expire the server’s copy: a browser profile used only for this, or cookies exported from a private window you then close, last longest.',
  );
}

// ── main ───────────────────────────────────────────────────────

/**
 * Run the CLI. Returns the exit code (0 ok, 1 failed, 2 usage).
 * @param {string[]} argv @param {NodeJS.ProcessEnv} [env]
 */
export async function main(argv, env = process.env) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${/** @type {Error} */ (e).message}\n`);
    return 2;
  }
  if (args.help || !args.command) {
    say(USAGE);
    return args.help ? 0 : 2;
  }
  const commands = {
    playlist: playlistCommand,
    video: videoCommand,
    compile: compileCommand,
    'youtube-login': youtubeLoginCommand,
  };
  const command = commands[/** @type {keyof typeof commands} */ (args.command)];
  if (!command) {
    process.stderr.write(
      `Unknown command ${args.command}. Commands: playlist, video, compile, youtube-login. See --help.\n`,
    );
    return 2;
  }
  const baseUrl = env.AUTOLOGGER_URL?.trim().replace(/\/+$/, '');
  const token = env.AUTOLOGGER_TOKEN?.trim();
  if (!baseUrl || !/^https?:\/\//.test(baseUrl) || !token) {
    process.stderr.write(
      'Set AUTOLOGGER_URL (e.g. https://autologger.example.com) and AUTOLOGGER_TOKEN (a personal access token from Settings › Agents).\n',
    );
    return 2;
  }
  if (args.cookies && args.cookiesFromBrowser) {
    process.stderr.write('Pass --cookies-from-browser or --cookies, not both.\n');
    return 2;
  }
  /** @type {Ctx} */
  const ctx = {
    ytDlp: args.ytDlp ?? env.YTDLP_PATH ?? 'yt-dlp',
    ffmpeg: args.ffmpeg ?? env.FFMPEG_PATH ?? 'ffmpeg',
    cookieArgs: args.cookiesFromBrowser
      ? ['--cookies-from-browser', args.cookiesFromBrowser]
      : args.cookies
        ? ['--cookies', resolve(args.cookies)]
        : [],
    workDir: resolve(
      args.workDir ?? join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'autologger-import'),
    ),
    keep: args.keep,
    dryRun: args.dryRun,
    rpc: makeRpc(baseUrl, token),
  };
  try {
    await command(ctx, args);
    return 0;
  } catch (e) {
    if (e instanceof CliError) {
      process.stderr.write(`Error: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

// Run when executed (also through a symlink such as an npm bin), not when imported by the tests.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
