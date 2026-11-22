// Waveform peaks for the timeline (media.waveform): fetch each segment's peaks object from its
// presigned URL, decode it, and reduce the visible part to one peak per pixel column.

import type { AudioSegment } from '@autologger/contract';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { qk } from '@/api/queries';
import { rpc } from '@/api/rpc';

export interface SegmentPeaks {
  segmentId: string;
  /** Session second of peak 0. */
  startSec: number;
  peaksPerSec: number;
  /** One byte per 1/peaksPerSec s: max |sample| scaled to 0–255. */
  peaks: Uint8Array;
}

interface PeaksFile {
  version: number;
  peaksPerSec: number;
  peaks: string;
}

export function decodePeaksFile(
  segmentId: string,
  startSec: number,
  f: PeaksFile,
): SegmentPeaks | null {
  if (f.version !== 1 || !(f.peaksPerSec > 0) || typeof f.peaks !== 'string') return null;
  const bin = atob(f.peaks);
  const peaks = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) peaks[i] = bin.charCodeAt(i);
  return { segmentId, startSec, peaksPerSec: f.peaksPerSec, peaks };
}

/**
 * Peak per column for `columns` equal slices of [fromSec, toSec), 0–1. Each column takes the
 * largest bucket it overlaps across all segments (overlapping segments draw the louder one;
 * gaps are 0). Cost: the visible buckets plus the columns.
 */
export function columnPeaks(
  list: SegmentPeaks[],
  fromSec: number,
  toSec: number,
  columns: number,
): Float32Array {
  const out = new Float32Array(Math.max(0, columns));
  const span = toSec - fromSec;
  if (!(span > 0) || columns <= 0) return out;
  const perCol = span / columns;
  for (const s of list) {
    const n = s.peaks.length;
    const rate = s.peaksPerSec;
    const first = Math.max(0, Math.floor((s.startSec - fromSec) / perCol));
    const last = Math.min(columns - 1, Math.floor((s.startSec + n / rate - fromSec) / perCol));
    for (let x = first; x <= last; x++) {
      const t0 = fromSec + x * perCol - s.startSec;
      let i0 = Math.max(0, Math.floor(t0 * rate));
      const i1 = Math.min(n, Math.max(i0 + 1, Math.ceil((t0 + perCol) * rate)));
      let m = 0;
      for (; i0 < i1; i0++) if (s.peaks[i0]! > m) m = s.peaks[i0]!;
      if (m / 255 > out[x]!) out[x] = m / 255;
    }
  }
  return out;
}

/**
 * The session's peaks. Keyed on which segments have peaks (and where they start), so a segment
 * update over the session socket that sets hasWaveform refetches; otherwise fetched once.
 */
export function useWaveform(sessionId: string, segments: AudioSegment[]) {
  const ready = segments
    .filter((s) => s.hasWaveform)
    .map((s) => `${s.id}@${s.startSec}`)
    .sort()
    .join(',');
  return useQuery({
    queryKey: qk.waveform(sessionId, ready),
    enabled: ready !== '',
    staleTime: Number.POSITIVE_INFINITY,
    // Keep drawing the segments we have while a newly computed one loads.
    placeholderData: keepPreviousData,
    retry: 1,
    queryFn: async () => {
      const list = await rpc('media.waveform', { sessionId });
      const out = await Promise.all(
        list.map(async (w) => {
          const r = await fetch(w.url);
          if (!r.ok) throw new Error(`Waveform download failed (${r.status}).`);
          return decodePeaksFile(w.segmentId, w.startSec, (await r.json()) as PeaksFile);
        }),
      );
      return out.filter((p): p is SegmentPeaks => p !== null);
    },
  });
}
