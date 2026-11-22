// The session's live socket: /ws/session/:id. Applies server pushes to the query cache so every
// open tab sees the same session without polling. Reconnects with capped exponential backoff and
// refetches the session's lists after a reconnect (pushes missed while offline are gone).

import type {
  AudioSegment,
  Dashboard,
  Job,
  LiveEntity,
  Session,
  SessionDetail,
  SessionEvent,
  SessionServerMessage,
  Topic,
  TranscriptSegment,
} from '@autologger/contract';
import { type QueryClient, type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { setServerTime } from '@/lib/timecode';
import { qk } from './queries';

export type LiveStatus =
  | { state: 'connecting' }
  | { state: 'open' }
  | { state: 'reconnecting'; attempt: number }
  | { state: 'closed'; reason: 'access_revoked' | 'deleted' | 'unauthenticated' };

type WithId = { id: string };

function upsertList<T extends WithId>(
  list: T[] | undefined,
  item: T,
  sort?: (a: T, b: T) => number,
): T[] | undefined {
  if (!list) return list;
  const i = list.findIndex((x) => x.id === item.id);
  const next = i === -1 ? [...list, item] : list.map((x) => (x.id === item.id ? item : x));
  return sort ? next.sort(sort) : next;
}

const removeFromList = <T extends WithId>(list: T[] | undefined, id: string) =>
  list?.filter((x) => x.id !== id);

export const byEventTime = (a: SessionEvent, b: SessionEvent) =>
  (a.timecodeFrames ?? Number.MAX_SAFE_INTEGER) - (b.timecodeFrames ?? Number.MAX_SAFE_INTEGER) ||
  a.wallTime.localeCompare(b.wallTime);
const byStart = (a: { startSec: number }, b: { startSec: number }) => a.startSec - b.startSec;
const byOrdinal = (a: AudioSegment, b: AudioSegment) => a.ordinal - b.ordinal;
const byNewest = (a: Job, b: Job) => b.createdAt.localeCompare(a.createdAt);

/** Session entity → the list key it lives in. */
function listKey(entity: LiveEntity, sessionId: string): QueryKey | null {
  switch (entity) {
    case 'event':
      return qk.events(sessionId);
    case 'topic':
      return qk.topics(sessionId);
    case 'transcript_segment':
      return qk.transcript(sessionId);
    case 'audio_segment':
      return qk.media(sessionId);
    case 'dashboard':
      return qk.dashboards(sessionId);
    case 'job':
      return qk.jobs(sessionId);
    case 'change':
      return qk.changesAll(sessionId);
    case 'session':
      return qk.session(sessionId);
  }
}

/** Derived views that depend on session data (dashboards' live queries). */
function invalidateDerived(qc: QueryClient, entity: LiveEntity, sessionId: string) {
  if (entity === 'event' || entity === 'topic' || entity === 'transcript_segment') {
    void qc.invalidateQueries({ queryKey: qk.dashboardQueryAll(sessionId) });
  }
  if (entity === 'event') void qc.invalidateQueries({ queryKey: qk.sessionsAll });
  // audioSeconds is derived from the audio segments, transcriptJob from the jobs: refresh the
  // session (and the rail, below).
  if (entity === 'audio_segment' || entity === 'job')
    void qc.invalidateQueries({ queryKey: qk.session(sessionId) });
  if (entity === 'audio_segment' || entity === 'session')
    void qc.invalidateQueries({ queryKey: qk.sessionsAll });
}

/** Pushed sessions are plain `Session`s: keep the cached sessions.get `transcriptJob`. */
function setSession(qc: QueryClient, sessionId: string, s: Session) {
  qc.setQueryData<SessionDetail>(qk.session(sessionId), (old) => ({
    ...s,
    transcriptJob: old?.transcriptJob ?? null,
  }));
}

export function applySessionMessage(qc: QueryClient, sessionId: string, m: SessionServerMessage) {
  switch (m.type) {
    case 'transport': {
      setSession(qc, sessionId, m.session);
      void qc.invalidateQueries({ queryKey: qk.sessionsAll });
      return;
    }
    case 'invalidate': {
      const key = listKey(m.entity, sessionId);
      if (key) void qc.invalidateQueries({ queryKey: key });
      invalidateDerived(qc, m.entity, sessionId);
      return;
    }
    case 'change': {
      const { entity, op, id } = m;
      const data = m.data as WithId | undefined;
      const set = <T extends WithId>(key: QueryKey, sort?: (a: T, b: T) => number) => {
        if (op === 'delete') qc.setQueryData<T[]>(key, (l) => removeFromList(l, id));
        else if (data) qc.setQueryData<T[]>(key, (l) => upsertList(l, data as T, sort));
        else void qc.invalidateQueries({ queryKey: key });
      };
      switch (entity) {
        case 'session':
          if (op === 'delete') qc.removeQueries({ queryKey: qk.session(sessionId) });
          else if (data) setSession(qc, sessionId, data as Session);
          void qc.invalidateQueries({ queryKey: qk.sessionsAll });
          break;
        case 'event':
          set<SessionEvent>(qk.events(sessionId), byEventTime);
          break;
        case 'topic':
          set<Topic>(qk.topics(sessionId), byStart);
          break;
        case 'transcript_segment':
          set<TranscriptSegment>(qk.transcript(sessionId), byStart);
          break;
        case 'audio_segment':
          set<AudioSegment>(qk.media(sessionId), byOrdinal);
          break;
        case 'dashboard':
          set<Dashboard>(qk.dashboards(sessionId));
          break;
        case 'job':
          set<Job>(qk.jobs(sessionId), byNewest);
          break;
        case 'change':
          // Change lists are filtered per view (all / agents / operators): refetch them.
          void qc.invalidateQueries({ queryKey: qk.changesAll(sessionId) });
          break;
      }
      invalidateDerived(qc, entity, sessionId);
      return;
    }
    default:
      return;
  }
}

const PING_MS = 25_000;
const MAX_BACKOFF_MS = 15_000;

/** Opens the live socket for `sessionId` while mounted. */
export function useLiveSession(sessionId: string | undefined): LiveStatus {
  const qc = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>({ state: 'connecting' });

  useEffect(() => {
    if (!sessionId) return;
    let ws: WebSocket | null = null;
    let disposed = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let terminal = false;

    const connect = () => {
      if (disposed) return;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}/ws/session/${encodeURIComponent(sessionId)}`);
      ws.onmessage = (ev) => {
        let m: SessionServerMessage;
        try {
          m = JSON.parse(String(ev.data)) as SessionServerMessage;
        } catch {
          return;
        }
        if (m.type === 'hello') {
          setServerTime(m.serverTime);
          if (attempt > 0) {
            // Catch up on anything missed while disconnected.
            for (const key of [
              qk.session(sessionId),
              qk.events(sessionId),
              qk.topics(sessionId),
              qk.transcript(sessionId),
              qk.media(sessionId),
              qk.jobs(sessionId),
              qk.dashboards(sessionId),
              qk.changesAll(sessionId),
            ])
              void qc.invalidateQueries({ queryKey: key });
          }
          attempt = 0;
          setStatus({ state: 'open' });
          return;
        }
        if (m.type === 'closed') {
          terminal = true;
          setStatus({ state: 'closed', reason: m.reason });
          void qc.invalidateQueries({ queryKey: qk.session(sessionId) });
          void qc.invalidateQueries({ queryKey: qk.sessionsAll });
          return;
        }
        applySessionMessage(qc, sessionId, m);
      };
      ws.onopen = () => {
        clearInterval(pingTimer);
        pingTimer = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
        }, PING_MS);
      };
      ws.onclose = (ev) => {
        clearInterval(pingTimer);
        if (disposed) return;
        if (ev.code === 4401) {
          setStatus({ state: 'closed', reason: 'unauthenticated' });
          return;
        }
        if (terminal || ev.code === 4403 || ev.code === 4404) return;
        attempt += 1;
        setStatus({ state: 'reconnecting', attempt });
        const delay =
          Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(attempt, 5)) * (0.75 + Math.random() * 0.5);
        retryTimer = setTimeout(connect, delay);
      };
    };

    setStatus({ state: 'connecting' });
    connect();
    const onOnline = () => {
      // Waiting out a backoff: try again now.
      if (ws?.readyState === WebSocket.CLOSED && !terminal) {
        clearTimeout(retryTimer);
        connect();
      }
    };
    window.addEventListener('online', onOnline);
    return () => {
      disposed = true;
      window.removeEventListener('online', onOnline);
      clearTimeout(retryTimer);
      clearInterval(pingTimer);
      ws?.close();
    };
  }, [sessionId, qc]);

  return status;
}
