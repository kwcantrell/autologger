// Show-wide background jobs (jobs.list with showId): what the rail indicator and the jobs dialog
// show. Pure helpers plus the fetch, so they can be tested without React.

import type { Job, OpInput } from '@autologger/contract';
import { rpc } from './rpc';

/** Failed jobs older than this (last update) drop out of the show-wide job list. */
export const RECENT_FAILURE_MS = 24 * 60 * 60_000;
export const UNFINISHED = ['queued', 'running'] as const;

export interface ShowJobs {
  /** Queued and running jobs of every session of the show, newest first. */
  active: Job[];
  /** Recent failures not superseded by a newer job of the same kind in that session. */
  failed: Job[];
}

type ListJobs = (input: OpInput<'jobs.list'>) => Promise<Job[]>;
const listJobs: ListJobs = (input) => rpc('jobs.list', input);

/**
 * Builds the show's job state from three lists: unfinished jobs, the newest finished ones (to
 * see which failures were retried successfully) and the newest failures, queried on their own
 * so a large import's many `done` jobs can't push them out of a shared window.
 */
export function mergeShowJobs(
  active: Job[],
  done: Job[],
  failures: Job[],
  now = Date.now(),
): ShowJobs {
  const newest = new Map<string, string>();
  const key = (j: Job) => `${j.sessionId}:${j.kind}`;
  for (const j of [...active, ...done, ...failures]) {
    const cur = newest.get(key(j));
    if (!cur || cur < j.createdAt) newest.set(key(j), j.createdAt);
  }
  const since = now - RECENT_FAILURE_MS;
  const failed = failures.filter(
    (j) =>
      j.status === 'failed' &&
      newest.get(key(j)) === j.createdAt &&
      Date.parse(j.updatedAt) >= since,
  );
  return { active, failed };
}

export async function fetchShowJobs(showId: string, list = listJobs): Promise<ShowJobs> {
  const [active, done, failures] = await Promise.all([
    list({ showId, status: [...UNFINISHED], limit: 500 }),
    list({ showId, status: ['done'], limit: 500 }),
    list({ showId, status: ['failed'], limit: 200 }),
  ]);
  return mergeShowJobs(active, done, failures);
}

/** Whether two unfinished-job lists show the same thing (ids, status, progress, estimates). */
export function sameJobs(a: Job[], b: Job[]): boolean {
  const sig = (l: Job[]) =>
    l.map((j) => `${j.id}|${j.status}|${j.progress}|${j.queuePosition}|${j.etaSec}`).join('\n');
  return sig(a) === sig(b);
}

/** The job a session card shows: a recent failure, else running over queued. */
export function jobsBySession(data: ShowJobs | undefined): Map<string, Job> {
  const out = new Map<string, Job>();
  if (!data) return out;
  for (const j of data.active) {
    if (!j.sessionId) continue;
    const cur = out.get(j.sessionId);
    if (!cur || (cur.status === 'queued' && j.status === 'running')) out.set(j.sessionId, j);
  }
  for (const j of data.failed) if (j.sessionId && !out.has(j.sessionId)) out.set(j.sessionId, j);
  return out;
}

/** Rail summary: "3 running · 1 queued · 1 failed", or null when there is nothing to report. */
export function jobsSummary(data: ShowJobs | undefined): string | null {
  if (!data) return null;
  const parts: string[] = [];
  const running = data.active.filter((j) => j.status === 'running').length;
  const queued = data.active.length - running;
  if (running) parts.push(`${running} running`);
  if (queued) parts.push(`${queued} queued`);
  if (data.failed.length) parts.push(`${data.failed.length} failed`);
  return parts.length ? parts.join(' · ') : null;
}
