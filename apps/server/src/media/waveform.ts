// Waveform peaks for the session timeline. The worker decodes a segment's audio with ffmpeg to
// 8 kHz mono 16-bit PCM and keeps the largest absolute sample of every 50 ms window, scaled to
// one byte. The result is stored as `sessions/<sessionId>/<segmentId>.peaks.json` next to the
// audio; bucket i covers [i / PEAKS_PER_SEC, (i + 1) / PEAKS_PER_SEC) seconds of the segment's
// own media time, so it sits at session second `segment.startSec + i / PEAKS_PER_SEC`.

import { spawn } from 'node:child_process';
import { PermanentError } from './deepgram.ts';

export const PEAKS_PER_SEC = 20;
/** Decode rate: plenty for a peak envelope, and 16 kB/s of PCM through the pipe. */
export const PCM_RATE = 8000;
const SAMPLES_PER_PEAK = PCM_RATE / PEAKS_PER_SEC;
/** ffmpeg gets this long per job (a long YouTube import decodes in well under a minute). */
const FFMPEG_TIMEOUT_MS = 30 * 60_000;

/** The stored peaks object (version 1). */
export interface PeaksFile {
  version: 1;
  peaksPerSec: number;
  /** Decoded length of the segment's audio in seconds. */
  durationSec: number;
  /** Base64 of one unsigned byte per bucket: max |sample| scaled linearly to 0–255. */
  peaks: string;
}

/**
 * Streams signed 16-bit little-endian mono PCM in arbitrary chunks (odd byte counts included) and
 * collects one peak per SAMPLES_PER_PEAK samples. The last bucket may be partial.
 */
export class PeakAccumulator {
  private peaks: number[] = [];
  private current = 0;
  private inBucket = 0;
  private carry: number | null = null;
  samples = 0;

  push(chunk: Uint8Array): void {
    let i = 0;
    if (this.carry !== null && chunk.length > 0) {
      this.sample(this.carry | (chunk[0]! << 8));
      this.carry = null;
      i = 1;
    }
    for (; i + 1 < chunk.length; i += 2) this.sample(chunk[i]! | (chunk[i + 1]! << 8));
    if (i < chunk.length) this.carry = chunk[i]!;
  }

  private sample(u16: number): void {
    const v = u16 >= 0x8000 ? u16 - 0x10000 : u16;
    const abs = v < 0 ? -v : v;
    if (abs > this.current) this.current = abs;
    this.samples++;
    if (++this.inBucket === SAMPLES_PER_PEAK) this.flush();
  }

  private flush(): void {
    this.peaks.push(Math.min(255, Math.round((this.current / 32768) * 255)));
    this.current = 0;
    this.inBucket = 0;
  }

  finish(): { peaks: Uint8Array; durationSec: number } {
    if (this.inBucket > 0) this.flush();
    return { peaks: Uint8Array.from(this.peaks), durationSec: this.samples / PCM_RATE };
  }
}

export function encodePeaks(peaks: Uint8Array, durationSec: number): string {
  const file: PeaksFile = {
    version: 1,
    peaksPerSec: PEAKS_PER_SEC,
    durationSec: Math.round(durationSec * 1000) / 1000,
    peaks: Buffer.from(peaks).toString('base64'),
  };
  return JSON.stringify(file);
}

export function decodePeaks(json: string): {
  peaksPerSec: number;
  durationSec: number;
  peaks: Uint8Array;
} {
  const f = JSON.parse(json) as PeaksFile;
  return {
    peaksPerSec: f.peaksPerSec,
    durationSec: f.durationSec,
    peaks: new Uint8Array(Buffer.from(f.peaks, 'base64')),
  };
}

/** ffmpeg stderr when the input has no (decodable) audio: retrying won't help. */
const NO_AUDIO =
  /does not contain any stream|matches no streams|Output file .* does not contain|Invalid data found when processing input/i;

/** Replace URLs (presigned, with their signature) in text bound for jobs.error or logs. */
export function redactUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/g, '<object url>');
}

const ffmpegChecks = new Map<string, Promise<boolean>>();

/** Whether `ffmpeg -version` runs (cached per path for the process lifetime). */
export function ffmpegAvailable(ffmpegPath: string): Promise<boolean> {
  let p = ffmpegChecks.get(ffmpegPath);
  if (!p) {
    p = new Promise<boolean>((resolve) => {
      const child = spawn(ffmpegPath, ['-version'], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });
    ffmpegChecks.set(ffmpegPath, p);
  }
  return p;
}

/**
 * Decode `input` (a file path or an http(s) URL — ffmpeg seeks with range requests, so MP4 with
 * the index at the end works) and return its peaks.
 */
export function computePeaks(
  ffmpegPath: string,
  input: string,
): Promise<{ peaks: Uint8Array; durationSec: number }> {
  return new Promise((resolve, reject) => {
    const acc = new PeakAccumulator();
    const child = spawn(
      ffmpegPath,
      [
        '-nostdin',
        '-v',
        'error',
        ...(/^https?:/.test(input)
          ? [
              // Give up on a stalled connection after 30 s; resume dropped ones.
              '-rw_timeout',
              '30000000',
              '-reconnect',
              '1',
              '-reconnect_streamed',
              '1',
              '-reconnect_delay_max',
              '5',
            ]
          : []),
        '-protocol_whitelist',
        'file,http,https,tcp,tls,crypto',
        '-i',
        input,
        '-vn',
        '-ac',
        '1',
        '-ar',
        String(PCM_RATE),
        '-f',
        's16le',
        '-',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: FFMPEG_TIMEOUT_MS },
    );
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => acc.push(d));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT')
        reject(new PermanentError(`ffmpeg not found (FFMPEG_PATH=${ffmpegPath}).`));
      else reject(e);
    });
    child.on('close', (code, signal) => {
      if (code === 0) return resolve(acc.finish());
      // ffmpeg echoes the input URL, presigned signature included: never store or log it.
      const last = redactUrls(stderr.trim().split('\n').at(-1) ?? '').slice(0, 300);
      if (signal) reject(new Error(`ffmpeg stopped (${signal}) before decoding finished.`));
      else if (NO_AUDIO.test(stderr))
        reject(new PermanentError(`The file has no audio stream ffmpeg can decode: ${last}`));
      // Retried: reading the object over HTTP can fail transiently.
      else reject(new Error(`ffmpeg exited with code ${code}${last ? `: ${last}` : ''}`));
    });
  });
}
