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

  it('invalidates the dashboard queries that read the entity', () => {
    const qc = client();
    const byCategory = qk.dashboardQuery(SID, { name: 'events_by_category' });
    const topicsQuery = qk.dashboardQuery(SID, { name: 'topics' });
    qc.setQueryData(qk.events(SID), []);
    qc.setQueryData(byCategory, 1);
    qc.setQueryData(topicsQuery, 1);
    qc.setQueryData(qk.sessions('show_1'), []);
    qc.setQueryData(qk.topics(SID), []);
    applyEntity(qc, SID, { entity: 'event', op: 'upsert', id: 'a', data: ev('a', 1) });
    expect(isInvalid(qc, byCategory)).toBe(true);
    expect(isInvalid(qc, topicsQuery)).toBe(false);
    // Event counts arrive with the session push that follows every event write.
    expect(isInvalid(qc, qk.sessions('show_1'))).toBe(false);
    expect(isInvalid(qc, qk.events(SID))).toBe(false);
    expect(isInvalid(qc, qk.topics(SID))).toBe(false);
  });

  it('refetches derived entries once for a change and its echo', () => {
    const qc = client();
    const stats = qk.dashboardQuery(SID, { name: 'summary_stats' });
    qc.setQueryData(qk.events(SID), []);
    const change = { entity: 'event', op: 'upsert', id: 'a', data: ev('a', 1) } as const;
    applyEntity(qc, SID, change);
    qc.setQueryData(stats, 1);
    applyEntity(qc, SID, { ...change, data: ev('a', 1) });
    expect(isInvalid(qc, stats)).toBe(false);
    // A different change of the same row still refetches them.
    applyEntity(qc, SID, { ...change, data: ev('a', 2) });
    expect(isInvalid(qc, stats)).toBe(true);
  });

  it('a session push patches its row in the session lists, keeping its access', () => {
    const qc = client();
    const row = { id: SID, showId: 'show_1', eventCount: 1, access: 'read' } as unknown as Session;
    const other = { id: 'ses_2', showId: 'show_1', eventCount: 0 } as unknown as Session;
    qc.setQueryData(qk.sessions('show_1'), [row, other]);
    applySessionMessage(qc, SID, {
      type: 'change',
      entity: 'session',
      op: 'upsert',
      id: SID,
      data: { ...row, eventCount: 2, access: 'write' } as unknown as Session,
    });
    const list = qc.getQueryData<Session[]>(qk.sessions('show_1'));
    expect(list?.[0]).toMatchObject({ eventCount: 2, access: 'read' });
    expect(list?.[1]).toBe(other);
    expect(isInvalid(qc, qk.sessions('show_1'))).toBe(false);
    // A session the list doesn't hold yet (just created) refetches it.
    applySessionMessage(qc, 'ses_3', {
      type: 'change',
      entity: 'session',
      op: 'upsert',
      id: 'ses_3',
      data: { id: 'ses_3', showId: 'show_1' } as unknown as Session,
    });
    expect(isInvalid(qc, qk.sessions('show_1'))).toBe(true);
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

  it('a late op result older than the pushed state does not overwrite it', () => {
    const qc = client();
    const at = (s: number) => `2026-11-23T10:00:0${s}.000Z`;
    // Companion's Stop push landed first; the web's earlier transport.start result arrives after.
    qc.setQueryData(qk.session(SID), { id: SID, isRolling: false, updatedAt: at(2) });
    const start = { id: SID, isRolling: true, updatedAt: at(1) } as Session;
    applySessionMessage(qc, SID, { type: 'transport', session: start });
    expect(qc.getQueryData<Session>(qk.session(SID))?.isRolling).toBe(false);
    // Same time (a push that only refreshes derived counts) still applies.
    applySessionMessage(qc, SID, {
      type: 'transport',
      session: { id: SID, isRolling: false, eventCount: 3, updatedAt: at(2) } as Session,
    });
    expect(qc.getQueryData<Session>(qk.session(SID))?.eventCount).toBe(3);

    qc.setQueryData(qk.events(SID), [{ ...ev('a', 10), message: 'new', updatedAt: at(2) }]);
    const stale = { ...ev('a', 10), message: 'old', updatedAt: at(1) };
    applySessionMessage(qc, SID, {
      type: 'change',
      entity: 'event',
      op: 'upsert',
      id: 'a',
      data: stale,
    });
    expect(qc.getQueryData<SessionEvent[]>(qk.events(SID))?.[0]?.message).toBe('new');
  });

  it('a session delete drops it from the cache', () => {
    const qc = client();
    qc.setQueryData(qk.session(SID), { id: SID });
    applySessionMessage(qc, SID, { type: 'change', entity: 'session', op: 'delete', id: SID });
    expect(qc.getQueryData(qk.session(SID))).toBeUndefined();
  });

  it('invalidate refetches the list and what derives from it', () => {
    const qc = client();
    const talkTime = qk.dashboardQuery(SID, { name: 'speaker_talk_time' });
    qc.setQueryData(qk.transcript(SID), []);
    qc.setQueryData(talkTime, 1);
    applySessionMessage(qc, SID, { type: 'invalidate', entity: 'transcript_segment' });
    expect(isInvalid(qc, qk.transcript(SID))).toBe(true);
    expect(isInvalid(qc, talkTime)).toBe(true);
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
