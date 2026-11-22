// YouTube import via yt-dlp. Downloads the best audio-only stream as-is (no ffmpeg re-encode).

import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  cleanup(): Promise<void>;
}

function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
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

export async function downloadAudio(ytDlpPath: string, url: string): Promise<Download> {
  const dir = await mkdtemp(join(tmpdir(), 'autologger-yt-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    const { stdout } = await run(ytDlpPath, [
      '-f',
      'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
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
    let info: { title?: string; duration?: number } = {};
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
      cleanup,
    };
  } catch (e) {
    await cleanup();
    throw e;
  }
}
