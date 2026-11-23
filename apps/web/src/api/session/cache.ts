// The one writer of session data into the query cache. Socket pushes and op results both land
// here, as the same keyed upserts, so applying a change twice (our result, then its socket echo)
// is a no-op.

import type {
  LiveEntity,
  Session,
  SessionDetail,
  SessionServerMessage,
} from '@autologger/contract';
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { qk } from '../queries';
import { removeFromList, SESSION_ENTITIES, upsertList } from './entities';

type WithId = { id: string };

export interface EntityChange {
  entity: LiveEntity;
  op: 'upsert' | 'delete';
  id: string;
  /** The full row for upserts; without it the entity's list is refetched. */
  data?: unknown;
}

/** Pushed sessions and transport results are plain `Session`s: keep the cached `transcriptJob`. */
function setSession(qc: QueryClient, sessionId: string, s: Session) {
  qc.setQueryData<SessionDetail>(qk.session(sessionId), (old) => ({
    ...s,
    transcriptJob: old?.transcriptJob ?? null,
  }));
}

function invalidateDerived(qc: QueryClient, entity: LiveEntity, sessionId: string) {
  for (const key of SESSION_ENTITIES[entity].derived(sessionId))
    void qc.invalidateQueries({ queryKey: key });
}

/** Many rows of `entity` changed: refetch its entry and everything derived from it. */
export function invalidateEntity(qc: QueryClient, sessionId: string, entity: LiveEntity) {
  void qc.invalidateQueries({ queryKey: SESSION_ENTITIES[entity].key(sessionId) });
  invalidateDerived(qc, entity, sessionId);
}

/** Apply one row's change (from the socket or an op result) to the cache. */
export function applyEntity(qc: QueryClient, sessionId: string, change: EntityChange) {
  const { entity, op, id } = change;
  const data = change.data as WithId | undefined;
  const spec = SESSION_ENTITIES[entity];
  const key = spec.key(sessionId);

  if (spec.apply === 'session') {
    if (op === 'delete') qc.removeQueries({ queryKey: key });
    else if (data) setSession(qc, sessionId, data as unknown as Session);
  } else if (spec.apply === 'refetch' || (op !== 'delete' && !data)) {
    void qc.invalidateQueries({ queryKey: key });
  } else {
    patchList(qc, key, op, id, data, spec.sort);
  }
  invalidateDerived(qc, entity, sessionId);
}

function patchList(
  qc: QueryClient,
  key: QueryKey,
  op: 'upsert' | 'delete',
  id: string,
  data: WithId | undefined,
  sort: ((a: WithId, b: WithId) => number) | undefined,
) {
  // Upserts and deletes by id are idempotent, so the same patch can be applied twice.
  const patch = () => {
    if (qc.getQueryData(key) === undefined) return;
    if (op === 'delete') qc.setQueryData<WithId[]>(key, (l) => removeFromList(l, id));
    else qc.setQueryData<WithId[]>(key, (l) => upsertList(l, data as WithId, sort));
  };
  patch();
  // A fetch in flight may have read the list before this change and would overwrite the patch
  // when it lands: re-apply it on the fetched data instead of refetching again (a refetch per push
  // would chain under a busy log). Not loaded and not fetching: the first fetch will be current.
  if (qc.getQueryState(key)?.fetchStatus === 'fetching')
    void qc
      .refetchQueries({ queryKey: key, exact: true }, { cancelRefetch: false })
      .then(patch, () => {});
}

/** Apply a session socket message (or a transport op result, as a `transport` message). */
export function applySessionMessage(
  qc: QueryClient,
  sessionId: string,
  m: SessionServerMessage,
): void {
  switch (m.type) {
    case 'transport':
      applyEntity(qc, sessionId, {
        entity: 'session',
        op: 'upsert',
        id: sessionId,
        data: m.session,
      });
      return;
    case 'invalidate':
      invalidateEntity(qc, sessionId, m.entity);
      return;
    case 'change':
      applyEntity(qc, sessionId, m);
      return;
    default:
      return;
  }
}
