// Shared audio-segment helpers for ops and the worker.

import { and, eq, sql } from 'drizzle-orm';
import { type DbOrTx, schema } from '../db/client.ts';

const { audioSegments } = schema;

/** Next ordinal and the session time where the existing (non-failed) segments end. */
export async function nextSegmentSlot(
  tx: DbOrTx,
  sessionId: string,
): Promise<{ ordinal: number; endSec: number }> {
  const [r] = await tx
    .select({
      ordinal: sql<number>`coalesce(max(${audioSegments.ordinal}), 0)::int + 1`,
      endSec: sql<number>`coalesce(sum(${audioSegments.durationSec}) filter (where ${audioSegments.status} <> 'failed'), 0)::float`,
    })
    .from(audioSegments)
    .where(eq(audioSegments.sessionId, sessionId));
  return { ordinal: r?.ordinal ?? 1, endSec: r?.endSec ?? 0 };
}

/** Lock the session row so concurrent uploads get distinct ordinals. */
export async function lockSession(tx: DbOrTx, sessionId: string): Promise<void> {
  await tx.execute(sql`select 1 from sessions where id = ${sessionId} for update`);
}

export async function activeTranscribeJob(tx: DbOrTx, segmentId: string) {
  const [row] = await tx
    .select()
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.kind, 'transcribe'),
        sql`${schema.jobs.status} in ('queued','running')`,
        sql`${schema.jobs.payload}->>'segmentId' = ${segmentId}`,
      ),
    )
    .limit(1);
  return row ?? null;
}
