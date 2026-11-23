// Session writes. Every op that changes session data is listed here with how its result lands in
// the cache; the result is applied through the one cache writer, so the change shows at once (also
// while the socket is reconnecting) and the socket echo is a no-op.

import type { ChangeEntity, FullOpInput, LiveEntity, OpName, OpResult } from '@autologger/contract';
import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { type RpcError, rpc } from '../rpc';
import { applyEntity, type EntityChange } from './cache';
import { keysFor } from './entities';

type Out<N extends OpName> = OpResult<N, FullOpInput<N>>;

/** What a write did: rows to patch, or entities whose cached lists must be refetched. */
export type WriteEffect = EntityChange | { invalidate: LiveEntity | ChangeEntity };

const upsert = (entity: LiveEntity, row: { id: string }): EntityChange => ({
  entity,
  op: 'upsert',
  id: row.id,
  data: row,
});
const del = (entity: LiveEntity, id: string): EntityChange => ({ entity, op: 'delete', id });

/** Content an undo group may touch. */
const REVERTIBLE: ChangeEntity[] = [
  'dashboard',
  'event',
  'topic',
  'transcript_segment',
  'audio_segment',
  'session',
];

const WRITES = {
  'sessions.create': (s) => [upsert('session', s)],
  'sessions.update': (s) => [upsert('session', s)],
  'sessions.archive': (s) => [upsert('session', s)],
  'transport.start': (s) => [upsert('session', s)],
  'transport.stop': (s) => [upsert('session', s)],
  'transport.reset': (s) => [upsert('session', s)],
  'events.create': (e) => [upsert('event', e)],
  'events.update': (e) => [upsert('event', e)],
  'events.delete': (_r, i) => [del('event', i.eventId)],
  'topics.create': (t) => [upsert('topic', t)],
  'topics.update': (t) => [upsert('topic', t)],
  'topics.delete': (_r, i) => [del('topic', i.topicId)],
  'transcript.updateSegment': (s) => [upsert('transcript_segment', s)],
  'transcript.renameSpeaker': () => [{ invalidate: 'transcript_segment' }],
  'transcript.import': () => [
    { invalidate: 'transcript_segment' },
    { invalidate: 'audio_segment' },
    { invalidate: 'change' },
  ],
  'dashboards.save': (d) => [upsert('dashboard', d)],
  'dashboards.delete': (_r, i) => [del('dashboard', i.dashboardId)],
  'media.delete': (_r, i) => [del('audio_segment', i.segmentId)],
  'media.importYoutube': (j) => [upsert('job', j)],
  // Re-running a job also resets its recordings' status.
  'media.retranscribe': (jobs) => [
    ...jobs.map((j) => upsert('job', j)),
    { invalidate: 'audio_segment' },
  ],
  'media.rewaveform': (jobs) => jobs.map((j) => upsert('job', j)),
  'changes.revert': (c) => [{ invalidate: 'change' }, { invalidate: c.entity }],
  'changes.revertGroup': () => [
    { invalidate: 'change' },
    ...REVERTIBLE.map((invalidate) => ({ invalidate })),
  ],
} satisfies {
  [N in OpName]?: (result: Out<N>, input: FullOpInput<N>) => WriteEffect[];
};

export type SessionWriteOp = keyof typeof WRITES;

/** Apply what a write did to the cache. */
export function applyWrite<N extends SessionWriteOp>(
  qc: QueryClient,
  sessionId: string,
  op: N,
  result: Out<N>,
  input: FullOpInput<N>,
) {
  const effects = (WRITES[op] as (r: Out<N>, i: FullOpInput<N>) => WriteEffect[])(result, input);
  for (const e of effects) {
    if ('invalidate' in e) {
      for (const key of keysFor(e.invalidate, sessionId))
        void qc.invalidateQueries({ queryKey: key });
    } else applyEntity(qc, sessionId, e);
  }
}

/** Run a session write op and apply its result to the cache. */
export async function sessionWrite<N extends SessionWriteOp>(
  qc: QueryClient,
  sessionId: string,
  op: N,
  input: FullOpInput<N>,
): Promise<Out<N>> {
  const result = (await rpc(op, input)) as Out<N>;
  applyWrite(qc, sessionId, op, result, input);
  return result;
}

/** `write(op, input)` for `sessionId`; stable across renders, so it can go to memoized rows. */
export function useSessionWrite(sessionId: string) {
  const qc = useQueryClient();
  return useCallback(
    <N extends SessionWriteOp>(op: N, input: FullOpInput<N>) =>
      sessionWrite(qc, sessionId, op, input),
    [qc, sessionId],
  );
}

/** A mutation (pending/error state) for one session write op. */
export function useSessionMutation<N extends SessionWriteOp>(
  sessionId: string,
  op: N,
  opts: { onSuccess?: (data: Out<N>, input: FullOpInput<N>) => void } = {},
) {
  const qc = useQueryClient();
  return useMutation<Out<N>, RpcError, FullOpInput<N>>({
    mutationFn: (input) => sessionWrite(qc, sessionId, op, input),
    onSuccess: opts.onSuccess,
  });
}
