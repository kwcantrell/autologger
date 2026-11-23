// Browser recording: one MediaStream, a MediaRecorder rolled over every SEGMENT_SEC so each
// segment is a standalone playable file, each handed to the upload queue with its session time.

import { useCallback, useEffect, useRef, useState } from 'react';
import { createStore } from '@/lib/store';
import { enqueueUpload } from './uploads';

const SEGMENT_SEC = 60;

export type RecorderState = 'idle' | 'starting' | 'recording' | 'stopping';

function pickMime(): string {
  const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const m of options)
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

export function recorderSupport(): string | null {
  if (typeof window === 'undefined') return null;
  if (!window.isSecureContext) return 'Recording needs a secure connection (https or localhost).';
  if (!navigator.mediaDevices?.getUserMedia) return "This browser can't access a microphone.";
  if (typeof MediaRecorder === 'undefined')
    return "This browser can't record audio (no MediaRecorder).";
  return null;
}

export function useRecorder(sessionId: string, elapsedSec: () => number) {
  const [state, setState] = useState<RecorderState>('idle');
  const [error, setError] = useState<string | null>(null);
  // Mic level 0..1, updated ~12 times a second while recording. A store, not state, so only
  // the meter re-renders — not the workspace and every tab under it.
  const [level] = useState(() => createStore(0));
  const [startedAt, setStartedAt] = useState<number | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const segStartRef = useRef<{ sec: number; wall: number } | null>(null);
  const rolloverRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const levelRafRef = useRef(0);
  const ctxRef = useRef<AudioContext | null>(null);
  const stoppingRef = useRef(false);
  const elapsedRef = useRef(elapsedSec);
  elapsedRef.current = elapsedSec;

  const startSegment = useCallback(
    (stream: MediaStream, mime: string) => {
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      const seg = { sec: elapsedRef.current(), wall: Date.now() };
      segStartRef.current = seg;
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      rec.onstop = () => {
        const type = rec.mimeType || mime || 'audio/webm';
        const blob = new Blob(chunks, { type });
        if (blob.size > 0) {
          enqueueUpload({
            sessionId,
            blob,
            mimeType: type,
            origin: 'recorded',
            startSec: Math.max(0, seg.sec),
            durationSec: (Date.now() - seg.wall) / 1000,
          });
        }
      };
      rec.start(1000);
      recRef.current = rec;
    },
    [sessionId],
  );

  const cleanup = useCallback(() => {
    clearInterval(rolloverRef.current);
    cancelAnimationFrame(levelRafRef.current);
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    void ctxRef.current?.close().catch(() => undefined);
    ctxRef.current = null;
    recRef.current = null;
    level.set(0);
    setStartedAt(null);
    document.body.classList.remove('v4-is-recording');
  }, [level]);

  const start = useCallback(async () => {
    const unsupported = recorderSupport();
    if (unsupported) {
      setError(unsupported);
      return false;
    }
    setError(null);
    setState('starting');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false },
      });
    } catch (e) {
      setState('idle');
      const name = e instanceof DOMException ? e.name : '';
      setError(
        name === 'NotAllowedError'
          ? 'Microphone access denied. Allow the microphone for this site in the browser settings.'
          : name === 'NotFoundError'
            ? 'No microphone found.'
            : `Couldn't open the microphone (${e instanceof Error ? e.message : String(e)}).`,
      );
      return false;
    }
    streamRef.current = stream;
    stoppingRef.current = false;
    const mime = pickMime();
    startSegment(stream, mime);
    rolloverRef.current = setInterval(() => {
      const rec = recRef.current;
      if (!rec || stoppingRef.current || !streamRef.current) return;
      rec.stop();
      startSegment(streamRef.current, mime);
    }, SEGMENT_SEC * 1000);

    // Mic level meter.
    try {
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      let last = 0;
      const tick = (t: number) => {
        if (t - last > 80) {
          last = t;
          analyser.getByteTimeDomainData(buf);
          let peak = 0;
          for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
          level.set(Math.min(1, peak / 100));
        }
        levelRafRef.current = requestAnimationFrame(tick);
      };
      levelRafRef.current = requestAnimationFrame(tick);
    } catch {
      /* meter is optional */
    }
    // A track ending (device unplugged) stops the recording honestly.
    stream.getAudioTracks()[0]?.addEventListener('ended', () => {
      setError(
        'The microphone was disconnected. Recording stopped; the audio so far is being uploaded.',
      );
      stoppingRef.current = true;
      if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop();
      cleanup();
      setState('idle');
    });
    document.body.classList.add('v4-is-recording');
    setStartedAt(Date.now());
    setState('recording');
    return true;
  }, [cleanup, startSegment, level]);

  const stop = useCallback(async () => {
    const rec = recRef.current;
    if (!rec) return;
    stoppingRef.current = true;
    setState('stopping');
    await new Promise<void>((resolve) => {
      rec.addEventListener('stop', () => resolve(), { once: true });
      if (rec.state !== 'inactive') rec.stop();
      else resolve();
    });
    cleanup();
    setState('idle');
  }, [cleanup]);

  // Leaving the session stops the recording (the last segment still uploads).
  useEffect(
    () => () => {
      stoppingRef.current = true;
      if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop();
      cleanup();
    },
    [cleanup],
  );

  return { state, error, level, startedAt, start, stop, clearError: () => setError(null) };
}
