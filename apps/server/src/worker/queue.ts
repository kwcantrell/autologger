// Job queue mechanics: claim, progress, finish, retry with backoff, recover stuck jobs.

import { eq, sql } from 'drizzle-orm';
import { changeMessage, publish } from '../core/bus.ts';
import { db, schema } from '../db/client.ts';
import { type JobRow, toJob } from '../media/jobs.ts';

const { jobs } = schema;

export const MAX_ATTEMPTS = 3;
export const STUCK_AFTER_MIN = 15;
const BACKOFF_BASE_SEC = 30;

function publishJob(job: JobRow): void {
  if (job.sessionId)
    publish(`session:${job.sessionId}`, changeMessage('job', 'upsert', job.id, toJob(job)));
}

/**
 * Atomically take the next runnable job, or null.
 *
 * Claim order: run_after, then transcriptions before other kinds, then created_at, then id.
 * A follow-up transcription is queued with run_after = its import's created_at (enqueueJob
 * `after`), so it takes its parent's place; the kind tie-break keeps it ahead of sibling imports
 * inserted in the same transaction (identical now() timestamps). id makes the order total.
 *
 * `skipKinds`: kinds this worker has no free slot for (per-kind concurrency); the next job of
 * another kind is claimed instead.
 */
export async function claimJob(skipKinds: readonly JobRow['kind'][] = []): Promise<JobRow | null> {
  const skip = skipKinds.length
    ? sql`and kind not in (${sql.join(
        skipKinds.map((k) => sql`${k}`),
        sql`, `,
      )})`
    : sql``;
  const rows = await db.execute<{ id: string }>(sql`
    update jobs set status = 'running', locked_at = now(), started_at = now(), updated_at = now(),
      attempts = attempts + 1, progress = 'Starting'
    where id = (
      select id from jobs
      where status = 'queued' and run_after <= now() ${skip}
      order by run_after, (kind = 'transcribe') desc, created_at, id
      limit 1
      for update skip locked
    )
    returning id`);
  const id = rows[0]?.id;
  if (!id) return null;
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id));
  if (job) publishJob(job);
  return job ?? null;
}

export async function setProgress(job: JobRow, progress: string): Promise<void> {
  const [row] = await db
    .update(jobs)
    .set({ progress, lockedAt: new Date(), updatedAt: new Date() })
    .where(eq(jobs.id, job.id))
    .returning();
  if (row) publishJob(row);
}

export async function completeJob(job: JobRow, progress = 'Done'): Promise<void> {
  const [row] = await db
    .update(jobs)
    .set({ status: 'done', progress, error: null, lockedAt: null, updatedAt: new Date() })
    .where(eq(jobs.id, job.id))
    .returning();
  if (row) publishJob(row);
}

/** Record a failure. Returns true when the job will be retried. */
export async function failJob(job: JobRow, message: string, permanent: boolean): Promise<boolean> {
  const retry = !permanent && job.attempts < MAX_ATTEMPTS;
  const delaySec = BACKOFF_BASE_SEC * 2 ** Math.max(0, job.attempts - 1);
  const [row] = await db
    .update(jobs)
    .set(
      retry
        ? {
            status: 'queued',
            error: message.slice(0, 1000),
            progress: `Retrying (attempt ${job.attempts + 1} of ${MAX_ATTEMPTS})`,
            runAfter: new Date(Date.now() + delaySec * 1000),
            lockedAt: null,
            startedAt: null,
            updatedAt: new Date(),
          }
        : {
            status: 'failed',
            error: message.slice(0, 1000),
            progress: null,
            lockedAt: null,
            updatedAt: new Date(),
          },
    )
    .where(eq(jobs.id, job.id))
    .returning();
  if (row) publishJob(row);
  return retry;
}

/** Put a job we hold back in the queue without counting the attempt (worker shutdown). */
export async function releaseJob(jobId: string): Promise<void> {
  await db.execute(sql`
    update jobs set status = 'queued', locked_at = null, started_at = null, updated_at = now(),
      attempts = greatest(attempts - 1, 0), progress = 'Queued'
    where id = ${jobId} and status = 'running'`);
}

/**
 * Jobs left `running` by a crashed worker: requeue them, or fail them when out of attempts.
 * Returns the failed ones so their handlers can clean up.
 */
export async function recoverStuckJobs(): Promise<JobRow[]> {
  const requeued = await db.execute<{ id: string }>(sql`
    update jobs set status = 'queued', locked_at = null, started_at = null, updated_at = now(), progress = 'Requeued after a worker stopped'
    where status = 'running' and locked_at < now() - make_interval(mins => ${STUCK_AFTER_MIN})
      and attempts < ${MAX_ATTEMPTS}
    returning id`);
  const failed = await db.execute<{ id: string }>(sql`
    update jobs set status = 'failed', locked_at = null, updated_at = now(), progress = null,
      error = 'The worker stopped while running this job.'
    where status = 'running' and locked_at < now() - make_interval(mins => ${STUCK_AFTER_MIN})
    returning id`);
  const ids = [...requeued.map((r) => r.id), ...failed.map((r) => r.id)];
  if (ids.length) console.warn(`recovered ${ids.length} stuck job(s)`);
  const rows: JobRow[] = [];
  for (const { id } of ids.map((id) => ({ id }))) {
    const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
    if (row) {
      publishJob(row);
      if (row.status === 'failed') rows.push(row);
    }
  }
  return rows;
}
