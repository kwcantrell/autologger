// Session write results land in the cache without waiting for the socket echo.

import type { Change, Job, Session, SessionEvent } from '@autologger/contract';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { qk } from '../queries';
import { applyWrite } from './writes';

const SID = 'ses_1';
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const isInvalid = (qc: QueryClient, key: readonly unknown[]) =>
  qc.getQueryState(key)?.isInvalidated === true;
const ev = (id: string, message = '') =>
  ({ id, sessionId: SID, timecodeFrames: 1, wallTime: 'w', message }) as unknown as SessionEvent;

describe('applyWrite', () => {
  it('an edit and a delete show at once', () => {
    const qc = client();
    qc.setQueryData(qk.events(SID), [ev('a'), ev('b')]);
    applyWrite(qc, SID, 'events.update', ev('a', 'fixed'), { eventId: 'a', message: 'fixed' });
    applyWrite(qc, SID, 'events.delete', { deleted: true }, { eventId: 'b' });
    expect(qc.getQueryData(qk.events(SID))).toEqual([ev('a', 'fixed')]);
  });

  it('a new session is seeded with no transcript job', () => {
    const qc = client();
    const s = { id: 'ses_new', showId: 'show_1' } as Session;
    applyWrite(qc, s.id, 'sessions.create', s, { showId: 'show_1', frameRate: 25 });
    expect(qc.getQueryData(qk.session(s.id))).toEqual({ ...s, transcriptJob: null });
  });

  it('jobs from a re-run are listed and the recordings refetched', () => {
    const qc = client();
    qc.setQueryData(qk.jobs(SID), []);
    qc.setQueryData(qk.media(SID), []);
    const job = { id: 'job_1', createdAt: '2026-11-23T10:00:00Z' } as Job;
    applyWrite(qc, SID, 'media.retranscribe', [job], { sessionId: SID });
    expect(qc.getQueryData(qk.jobs(SID))).toEqual([job]);
    expect(isInvalid(qc, qk.media(SID))).toBe(true);
  });

  it('undo refetches the change log and the entity it touched', () => {
    const qc = client();
    qc.setQueryData(qk.changes(SID, 'all'), []);
    qc.setQueryData(qk.topics(SID), []);
    qc.setQueryData(qk.events(SID), []);
    const change = { id: 'chg_1', entity: 'topic' } as Change;
    applyWrite(qc, SID, 'changes.revert', change, { changeId: 'chg_1' });
    expect(isInvalid(qc, qk.changes(SID, 'all'))).toBe(true);
    expect(isInvalid(qc, qk.topics(SID))).toBe(true);
    expect(isInvalid(qc, qk.events(SID))).toBe(false);
  });
});
