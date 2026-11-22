// Show-wide job state: which failures stay listed, and the rail summary.

import type { Job, OpInput } from '@autologger/contract';
import { describe, expect, it } from 'vitest';
import {
  fetchShowJobs,
  jobsBySession,
  jobsSummary,
  mergeShowJobs,
  patchShowJobs,
  sameJobs,
} from './showJobs';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const at = (min: number) => new Date(NOW - min * 60_000).toISOString();
let n = 0;
const job = (p: Partial<Job> & Pick<Job, 'status'>): Job => ({
  id: `job_${++n}`,
  kind: 'youtube_import',
  sessionId: 'ses_a',
  error: null,
  progress: null,
  startedAt: null,
  dismissedAt: null,
  createdAt: at(60),
  updatedAt: at(60),
  ...p,
});

describe('mergeShowJobs', () => {
  it('keeps a failure until a newer job of the same kind in that session exists', () => {
    const failed = job({ status: 'failed', createdAt: at(30), updatedAt: at(29) });
    const otherKind = job({ status: 'done', kind: 'transcribe', createdAt: at(10) });
    expect(mergeShowJobs([], [otherKind], [failed]).failed).toEqual([failed]);

    const retried = job({ status: 'queued', createdAt: at(5) });
    expect(mergeShowJobs([retried], [], [failed]).failed).toEqual([]);
    const redone = job({ status: 'done', createdAt: at(5) });
    expect(mergeShowJobs([], [redone], [failed]).failed).toEqual([]);
    // A later failure of the same kind replaces the earlier one.
    const again = job({ status: 'failed', createdAt: at(4), updatedAt: at(3) });
    expect(mergeShowJobs([], [], [failed, again]).failed).toEqual([again]);
  });

  it('keeps old failures until they are dismissed', () => {
    const old = job({ status: 'failed', createdAt: at(26 * 60), updatedAt: at(25 * 60) });
    expect(mergeShowJobs([], [], [old]).failed).toEqual([old]);
    const seen = job({ status: 'failed', createdAt: at(30), dismissedAt: at(1) });
    expect(mergeShowJobs([], [], [seen]).failed).toEqual([]);
  });
});

describe('fetchShowJobs', () => {
  it('queries failures on their own, so many newer done jobs cannot hide them', async () => {
    const failed = job({
      status: 'failed',
      sessionId: 'ses_f',
      createdAt: at(1),
      updatedAt: at(1),
    });
    const calls: OpInput<'jobs.list'>[] = [];
    const list = async (input: OpInput<'jobs.list'>) => {
      calls.push(input);
      if (input.status?.includes('failed')) return [failed];
      if (input.status?.includes('done'))
        return Array.from({ length: 300 }, () => job({ status: 'done', createdAt: at(0) }));
      return [];
    };
    const r = await fetchShowJobs('show_x', list);
    expect(r.failed.map((j) => j.id)).toEqual([failed.id]);
    expect(calls.map((c) => c.status)).toEqual([['queued', 'running'], ['done'], ['failed']]);
    expect(calls[2]?.hideDismissed).toBe(true);
    expect(calls.every((c) => c.showId === 'show_x')).toBe(true);
  });
});

describe('jobsSummary / jobsBySession', () => {
  it('summarises running, queued and failed jobs, or nothing', () => {
    expect(jobsSummary(undefined)).toBeNull();
    expect(jobsSummary({ active: [], failed: [] })).toBeNull();
    const running = job({ status: 'running', sessionId: 'ses_a' });
    const queued = job({ status: 'queued', sessionId: 'ses_a', kind: 'transcribe' });
    const failed = job({ status: 'failed', sessionId: 'ses_b' });
    const data = { active: [queued, running], failed: [failed] };
    expect(jobsSummary(data)).toBe('1 running · 1 queued · 1 failed');
    const marks = jobsBySession(data);
    expect(marks.get('ses_a')).toBe(running);
    expect(marks.get('ses_b')).toBe(failed);
  });

  it('compares lists by what the rail shows', () => {
    const a = job({ status: 'running', progress: 'Starting' });
    expect(sameJobs([a], [{ ...a }])).toBe(true);
    expect(sameJobs([a], [{ ...a, progress: 'Downloading' }])).toBe(false);
    expect(sameJobs([a], [])).toBe(false);
  });
});

describe('patchShowJobs', () => {
  it('patches progress of a listed job in place and asks for a refetch otherwise', () => {
    const running = job({ status: 'running', progress: 'Starting', etaSec: 90 });
    const data = { active: [running], failed: [] };
    const patched = patchShowJobs(data, {
      ...running,
      progress: 'Storing audio',
      etaSec: undefined,
    });
    expect(patched?.active[0]).toMatchObject({ progress: 'Storing audio', etaSec: 90 });
    expect(patchShowJobs(data, { ...running })).toBe(data);
    expect(patchShowJobs(data, { ...running, status: 'done' })).toBeNull();
    expect(patchShowJobs(data, job({ status: 'queued' }))).toBeNull();
    expect(patchShowJobs(undefined, running)).toBeNull();
  });
});
