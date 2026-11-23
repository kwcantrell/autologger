// The show's live socket: /ws/show/:id. Keeps the rail's jobs indicator, session list and the
// show's change log (/changes) current for every session of the show (imports and sessions
// started by agents or other tabs) without polling. Reconnects through createLiveSocket;
// useShowJobs falls back to polling while it is not open, and for good after repeated failed
// handshakes.

import type { ShowServerMessage } from '@autologger/contract';
import { type QueryClient, type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { qk } from './queries';
import { patchShowJobs, type ShowJobs } from './showJobs';
import { createLiveSocket, liveUrl, type ShowLiveStatus } from './socket';

/** Bursts of pushes (a playlist import) refetch once. */
const COALESCE_MS = 300;
/** Connection attempts in a row that never reached `hello` before giving up (polling remains). */
const MAX_FAILED_CONNECTS = 3;

export type { ShowLiveStatus } from './socket';

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
        ? patchShowJobs(qc.getQueryData<ShowJobs>(jobsKey), m.data)
        : null;
    if (patched) qc.setQueryData(jobsKey, patched);
    else refetch(jobsKey);
  } else if (m.type === 'invalidate') {
    refetch(
      m.entity === 'job'
        ? jobsKey
        : m.entity === 'compilation'
          ? qk.compilations(showId)
          : m.entity === 'change'
            ? qk.showChangesAll(showId)
            : m.entity === 'device'
              ? qk.companion
              : qk.sessions(showId),
    );
  }
}

/** Opens the live socket for `showId` while mounted. */
export function useLiveShow(showId: string | undefined): ShowLiveStatus {
  const qc = useQueryClient();
  const [status, setStatus] = useState<ShowLiveStatus>({ state: 'connecting' });

  useEffect(() => {
    if (!showId) return;
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
    const socket = createLiveSocket<ShowServerMessage>({
      url: liveUrl(`/ws/show/${encodeURIComponent(showId)}`),
      onStatus: setStatus,
      // Catch up on anything that changed before the socket was listening (always after a
      // reconnect: pushes sent while offline are gone).
      onHello: (_m, { reconnect, connectedAt }) => {
        for (const key of [qk.showJobs(showId), qk.sessions(showId), qk.showChangesAll(showId)])
          if (reconnect || (qc.getQueryState(key)?.dataUpdatedAt ?? 0) < connectedAt) refetch(key);
      },
      onMessage: (m) => applyShowMessage(qc, showId, m, refetch),
      onClosed: () => void qc.invalidateQueries({ queryKey: qk.shows }),
      // Rejected at the upgrade (401/404) or unreachable: stop after a few tries.
      maxFailedConnects: MAX_FAILED_CONNECTS,
    });
    return () => {
      clearTimeout(flushTimer);
      socket.dispose();
    };
  }, [showId, qc]);

  return status;
}
