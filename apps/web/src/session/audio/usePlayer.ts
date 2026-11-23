// Session audio playback over its segments. One <audio> element; session seconds map to a
// segment and an offset inside it. Presigned URLs come from media.playbackUrl and are cached
// until shortly before they expire.

import type { AudioSegment } from '@autologger/contract';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage, rpc } from '@/api/rpc';
import { createStore } from '@/lib/store';
import { showToast } from '@/shared/components/Toast';

const PLAYABLE = new Set<AudioSegment['status']>(['ready', 'transcribing', 'transcribed']);

export interface PlayerSegment {
  seg: AudioSegment;
  start: number;
  end: number;
}

export function playableSegments(segments: AudioSegment[] | undefined): PlayerSegment[] {
  return (segments ?? [])
    .filter((s) => PLAYABLE.has(s.status))
    .map((s) => ({ seg: s, start: s.startSec, end: s.startSec + (s.durationSec ?? 0) }))
    .sort((a, b) => a.start - b.start);
}

export function usePlayer(segments: AudioSegment[] | undefined, enabled: boolean) {
  const list = useMemo(() => playableSegments(segments), [segments]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const currentRef = useRef<PlayerSegment | null>(null);
  const urlCache = useRef(new Map<string, { url: string; exp: number }>());
  const listRef = useRef(list);
  listRef.current = list;
  const [isPlaying, setPlaying] = useState(false);
  /** Playhead in session seconds; a store so only its readers re-render each frame. */
  const [position] = useState(() => createStore<number | null>(null));
  const rafRef = useRef(0);
  /** Session second to pause at (a cited range's end), cleared by the next seek or that pause. */
  const stopAtRef = useRef<number | null>(null);
  /** Bumped by every seek: only the latest one may load, play or report an error. */
  const seekSeq = useRef(0);

  if (typeof window !== 'undefined' && !audioRef.current) {
    audioRef.current = new Audio();
    audioRef.current.preload = 'auto';
  }

  const urlFor = useCallback(async (segId: string) => {
    const c = urlCache.current.get(segId);
    if (c && c.exp - Date.now() > 60_000) return c.url;
    const r = await rpc('media.playbackUrl', { segmentId: segId });
    urlCache.current.set(segId, { url: r.url, exp: Date.parse(r.expiresAt) });
    return r.url;
  }, []);

  const tick = useCallback(() => {
    const a = audioRef.current;
    const cur = currentRef.current;
    if (a && cur) {
      const pos = cur.start + a.currentTime;
      position.set(pos);
      if (stopAtRef.current != null && pos >= stopAtRef.current && !a.paused) {
        stopAtRef.current = null;
        a.pause();
      }
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [position]);

  /**
   * Loads `ps` (unless it is the loaded segment) and moves to `offset` in it. Resolves false when
   * a newer seek took over meanwhile (`isCurrent`), so a slow load can't replace a later one.
   * `currentRef` names a segment only once its metadata has loaded.
   */
  const load = useCallback(
    async (ps: PlayerSegment, offset: number, isCurrent: () => boolean) => {
      const a = audioRef.current!;
      if (currentRef.current?.seg.id !== ps.seg.id) {
        const url = await urlFor(ps.seg.id);
        if (!isCurrent()) return false;
        currentRef.current = null;
        a.src = url;
        await new Promise<void>((resolve, reject) => {
          const ok = () => {
            a.removeEventListener('error', bad);
            resolve();
          };
          const bad = () => {
            a.removeEventListener('loadedmetadata', ok);
            reject(new Error("The audio file couldn't be loaded."));
          };
          a.addEventListener('loadedmetadata', ok, { once: true });
          a.addEventListener('error', bad, { once: true });
        });
        if (!isCurrent()) return false;
        currentRef.current = ps;
      }
      a.currentTime = Math.max(0, offset);
      return true;
    },
    [urlFor],
  );

  /** Segment containing `sec`, or the next one after it. */
  const locate = useCallback(
    (sec: number) =>
      listRef.current.find((p) => sec >= p.start && sec < Math.max(p.end, p.start + 0.01)) ??
      listRef.current.find((p) => p.start >= sec) ??
      null,
    [],
  );

  /** Move the playhead to `sec` (and play); with `stopAt`, playback pauses there once. */
  const seek = useCallback(
    async (sec: number, play = false, stopAt: number | null = null) => {
      const seq = ++seekSeq.current;
      const isCurrent = () => seq === seekSeq.current;
      stopAtRef.current = stopAt != null && stopAt > sec ? stopAt : null;
      position.set(sec);
      const ps = locate(sec);
      if (!ps) {
        if (play)
          showToast(
            listRef.current.length
              ? 'No audio at this point of the session.'
              : 'This session has no playable audio yet.',
            true,
          );
        return;
      }
      try {
        if (!(await load(ps, Math.max(0, sec - ps.start), isCurrent))) return;
        if (play) await audioRef.current!.play();
      } catch (e) {
        if (isCurrent()) showToast(errorMessage(e), true);
      }
    },
    [load, locate, position],
  );

  const toggle = useCallback(async () => {
    const a = audioRef.current!;
    if (!a.paused) {
      a.pause();
      return;
    }
    if (!currentRef.current) {
      await seek(position.get() ?? listRef.current[0]?.start ?? 0, true, stopAtRef.current);
      return;
    }
    try {
      await a.play();
    } catch (e) {
      showToast(errorMessage(e), true);
    }
  }, [seek, position]);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onPlay = () => {
      setPlaying(true);
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(tick);
    };
    const onPause = () => {
      setPlaying(false);
      cancelAnimationFrame(rafRef.current);
    };
    const onEnded = () => {
      // Continue into the next segment.
      const cur = currentRef.current;
      const next =
        cur && listRef.current.find((p) => p.start >= cur.end - 0.5 && p.seg.id !== cur.seg.id);
      if (next) void seek(next.start, true, stopAtRef.current);
      else onPause();
    };
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    a.addEventListener('ended', onEnded);
    return () => {
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('ended', onEnded);
    };
  }, [tick, seek]);

  useEffect(() => {
    if (!enabled) audioRef.current?.pause();
  }, [enabled]);

  useEffect(
    () => () => {
      cancelAnimationFrame(rafRef.current);
      const a = audioRef.current;
      if (a) {
        a.pause();
        a.removeAttribute('src');
      }
    },
    [],
  );

  return useMemo(
    () => ({ segments: list, isPlaying, position, seek, toggle }),
    [list, isPlaying, position, seek, toggle],
  );
}

export type Player = ReturnType<typeof usePlayer>;
