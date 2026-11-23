// The session cache writer: socket pushes and op results as keyed patches on a real QueryClient.

import type { Session, SessionDetail, SessionEvent } from '@autologger/contract';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { qk } from '../queries';
import { applyEntity, applySessionMessage } from './cache';
import { keysFor, sessionKeys } from './entities';

const SID = 'ses_1';
const ev = (id: string, timecodeFrames: number | null, wallTime = '2026-11-23T10:00:00Z') =>
  ({ id, sessionId: SID, timecodeFrames, wallTime }) as SessionEvent;
const isInvalid = (qc: QueryClient, key: readonly unknown[]) =>
  qc.getQueryState(key)?.isInvalidated === true;

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('applyEntity', () => {
  it('upserts by id in event order; applying the same change twice is a no-op', () => {
    const qc = client();
    qc.setQueryData(qk.events(SID), [ev('a', 10), ev('c', 30)]);
    const change = { entity: 'event', op: 'upsert', id: 'b', data: ev('b', 20) } as const;
    applyEntity(qc, SID, change);
    applyEntity(qc, SID, change);
    expect(qc.getQueryData<SessionEvent[]>(qk.events(SID))?.map((e) => e.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    applyEntity(qc, SID, { entity: 'event', op: 'delete', id: 'a' });
    expect(qc.getQueryData<SessionEvent[]>(qk.events(SID))?.map((e) => e.id)).toEqual(['b', 'c']);
  });

  it('leaves a list that is not loaded alone', () => {
    const qc = client();
    applyEntity(qc, SID, { entity: 'event', op: 'upsert', id: 'a', data: ev('a', 1) });
    expect(qc.getQueryData(qk.events(SID))).toBeUndefined();
  });

  it('invalidates what derives from the entity', () => {
    const qc = client();
    qc.setQueryData(qk.events(SID), []);
    qc.setQueryData([...qk.dashboardQueryAll(SID), { q: 1 }], 1);
    qc.setQueryData(qk.sessions('show_1'), []);
    qc.setQueryData(qk.topics(SID), []);
    applyEntity(qc, SID, { entity: 'event', op: 'upsert', id: 'a', data: ev('a', 1) });
    expect(isInvalid(qc, [...qk.dashboardQueryAll(SID), { q: 1 }])).toBe(true);
    expect(isInvalid(qc, qk.sessions('show_1'))).toBe(true);
    expect(isInvalid(qc, qk.events(SID))).toBe(false);
    expect(isInvalid(qc, qk.topics(SID))).toBe(false);
  });

  it('refetches the per-view change lists instead of patching them', () => {
    const qc = client();
    qc.setQueryData(qk.changes(SID, 'all'), []);
    qc.setQueryData(qk.changes(SID, 'mcp'), []);
    applyEntity(qc, SID, { entity: 'change', op: 'upsert', id: 'chg_1', data: { id: 'chg_1' } });
    expect(isInvalid(qc, qk.changes(SID, 'all'))).toBe(true);
    expect(isInvalid(qc, qk.changes(SID, 'mcp'))).toBe(true);
  });
});

describe('applySessionMessage', () => {
  it('a transport push keeps the cached transcriptJob', () => {
    const qc = client();
    const job = { id: 'job_1' } as unknown as SessionDetail['transcriptJob'];
    qc.setQueryData(qk.session(SID), { id: SID, isRolling: false, transcriptJob: job });
    applySessionMessage(qc, SID, {
      type: 'transport',
      session: { id: SID, isRolling: true } as Session,
    });
    expect(qc.getQueryData(qk.session(SID))).toEqual({
      id: SID,
      isRolling: true,
      transcriptJob: job,
    });
  });

  it('a session delete drops it from the cache', () => {
    const qc = client();
    qc.setQueryData(qk.session(SID), { id: SID });
    applySessionMessage(qc, SID, { type: 'change', entity: 'session', op: 'delete', id: SID });
    expect(qc.getQueryData(qk.session(SID))).toBeUndefined();
  });

  it('invalidate refetches the list and what derives from it', () => {
    const qc = client();
    qc.setQueryData(qk.transcript(SID), []);
    qc.setQueryData([...qk.dashboardQueryAll(SID), 'x'], 1);
    applySessionMessage(qc, SID, { type: 'invalidate', entity: 'transcript_segment' });
    expect(isInvalid(qc, qk.transcript(SID))).toBe(true);
    expect(isInvalid(qc, [...qk.dashboardQueryAll(SID), 'x'])).toBe(true);
  });
});

describe('entity keys', () => {
  it('keysFor covers the entry and its derived keys; non-session entities have none', () => {
    expect(keysFor('audio_segment', SID)).toEqual([qk.media(SID), qk.session(SID), qk.sessionsAll]);
    expect(keysFor('wiki_page', SID)).toEqual([]);
  });

  it('sessionKeys lists every patchable entry once', () => {
    const keys = sessionKeys(SID).map((k) => JSON.stringify(k));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(7);
    expect(keys).not.toContain(JSON.stringify(qk.changesAll(SID)));
  });
});
