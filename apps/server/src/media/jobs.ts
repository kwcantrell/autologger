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

export async function enqueueJob(tx: DbOrTx, spec: JobSpec): Promise<JobRow> {
  const [row] = await tx
    .insert(schema.jobs)
    .values({
      id: newId('job'),
      kind: spec.kind,
      sessionId: spec.sessionId,
      payload: spec.payload,
      actorId: spec.actorId,
      progress: 'Queued',
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
