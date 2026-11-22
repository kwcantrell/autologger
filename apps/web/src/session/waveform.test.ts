import { describe, expect, it } from 'vitest';
import { columnPeaks, decodePeaksFile } from './waveform';

describe('waveform columns', () => {
  it('places each segment at its startSec and takes the max per column', () => {
    // Two segments of 2 s at 2 peaks/s: one at 0 s, one at 6 s (a gap from 2 to 6 s).
    const a = decodePeaksFile('a', 0, {
      version: 1,
      peaksPerSec: 2,
      peaks: btoa(String.fromCharCode(10, 255, 0, 51)),
    })!;
    const b = {
      segmentId: 'b',
      startSec: 6,
      peaksPerSec: 2,
      peaks: Uint8Array.from([102, 0, 0, 204]),
    };
    // 8 columns of 1 s over 0–8 s.
    const cols = [...columnPeaks([a, b], 0, 8, 8)].map((v) => Math.round(v * 255));
    expect(cols).toEqual([255, 51, 0, 0, 0, 0, 102, 204]);
    // Zoomed into 6–7 s: two columns, one per bucket.
    expect([...columnPeaks([a, b], 6, 7, 2)].map((v) => Math.round(v * 255))).toEqual([102, 0]);
  });
});
