// The show's live socket: /ws/show/:id. Keeps the rail's jobs indicator and session list current
// for every session of the show (imports and sessions started by agents or other tabs) without
// polling. Reconnects with capped exponential backoff; useShowJobs falls back to polling while it
// is not open.

import type { Job, ShowServerMessage } from '@autologger/contract';
import { type QueryClient, type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { LiveStatus } from './live';
import { qk } from './queries';
import { patchShowJobs, type ShowJobs } from './showJobs';

const PING_MS = 25_000;
const MAX_BACKOFF_MS = 15_000;
/** Bursts of pushes (a playlist import) refetch once. */
const COALESCE_MS = 300;

function applyShowMessage(
  qc: QueryClient,
  showId: string,
  m: ShowServerMessage,
  refetch: (key: QueryKey) => void,
) {
  const jobsKey = qk.showJobs(showId);
  if (m.type === 'change') {
    const patched =
      m.op === 'upsert' && m.data
        ? patchShowJobs(qc.getQueryData<ShowJobs>(jobsKey), m.data as Job)
        : null;
    if (patched) qc.setQueryData(jobsKey, patched);
    else refetch(jobsKey);
  } else if (m.type === 'invalidate') {
    refetch(m.entity === 'job' ? jobsKey : qk.sessions(showId));
  }
}

/** Opens the live socket for `showId` while mounted. */
export function useLiveShow(showId: string | undefined): LiveStatus {
  const qc = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>({ state: 'connecting' });

  useEffect(() => {
    if (!showId) return;
    let ws: WebSocket | null = null;
    let disposed = false;
    let attempt = 0;
    let terminal = false;
    let connectedAt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    const pending = new Map<string, QueryKey>();
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const refetch = (key: QueryKey) => {
      pending.set(JSON.stringify(key), key);
      flushTimer ??= setTimeout(() => {
        flushTimer = undefined;
        for (const k of pending.values()) void qc.invalidateQueries({ queryKey: k });
        pending.clear();
      }, COALESCE_MS);
    };

    const connect = () => {
      if (disposed) return;
      connectedAt = Date.now();
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}/ws/show/${encodeURIComponent(showId)}`);
      ws.onmessage = (ev) => {
        let m: ShowServerMessage;
        try {
          m = JSON.parse(String(ev.data)) as ShowServerMessage;
        } catch {
          return;
        }
        if (m.type === 'hello') {
          // Catch up on anything that changed before the socket was listening.
          for (const key of [qk.showJobs(showId), qk.sessions(showId)])
            if ((qc.getQueryState(key)?.dataUpdatedAt ?? 0) < connectedAt) refetch(key);
          attempt = 0;
          setStatus({ state: 'open' });
          return;
        }
        if (m.type === 'closed') {
          terminal = true;
          setStatus({ state: 'closed', reason: m.reason });
          void qc.invalidateQueries({ queryKey: qk.shows });
          return;
        }
        applyShowMessage(qc, showId, m, refetch);
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
      clearTimeout(flushTimer);
      clearInterval(pingTimer);
      ws?.close();
    };
  }, [showId, qc]);

  return status;
}
