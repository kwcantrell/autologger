// The session's live socket: /ws/session/:id. Applies server pushes to the query cache so every
// open tab sees the same session without polling. Reconnects through createLiveSocket and
// refetches the session's lists on every hello (pushes missed while offline are gone).

import type { SessionServerMessage } from '@autologger/contract';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { setServerTime } from '@/lib/timecode';
import { qk } from './queries';
import { RpcError, rpc } from './rpc';
import { applySessionMessage } from './session/cache';
import { sessionKeys } from './session/entities';
import { createLiveSocket, type LiveStatus, liveUrl } from './socket';

export type { LiveStatus } from './socket';

/** Opens the live socket for `sessionId` while mounted. */
export function useLiveSession(sessionId: string | undefined): LiveStatus {
  const qc = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>({ state: 'connecting' });

  useEffect(() => {
    if (!sessionId) return;
    const socket = createLiveSocket<SessionServerMessage>({
      url: liveUrl(`/ws/session/${encodeURIComponent(sessionId)}`),
      // Without maxFailedConnects the socket never reports 'unavailable'.
      onStatus: (s) => setStatus(s as LiveStatus),
      onHello: (m) => {
        if (m.type !== 'hello') return;
        setServerTime(m.serverTime);
        // Pushes reach us only from now on: whatever was read before (on first connect, the
        // lists loaded while the socket opened; after a reconnect, everything) may be missing
        // changes. Refetch what is loaded or loading; lists never fetched just go stale.
        // Cancelling a fetch in flight is safe here: it happens once per hello, not per push.
        for (const key of sessionKeys(sessionId))
          if (qc.getQueryState(key)) void qc.invalidateQueries({ queryKey: key, exact: true });
        // Change lists are keyed per view under a common prefix.
        void qc.invalidateQueries({ queryKey: qk.changesAll(sessionId) });
      },
      onMessage: (m) => applySessionMessage(qc, sessionId, m),
      onClosed: () => {
        void qc.invalidateQueries({ queryKey: qk.session(sessionId) });
        void qc.invalidateQueries({ queryKey: qk.sessionsAll });
      },
      // Probe directly rather than refetching the observed query: a failed refetch (server still
      // down) would put it in an error state and unmount the workspace for a transient outage.
      probe: async () => {
        try {
          await rpc('sessions.get', { sessionId });
          return null;
        } catch (err) {
          const code = err instanceof RpcError ? err.code : undefined;
          if (code === 'unauthenticated') return 'unauthenticated';
          if (code !== 'not_found' && code !== 'forbidden') return null;
          // Confirmed gone (the server answered): refetch so SessionRoute shows why.
          void qc.refetchQueries({ queryKey: qk.session(sessionId), exact: true });
          return 'gone';
        }
      },
    });
    return socket.dispose;
  }, [sessionId, qc]);

  return status;
}
