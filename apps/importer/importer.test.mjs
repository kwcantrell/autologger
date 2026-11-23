// The import helper end to end against fakes: yt-dlp, ffmpeg and ffprobe are small Node scripts,
// AutoLogger is a stub HTTP server on localhost. No network, no real YouTube.

import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs, youtubeCookiesOnly } from './autologger-import.mjs';

const CLI = fileURLToPath(new URL('./autologger-import.mjs', import.meta.url));
const TOKEN = 'alp_test';

// ── fakes ──────────────────────────────────────────────────────

const FAKE_YTDLP = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(['yt-dlp', ...args]) + '\\n');
if (args.includes('--version')) { console.log('2025.01.01'); process.exit(0); }
if (process.env.FAKE_BOT_CHECK) {
  console.error("ERROR: [youtube] aaaaaaaaaaa: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication.");
  process.exit(1);
}
const videos = JSON.parse(fs.readFileSync(process.env.FAKE_VIDEOS, 'utf8'));
const url = args.at(-1);
if (args.includes('--flat-playlist')) {
  console.log(JSON.stringify({ title: 'Tom Talks', entries: Object.values(videos).map((v) => ({ id: v.id, title: v.title, duration: v.duration })).concat([{ id: 'ddddddddddd', title: '[Private video]' }]) }));
  process.exit(0);
}
const id = /(?:[?&]v=|youtu\\.be\\/)([\\w-]{11})/.exec(url)?.[1];
const info = videos[id];
const out = args[args.indexOf('-o') + 1];
if (args.includes('--download-sections')) {
  fs.writeFileSync(out.replace('%(ext)s', 'mp4'), 'section');
  process.exit(0);
}
if (args.includes('--no-simulate')) fs.writeFileSync(out.replace('%(ext)s', 'm4a'), 'x'.repeat(5000));
// Like real yt-dlp, --progress output follows the JSON on stdout, joined by \\r.
process.stdout.write(JSON.stringify(info) + (args.includes('--progress') ? '\\r[download] 100% of 5.00KiB\\n' : '\\n'));
`;

const FAKE_FFMPEG = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(['ffmpeg', ...args]) + '\\n');
if (args.includes('-version')) { console.log('ffmpeg version 7'); process.exit(0); }
fs.writeFileSync(args.at(-1), 'mp4 bytes');
`;

const FAKE_FFPROBE = `#!/usr/bin/env node
const args = process.argv.slice(2);
console.log(args.includes('format=duration') ? '42.5' : '1');
`;

const VIDEOS = {
  aaaaaaaaaaa: {
    id: 'aaaaaaaaaaa',
    title: 'Episode One',
    duration: 600,
    upload_date: '20240105',
    availability: 'private',
  },
  bbbbbbbbbbb: {
    id: 'bbbbbbbbbbb',
    title: 'Episode Two',
    duration: 700,
    upload_date: '20240112',
    availability: 'unlisted',
  },
};

// ── stub AutoLogger ────────────────────────────────────────────

/** @type {{ calls: { op: string; input: any }[]; sessions: Map<string, string>; segments: any[]; puts: Map<string, number>; bodies: Map<string, string> }} */
const state = { calls: [], sessions: new Map(), segments: [], puts: new Map(), bodies: new Map() };
let base = '';

/** @param {string} op @param {any} input */
function handle(op, input) {
  state.calls.push({ op, input });
  switch (op) {
    case 'media.importPlaylist': {
      const created = [];
      const skipped = [];
      for (const v of input.videos) {
        const videoId = /v=([\w-]{11})/.exec(v.url)[1];
        const existing = state.sessions.get(videoId);
        if (existing) {
          skipped.push({
            videoId,
            title: v.title,
            reason: 'already_imported',
            sessionId: existing,
          });
          continue;
        }
        const sessionId = input.dryRun ? null : `ses_${videoId}`;
        if (sessionId) state.sessions.set(videoId, sessionId);
        created.push({ sessionId, title: v.title, episode: String(created.length + 1), videoId });
      }
      return { playlistTitle: null, dryRun: Boolean(input.dryRun), created, skipped };
    }
    case 'media.list':
      return state.segments.filter((s) => s.sessionId === input.sessionId);
    case 'jobs.list':
    case 'sessions.get':
      return op === 'jobs.list' ? [] : { id: input.sessionId };
    case 'media.createUpload': {
      const segment = {
        id: `aud_${state.segments.length}`,
        sessionId: input.sessionId,
        origin: 'youtube',
        status: 'uploading',
        sourceUrl: input.youtube.url,
      };
      state.segments.push(segment);
      return {
        segment,
        uploadUrl: `${base}/put/${segment.id}`,
        headers: { 'Content-Type': input.mimeType },
      };
    }
    case 'media.importFiles':
      return {
        dryRun: input.dryRun,
        files: input.files.map((f) => {
          const prior = state.segments.find(
            (s) => s.fileName === f.fileName && s.sizeBytes === f.sizeBytes,
          );
          if (prior)
            return {
              fileName: f.fileName,
              status: prior.status === 'uploading' ? 'resumed' : 'skipped',
              sessionId: prior.sessionId,
              segmentId: prior.id,
              title: prior.title,
              episode: null,
            };
          const title = f.title ?? f.fileName.replace(/\.[^.]+$/, '');
          if (input.dryRun)
            return {
              fileName: f.fileName,
              status: 'created',
              sessionId: null,
              segmentId: null,
              title,
              episode: null,
            };
          const seg = {
            id: `aud_${state.segments.length}`,
            sessionId: `ses_f${state.segments.length}`,
            origin: 'file',
            status: 'uploading',
            fileName: f.fileName,
            sizeBytes: f.sizeBytes,
            title,
            input: f,
          };
          state.segments.push(seg);
          // Files over 8 bytes go up in parts of 8 (the server's are 32 MiB).
          const upload =
            f.sizeBytes > 8
              ? {
                  headers: {},
                  parts: Array.from({ length: Math.ceil(f.sizeBytes / 8) }, (_, i) => ({
                    partNumber: i + 1,
                    offset: i * 8,
                    sizeBytes: Math.min(8, f.sizeBytes - i * 8),
                    url: `${base}/put/${seg.id}.${i + 1}`,
                  })),
                }
              : { uploadUrl: `${base}/put/${seg.id}`, headers: { 'Content-Type': f.mimeType } };
          return {
            fileName: f.fileName,
            status: 'created',
            sessionId: seg.sessionId,
            segmentId: seg.id,
            title,
            episode: '1',
            upload,
          };
        }),
      };
    case 'media.completeUploads': {
      const completed = [];
      for (const id of input.segmentIds) {
        const seg = state.segments.find((s) => s.id === id);
        const body =
          state.bodies.get(id) ??
          [...state.bodies]
            .filter(([k]) => k.startsWith(`${id}.`))
            .sort(([a], [b]) => Number(a.split('.')[1]) - Number(b.split('.')[1]))
            .map(([, v]) => v)
            .join('');
        seg.status = 'ready';
        seg.stored = body;
        completed.push(seg);
      }
      return { completed, pending: [] };
    }
    case 'media.completeUpload': {
      const seg = state.segments.find((s) => s.id === input.segmentId);
      if (!state.puts.has(seg.id)) throw { code: 'conflict', message: 'not uploaded' };
      seg.status = 'ready';
      return seg;
    }
    case 'compilations.createUpload':
      return {
        compilation: {
          id: input.compilationId,
          title: 'Best bits',
          status: 'queued',
          clips: [{ label: 'Intro' }, {}],
        },
        sources: [
          {
            sessionId: 'ses_a',
            url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
            fromSec: 10,
            toSec: 40,
          },
          {
            sessionId: 'ses_b',
            url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb',
            fromSec: 5,
            toSec: 17.5,
          },
        ],
        uploadUrl: `${base}/put/${input.compilationId}`,
        headers: { 'Content-Type': 'video/mp4' },
      };
    case 'compilations.completeUpload':
      return {
        id: input.compilationId,
        title: 'Best bits',
        status: 'ready',
        durationSec: input.durationSec ?? 0,
      };
    default:
      throw { code: 'not_found', message: `no op ${op}` };
  }
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const put = /^\/put\/(.+)$/.exec(req.url ?? '');
    if (req.method === 'PUT' && put) {
      state.puts.set(put[1], body.length);
      state.bodies.set(put[1], body);
      res.writeHead(200).end();
      return;
    }
    const send = (status, json) =>
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
    if (req.headers.authorization !== `Bearer ${TOKEN}`)
      return send(401, {
        ok: false,
        error: { code: 'unauthenticated', message: 'Sign in first.' },
      });
    const op = /^\/api\/rpc\/(.+)$/.exec(req.url ?? '')?.[1];
    try {
      send(200, { ok: true, data: handle(op, JSON.parse(body)) });
    } catch (e) {
      send(e.code === 'conflict' ? 409 : 404, { ok: false, error: e });
    }
  });
});

// ── harness ────────────────────────────────────────────────────

let dir = '';
let env = {};

/** Run the CLI; resolves with its exit code and output. @param {string[]} args @param {Record<string, string>} [extra] */
function cli(args, extra = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...env, ...extra } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function toolCalls() {
  return (await readFile(join(dir, 'log.jsonl'), 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'autologger-import-test-'));
  const bin = join(dir, 'bin');
  await mkdir(bin);
  for (const [name, src] of [
    ['yt-dlp', FAKE_YTDLP],
    ['ffmpeg', FAKE_FFMPEG],
    ['ffprobe', FAKE_FFPROBE],
  ]) {
    await writeFile(join(bin, name), src);
    await chmod(join(bin, name), 0o755);
  }
  await writeFile(join(dir, 'videos.json'), JSON.stringify(VIDEOS));
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  env = {
    PATH: process.env.PATH,
    HOME: dir,
    AUTOLOGGER_URL: base,
    AUTOLOGGER_TOKEN: TOKEN,
    YTDLP_PATH: join(bin, 'yt-dlp'),
    FFMPEG_PATH: join(bin, 'ffmpeg'),
    FAKE_LOG: join(dir, 'log.jsonl'),
    FAKE_VIDEOS: join(dir, 'videos.json'),
  };
});

afterAll(() => new Promise((r) => server.close(() => r(undefined))));

beforeEach(async () => {
  state.calls = [];
  state.sessions.clear();
  state.segments = [];
  state.puts.clear();
  state.bodies.clear();
  await writeFile(join(dir, 'log.jsonl'), '');
});

const PLAYLIST = 'https://www.youtube.com/playlist?list=PLtomtalks01';
const ops = () => state.calls.map((c) => c.op);

describe('autologger-import', () => {
  it('parses commands and options', () => {
    expect(
      parseArgs(['video', 'u', '--session=ses_1', '--cookies-from-browser', 'firefox']),
    ).toMatchObject({
      command: 'video',
      target: 'u',
      session: 'ses_1',
      cookiesFromBrowser: 'firefox',
    });
    expect(() => parseArgs(['playlist', '--show'])).toThrow('--show needs a value');
  });

  it('imports a playlist: sessions, uploads with provenance, cookie passthrough; a re-run resumes', async () => {
    const r = await cli([
      'playlist',
      PLAYLIST,
      '--show',
      'shw_1',
      '--cookies-from-browser',
      'firefox',
    ]);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('2 videos (1 private/deleted left out)');
    expect(r.stdout).toContain('Done: 2 uploaded, 0 already there, 0 failed.');
    const created = state.calls.filter((c) => c.op === 'media.importPlaylist');
    expect(created.map((c) => c.input.dryRun ?? false)).toEqual([true, false]);
    expect(created[1].input.videos).toEqual([
      {
        url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
        title: 'Episode One',
        durationSec: 600,
      },
      {
        url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb',
        title: 'Episode Two',
        durationSec: 700,
      },
    ]);
    const uploads = state.calls.filter((c) => c.op === 'media.createUpload').map((c) => c.input);
    expect(uploads[0]).toMatchObject({
      sessionId: 'ses_aaaaaaaaaaa',
      origin: 'youtube',
      mimeType: 'audio/mp4',
      sizeBytes: 5000,
      youtube: {
        url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
        title: 'Episode One',
        uploadDate: '2024-01-05',
        private: true,
      },
    });
    expect(uploads[1].youtube.private).toBe(false);
    expect(
      state.calls.filter((c) => c.op === 'media.completeUpload').map((c) => c.input.durationSec),
    ).toEqual([600, 700]);
    expect([...state.puts.values()]).toEqual([5000, 5000]);
    for (const call of (await toolCalls()).filter(
      (c) => c[0] === 'yt-dlp' && !c.includes('--version'),
    ))
      expect(call.slice(1, 3)).toEqual(['--cookies-from-browser', 'firefox']);

    state.calls = [];
    const again = await cli(['playlist', PLAYLIST, '--show', 'shw_1']);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('Done: 0 uploaded, 2 already there, 0 failed.');
    expect(ops()).not.toContain('media.createUpload');
  });

  it('--dry-run creates and uploads nothing', async () => {
    const r = await cli(['playlist', PLAYLIST, '--show', 'shw_1', '--dry-run']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Dry run: would create 2 session(s)');
    expect(ops()).toEqual(['media.importPlaylist']);
    expect(state.calls[0].input.dryRun).toBe(true);
  });

  it('imports one video into an existing session', async () => {
    const r = await cli([
      'video',
      'https://youtu.be/bbbbbbbbbbb',
      '--session',
      'ses_x',
      '--cookies',
      'c.txt',
    ]);
    expect(r.code).toBe(0);
    expect(ops()).toEqual(['media.list', 'media.createUpload', 'media.completeUpload']);
    expect(state.calls[1].input).toMatchObject({
      sessionId: 'ses_x',
      youtube: { title: 'Episode Two', uploadDate: '2024-01-12' },
    });
    const ytdlp = (await toolCalls()).find((c) => c.includes('--skip-download'));
    expect(ytdlp.slice(1, 3)).toEqual(['--cookies', join(process.cwd(), 'c.txt')]);
    expect(state.calls[2].input.transcribe).toBeUndefined();
  });

  it('--no-transcribe uploads the audio without transcription', async () => {
    const r = await cli(['playlist', PLAYLIST, '--show', 'shw_1', '--no-transcribe']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('not transcribed (--no-transcribe)');
    const done = state.calls.filter((c) => c.op === 'media.completeUpload');
    expect(done.map((c) => c.input.transcribe)).toEqual([false, false]);
  });

  it('builds a compilation locally like the worker and uploads it; resumes encoded clips', async () => {
    const work = join(dir, 'work');
    await mkdir(join(work, 'compile-cmp_1'), { recursive: true });
    await writeFile(join(work, 'compile-cmp_1', 'part-000.mp4'), 'done before');
    const r = await cli(['compile', 'cmp_1', '--work-dir', work]);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('[1/2] already encoded; skipped.');
    expect(r.stdout).toContain('Ready: "Best bits"');
    const calls = await toolCalls();
    const sections = calls.filter((c) => c.includes('--download-sections'));
    expect(sections).toHaveLength(1);
    expect(sections[0][sections[0].indexOf('--download-sections') + 1]).toBe('*5.000-17.500');
    const encode = calls.find((c) => c[0] === 'ffmpeg' && c.includes('libx264'));
    expect(encode.join(' ')).toContain('scale=1280:720:force_original_aspect_ratio=decrease');
    expect(encode.join(' ')).toContain('-c:a aac');
    expect(encode[encode.indexOf('-t') + 1]).toBe('12.500');
    expect(calls.some((c) => c[0] === 'ffmpeg' && c.includes('concat'))).toBe(true);
    expect(ops()).toEqual([
      'compilations.createUpload',
      'compilations.createUpload',
      'compilations.completeUpload',
    ]);
    expect(state.calls[2].input).toEqual({ compilationId: 'cmp_1', durationSec: 42.5 });
    expect(state.puts.get('cmp_1')).toBe('mp4 bytes'.length);
  });

  it('explains missing tools, the bot check, bad config and a rejected token', async () => {
    const noYtDlp = await cli(['playlist', PLAYLIST, '--show', 'shw_1'], {
      YTDLP_PATH: join(dir, 'nope'),
    });
    expect(noYtDlp.code).toBe(1);
    expect(noYtDlp.stderr).toContain('yt-dlp not found');
    expect(noYtDlp.stderr).toContain('Install yt-dlp');

    const noFfmpeg = await cli(['compile', 'cmp_1'], { FFMPEG_PATH: join(dir, 'nope') });
    expect(noFfmpeg.code).toBe(1);
    expect(noFfmpeg.stderr).toContain('ffmpeg not found');

    const bot = await cli(
      ['video', 'https://www.youtube.com/watch?v=aaaaaaaaaaa', '--session', 's'],
      { FAKE_BOT_CHECK: '1' },
    );
    expect(bot.code).toBe(1);
    expect(bot.stderr).toContain('pass --cookies-from-browser <browser>');

    const noEnv = await cli(['compile', 'cmp_1'], { AUTOLOGGER_TOKEN: '' });
    expect(noEnv.code).toBe(2);
    expect(noEnv.stderr).toContain('AUTOLOGGER_TOKEN');

    const badToken = await cli(['compile', 'cmp_1'], { AUTOLOGGER_TOKEN: 'alp_wrong' });
    expect(badToken.code).toBe(1);
    expect(badToken.stderr).toContain('Settings › Agents');
  });
});

describe('autologger-import files', () => {
  it('imports a folder and a CSV manifest: sessions, part uploads, completion; a re-run skips', async () => {
    const folder = join(dir, 'archive');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'ep2.mp3'), 'small');
    await writeFile(join(folder, 'ep10.flac'), 'a large flac file body');
    await writeFile(join(folder, 'notes.txt'), 'ignored');
    const run = await cli(['files', folder, '--show', 'shw_1', '--no-transcribe']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const imp = state.calls.find((c) => c.op === 'media.importFiles');
    expect(imp?.input.files.map((f) => [f.fileName, f.mimeType, f.sizeBytes])).toEqual([
      ['ep2.mp3', 'audio/mpeg', 5],
      ['ep10.flac', 'audio/flac', 22],
    ]);
    const done = state.calls.find((c) => c.op === 'media.completeUploads');
    expect(done?.input).toEqual({ segmentIds: expect.any(Array), transcribe: false });
    expect(state.segments.map((s) => [s.fileName, s.status, s.stored])).toEqual([
      ['ep2.mp3', 'ready', 'small'],
      ['ep10.flac', 'ready', 'a large flac file body'],
    ]);

    state.calls.length = 0;
    const again = await cli(['files', folder, '--show', 'shw_1']);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('2 already there');
    expect(state.calls.map((c) => c.op)).toEqual(['media.importFiles']);

    await writeFile(join(dir, 'ep3.wav'), 'wave');
    await writeFile(
      join(dir, 'manifest.csv'),
      'file,title,episode,episodeDate,keyTerms\nep3.wav,"Three, with a comma",3,2019-05-01,Tom; Jerry\n',
    );
    state.calls.length = 0;
    const csv = await cli(['files', join(dir, 'manifest.csv'), '--show', 'shw_1']);
    expect(csv.code).toBe(0);
    expect(state.calls.find((c) => c.op === 'media.importFiles')?.input.files).toEqual([
      {
        fileName: 'ep3.wav',
        sizeBytes: 4,
        mimeType: 'audio/wav',
        title: 'Three, with a comma',
        episode: '3',
        episodeDate: '2019-05-01',
        keyTerms: ['Tom', 'Jerry'],
      },
    ]);
  });
});

describe('youtube-login cookie filter', () => {
  it('keeps only youtube.com / google.com cookies before anything is sent', () => {
    const jar = [
      '# Netscape HTTP Cookie File',
      '.youtube.com\tTRUE\t/\tTRUE\t0\tSID\ts',
      '#HttpOnly_.google.com\tTRUE\t/\tTRUE\t0\tHSID\th',
      '.mybank.example\tTRUE\t/\tTRUE\t0\tsession\tbank',
      'mail.example\tFALSE\t/\tTRUE\t0\tauth\tmail',
      '.youtube.com.evil.example\tTRUE\t/\tTRUE\t0\tSID\tevil',
    ].join('\n');
    const r = youtubeCookiesOnly(jar);
    expect(r).toMatchObject({ count: 2, signedIn: true });
    expect(r.kept).not.toMatch(/bank|mail|evil/);
    const json = youtubeCookiesOnly(
      JSON.stringify([
        { domain: '.youtube.com', name: 'VISITOR_INFO1_LIVE', value: 'v' },
        { domain: '.mybank.example', name: 'session', value: 'bank' },
      ]),
    );
    expect(json).toMatchObject({ count: 1, signedIn: false });
    expect(json.kept).not.toContain('bank');
  });
});
