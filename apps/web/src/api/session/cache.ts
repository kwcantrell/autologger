// The one writer of session data into the query cache. Socket pushes and op results both land
// here, as the same keyed upserts, so applying a change twice (our result, then its socket echo)
// is a no-op — including what derives from it, which is refetched once per change.

import type {
  LiveEntity,
  Session,
  SessionDetail,
  SessionServerMessage,
} from '@autologger/contract';
import { type QueryClient, type QueryKey, replaceEqualDeep } from '@tanstack/react-query';
import { qk } from '../queries';
import { isOlder, removeFromList, SESSION_ENTITIES, upsertList } from './entities';
import { recordPatch } from './journal';

type WithId = { id: string };

export interface EntityChange {
  entity: LiveEntity;
  op: 'upsert' | 'delete';
  id: string;
  /** The full row for upserts; without it the entity's list is refetched. */
  data?: unknown;
}

/** Pushed sessions and transport results are plain `Session`s: keep the cached `transcriptJob`.
 *  A copy older than the cached one (a late op result after a newer push) is dropped. */
function setSession(qc: QueryClient, sessionId: string, s: Session) {
  qc.setQueryData<SessionDetail>(qk.session(sessionId), (old) =>
    old && isOlder(s, old) ? old : { ...s, transcriptJob: old?.transcriptJob ?? null },
  );
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

/** How long a change counts as just applied: its echo arrives within milliseconds. */
const REPEAT_MS = 5_000;
const MAX_REMEMBERED = 500;
/** The last change applied per row, per QueryClient. */
const lastApplied = new WeakMap<
  QueryClient,
  Map<string, { op: EntityChange['op']; data: unknown; at: number }>
>();

/**
 * Whether `change` repeats the last change applied to the same row, moments ago: our op result
 * and its socket echo, or a `transport` push and the `session` change after it. Changes without
 * a row (refetch hints) never count as repeats.
 */
function isRepeat(qc: QueryClient, sessionId: string, change: EntityChange): boolean {
  if (change.op === 'upsert' && change.data === undefined) return false;
  let rows = lastApplied.get(qc);
  if (!rows) {
    rows = new Map();
    lastApplied.set(qc, rows);
  }
  const rowKey = `${sessionId}\0${change.entity}\0${change.id}`;
  const prev = rows.get(rowKey);
  const now = Date.now();
  const repeat =
    !!prev &&
    now - prev.at < REPEAT_MS &&
    prev.op === change.op &&
    replaceEqualDeep(prev.data, change.data) === prev.data;
  rows.delete(rowKey);
  rows.set(rowKey, { op: change.op, data: change.data, at: now });
  if (rows.size > MAX_REMEMBERED) rows.delete(rows.keys().next().value as string);
  return repeat;
}

/**
 * A pushed session replaces its row in the cached session lists (the rail), keeping the row's
 * `access` (the push carries the writer's). A list that should hold it but doesn't (a new
 * session) or hasn't loaded is refetched.
 */
function patchSessionLists(qc: QueryClient, s: Session) {
  for (const [key, list] of qc.getQueriesData<Session[]>({ queryKey: qk.sessionsAll })) {
    const i = list ? list.findIndex((x) => x.id === s.id) : -1;
    if (list && i !== -1) {
      const row = { ...s, access: (list[i] as Session).access };
      qc.setQueryData<Session[]>(key, (l) => l?.map((x) => (x.id === s.id ? row : x)));
    } else if (!list || key[1] === s.showId || key[1] === 'all') {
      void qc.invalidateQueries({ queryKey: key, exact: true });
    }
  }
}

/** Apply one row's change (from the socket or an op result) to the cache. */
export function applyEntity(qc: QueryClient, sessionId: string, change: EntityChange) {
  const { entity, op, id } = change;
  const data = change.data as WithId | undefined;
  const spec = SESSION_ENTITIES[entity];
  const key = spec.key(sessionId);
  const repeat = isRepeat(qc, sessionId, change);

  if (spec.apply === 'session') {
    if (op === 'delete') qc.removeQueries({ queryKey: key });
    else if (data) {
      setSession(qc, sessionId, data as unknown as Session);
      // The session lists are its only derived entries: patch them rather than refetch.
      if (!repeat) patchSessionLists(qc, data as unknown as Session);
      return;
    }
  } else if (spec.apply === 'refetch' || (op !== 'delete' && !data)) {
    void qc.invalidateQueries({ queryKey: key });
  } else {
    patchList(qc, key, op, id, data, spec.sort);
  }
  if (!repeat) invalidateDerived(qc, entity, sessionId);
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
  const patch = (l: WithId[] | undefined) =>
    op === 'delete' ? removeFromList(l, id) : upsertList(l, data as WithId, sort);
  if (qc.getQueryData(key) !== undefined) qc.setQueryData<WithId[]>(key, patch);
  // A fetch in flight may have read the list before this change: it replays the patch onto
  // what it fetched (see journal.ts).
  recordPatch(qc, key, patch);
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
