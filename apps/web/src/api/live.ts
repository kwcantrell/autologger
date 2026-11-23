// The session's live socket: /ws/session/:id. Applies server pushes to the query cache so every
// open tab sees the same session without polling. Reconnects with capped exponential backoff and
// refetches the session's lists after a reconnect (pushes missed while offline are gone).

import type { SessionServerMessage } from '@autologger/contract';
import { type QueryClient, type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { setServerTime } from '@/lib/timecode';
import { qk } from './queries';
import { RpcError, rpc } from './rpc';
import { applySessionMessage } from './session/cache';
import { sessionKeys } from './session/entities';

export type LiveStatus =
  | { state: 'connecting' }
  | { state: 'open' }
  | { state: 'reconnecting'; attempt: number }
  | { state: 'closed'; reason: 'access_revoked' | 'deleted' | 'unauthenticated' };

const queuedRefetch = new WeakMap<QueryClient, Set<string>>();

/**
 * Refetch `key` so that no response read before now has the last word. A fetch in flight may have
 * been read before a push it would then overwrite: join it (not cancel it — cancelling on every
 * push could starve a slow list under a busy log) and fetch once more when it lands.
 */
function refetchAfterInFlight(qc: QueryClient, key: QueryKey) {
  if (qc.getQueryState(key)?.fetchStatus !== 'fetching') {
    void qc.invalidateQueries({ queryKey: key, exact: true });
    return;
  }
  const queued = queuedRefetch.get(qc) ?? new Set<string>();
  queuedRefetch.set(qc, queued);
  const hash = JSON.stringify(key);
  if (queued.has(hash)) return;
  queued.add(hash);
  void qc.refetchQueries({ queryKey: key, exact: true }, { cancelRefetch: false }).finally(() => {
    queued.delete(hash);
    void qc.invalidateQueries({ queryKey: key, exact: true });
  });
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

    // A session deleted or unshared while we were offline is refused at the upgrade with an HTTP
    // status, which the browser reports as a plain 1006 close. After repeated failures, ask
    // sessions.get: once it says the session is gone (SessionRoute then shows why) or we are signed
    // out, stop reconnecting.
    const checkSession = async () => {
      // Probe directly rather than refetching the observed query: a failed refetch (server still
      // down) would put it in an error state and unmount the workspace for a transient outage.
      let code: string | undefined;
      try {
        await rpc('sessions.get', { sessionId });
        return;
      } catch (err) {
        code = err instanceof RpcError ? err.code : undefined;
      }
      if (disposed || terminal || !code) return;
      if (!['not_found', 'forbidden', 'unauthenticated'].includes(code)) return;
      terminal = true;
      clearTimeout(retryTimer);
      if (code === 'unauthenticated') setStatus({ state: 'closed', reason: 'unauthenticated' });
      // Confirmed gone (the server answered): refetch so SessionRoute shows why.
      else void qc.refetchQueries({ queryKey: qk.session(sessionId), exact: true });
    };

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
          // Pushes reach us only from now on: whatever was read before (on first connect, the
          // lists loaded while the socket opened; after a reconnect, everything) may be missing
          // changes. Refetch what is loaded or loading; lists never fetched just go stale.
          for (const key of sessionKeys(sessionId))
            if (qc.getQueryState(key)) refetchAfterInFlight(qc, key);
          // Change lists are keyed per view under a common prefix.
          void qc.invalidateQueries({ queryKey: qk.changesAll(sessionId) });
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
        if (attempt >= 2) void checkSession();
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
