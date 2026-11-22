// Session audio playback over its segments. One <audio> element; session seconds map to a
// segment and an offset inside it. Presigned URLs come from media.playbackUrl and are cached
// until shortly before they expire.

import type { AudioSegment } from '@autologger/contract';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage, rpc } from '@/api/rpc';

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
  const [positionSec, setPositionSec] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rafRef = useRef(0);

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
    if (a && cur) setPositionSec(cur.start + a.currentTime);
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const load = useCallback(
    async (ps: PlayerSegment, offset: number) => {
      const a = audioRef.current!;
      if (currentRef.current?.seg.id !== ps.seg.id) {
        currentRef.current = ps;
        a.src = await urlFor(ps.seg.id);
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
      }
      a.currentTime = Math.max(0, offset);
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

  const seek = useCallback(
    async (sec: number, play = false) => {
      setPositionSec(sec);
      const ps = locate(sec);
      if (!ps) {
        if (play)
          setError(
            listRef.current.length
              ? 'No audio at this point of the session.'
              : 'This session has no playable audio yet.',
          );
        return;
      }
      try {
        setError(null);
        await load(ps, Math.max(0, sec - ps.start));
        if (play) await audioRef.current!.play();
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [load, locate],
  );

  const toggle = useCallback(async () => {
    const a = audioRef.current!;
    if (!a.paused) {
      a.pause();
      return;
    }
    if (!currentRef.current) {
      await seek(positionSec ?? listRef.current[0]?.start ?? 0, true);
      return;
    }
    try {
      await a.play();
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [seek, positionSec]);

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
      if (next) void seek(next.start, true);
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

  return {
    segments: list,
    isPlaying,
    positionSec,
    error,
    seek,
    toggle,
    clearError: () => setError(null),
  };
}

export type Player = ReturnType<typeof usePlayer>;
