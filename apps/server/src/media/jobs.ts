// Background job queue on the `jobs` table. Ops enqueue inside their transaction; the worker
// (src/worker) claims with FOR UPDATE SKIP LOCKED. A NOTIFY on JOBS_CHANNEL wakes the worker as
// soon as the enqueuing transaction commits.

import type { Job } from '@autologger/contract';
import { sql } from 'drizzle-orm';
import { newId } from '../core/ids.ts';
import { type DbOrTx, schema } from '../db/client.ts';

export const JOBS_CHANNEL = 'autologger_jobs';

export type JobRow = typeof schema.jobs.$inferSelect;

export type JobSpec =
  | {
      kind: 'transcribe';
      sessionId: string;
      actorId: string | null;
      payload: { segmentId: string };
    }
  | { kind: 'youtube_import'; sessionId: string; actorId: string | null; payload: { url: string } };

/**
 * Queue a job. Pass `after` for follow-up work (an import's transcription): the new job takes
 * the parent's place in the queue (run_after = parent's created_at) instead of going to the back,
 * so it runs before anything queued after the parent — a playlist import's first transcript
 * doesn't wait behind every other download. `at` sets created_at and run_after explicitly: jobs
 * inserted in one transaction otherwise share now(), so give a batch distinct, increasing times
 * so the worker claims them in order.
 */
export async function enqueueJob(
  tx: DbOrTx,
  spec: JobSpec,
  opts: { after?: JobRow; at?: Date } = {},
): Promise<JobRow> {
  const [row] = await tx
    .insert(schema.jobs)
    .values({
      id: newId('job'),
      kind: spec.kind,
      sessionId: spec.sessionId,
      payload: spec.payload,
      actorId: spec.actorId,
      progress: 'Queued',
      ...(opts.at ? { createdAt: opts.at, runAfter: opts.at } : {}),
      // Read in SQL: a JS Date would truncate created_at's microseconds.
      ...(opts.after
        ? { runAfter: sql`(select created_at from jobs where id = ${opts.after.id})` }
        : {}),
    })
    .returning();
  // Delivered on commit; harmless when the worker isn't listening.
  await tx.execute(sql`select pg_notify(${JOBS_CHANNEL}, ${row!.id})`);
  return row!;
}

export function toJob(r: JobRow): Job {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    sessionId: r.sessionId,
    error: r.error,
    progress: r.progress,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
