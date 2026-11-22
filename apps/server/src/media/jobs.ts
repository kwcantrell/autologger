// Background job queue on the `jobs` table. Ops enqueue inside their transaction; the worker
// (src/worker) claims with FOR UPDATE SKIP LOCKED. A NOTIFY on JOBS_CHANNEL wakes the worker as
// soon as the enqueuing transaction commits.

import type { Job } from '@autologger/contract';
import { and, inArray, sql } from 'drizzle-orm';
import { newId } from '../core/ids.ts';
import { type DbOrTx, schema } from '../db/client.ts';
import { env } from '../env.ts';

export const JOBS_CHANNEL = 'autologger_jobs';

export type JobRow = typeof schema.jobs.$inferSelect;

export type JobSpec =
  | {
      kind: 'transcribe';
      sessionId: string;
      actorId: string | null;
      payload: { segmentId: string; keyTerms?: string[] };
    }
  | {
      kind: 'youtube_import';
      sessionId: string;
      actorId: string | null;
      /** durationSec: the video's length when known up front (playlist imports); estimates only. */
      payload: { url: string; durationSec?: number };
    };

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
    startedAt: r.startedAt?.toISOString() ?? null,
    dismissedAt: r.dismissedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const { jobs } = schema;

/** Finished jobs per kind that the duration estimate looks at. */
const ESTIMATE_SAMPLE = 20;

/** Workers bump their `workers` row this often… */
export const WORKER_HEARTBEAT_SEC = 15;
/** …and count as gone (for estimates) when not seen for this long. */
export const WORKER_STALE_SEC = 45;
/** Upper bound on the job slots the estimate believes in, whatever the rows say. */
export const MAX_WORKER_SLOTS = 256;

/**
 * Fill `queuePosition` and `etaSec` on the unfinished jobs of a list (jobs.list, sessions.get).
 *
 * queuePosition: how many runnable queued jobs (any show) the worker claims first, 0 = next.
 * Mirrors claimJob's order (run_after, transcriptions first, created_at, id); `kind <> 'transcribe'`
 * is false for transcriptions, so they sort first. Jobs waiting out a retry backoff (run_after in
 * the future) get no position.
 *
 * etaSec, a rough estimate: a job's own duration is the median of the last ESTIMATE_SAMPLE
 * finished jobs of its kind (for a transcription, the median seconds per audio second times its
 * segment's length, when both are known). Running: own duration minus time since startedAt (at
 * least 0). Queued with a position: when a slot is expected to free up for it, plus its own
 * duration. Slots: the summed concurrency of live workers (heartbeat within WORKER_STALE_SEC;
 * WORKER_CONCURRENCY when none is live; at most MAX_WORKER_SLOTS), busy until each running job's
 * estimated end; each job ahead takes the earliest free slot for the median duration of any kind.
 * At most two queries per call, whatever the list length.
 *
 * `untilTranscript` (sessions.get): a youtube_import's etaSec also covers the transcription it
 * queues when the download finishes (median seconds per audio second × the video length from its
 * payload), so it answers "when is the transcript ready". Without a known length it covers the
 * download only.
 */
export async function withJobEstimates<T extends Job>(
  tx: DbOrTx,
  list: T[],
  opts: { untilTranscript?: boolean } = {},
): Promise<T[]> {
  const queued = list.filter((j) => j.status === 'queued').map((j) => j.id);
  const unfinished = list.filter((j) => j.status === 'queued' || j.status === 'running');
  if (!unfinished.length) return list;

  const ahead = new Map<string, number>();
  if (queued.length) {
    const rows = await tx
      .select({
        id: jobs.id,
        ahead: sql<number>`(select count(*)::int from jobs a
          where a.status = 'queued' and a.run_after <= now()
            and (a.run_after, a.kind <> 'transcribe', a.created_at, a.id)
              < (jobs.run_after, jobs.kind <> 'transcribe', jobs.created_at, jobs.id))`,
      })
      .from(jobs)
      .where(and(inArray(jobs.id, queued), sql`${jobs.runAfter} <= now()`));
    for (const r of rows) ahead.set(r.id, r.ahead);
  }

  const kinds = sql.join(
    jobs.kind.enumValues.map((k) => sql`(${k})`),
    sql`, `,
  );
  const ids = sql.join(
    unfinished.map((j) => sql`${j.id}`),
    sql`, `,
  );
  // Only needed for queued jobs: every running job's estimated time left, and live worker slots.
  const slotStats = sql`,
      (select coalesce(json_agg(b.left_sec), '[]'::json) from (
        select greatest(0, e.est - extract(epoch from now() - j.started_at)) as left_sec
        from jobs j
        left join audio_segments s on j.kind = 'transcribe' and s.id = j.payload->>'segmentId'
        cross join lateral (select coalesce(
          case when s.duration_sec > 0 then s.duration_sec * (select v from pas) end,
          (select med from per_kind p where p.kind = j.kind),
          (select v from ovr)) as est) e
        where j.status = 'running' and j.started_at is not null and e.est is not null
        order by 1 limit ${MAX_WORKER_SLOTS}) b) as busy,
      (select least(coalesce(sum(least(greatest(w.concurrency, 0), ${MAX_WORKER_SLOTS})), 0),
          ${MAX_WORKER_SLOTS})::int
        from workers w
        where w.last_seen_at > now() - make_interval(secs => ${WORKER_STALE_SEC})) as capacity`;
  const [stats] = await tx.execute<{
    per_job: Record<string, number>;
    per_audio_sec: number | null;
    overall: number | null;
    audio: Record<string, number>;
    video: Record<string, number>;
    elapsed: Record<string, number>;
    busy?: number[];
    capacity?: number;
  }>(sql`
    with recent as (
      select r.* from (values ${kinds}) k(kind)
      cross join lateral (
        select j.kind, extract(epoch from j.updated_at - j.started_at)::float as sec,
          (select s.duration_sec from audio_segments s where s.id = j.payload->>'segmentId') as audio
        from jobs j
        where j.kind = k.kind and j.status = 'done' and j.started_at is not null
        order by j.updated_at desc
        limit ${ESTIMATE_SAMPLE}
      ) r
    ),
    per_kind as (
      select kind, percentile_cont(0.5) within group (order by sec) as med
      from recent group by kind),
    pas as (
      select percentile_cont(0.5) within group (order by sec / audio) as v
      from recent where kind = 'transcribe' and audio > 0),
    ovr as (select percentile_cont(0.5) within group (order by sec) as v from recent)
    select
      (select coalesce(json_object_agg(kind, med), '{}'::json) from per_kind) as per_job,
      (select v from pas) as per_audio_sec,
      (select v from ovr) as overall,
      (select coalesce(json_object_agg(j.id, s.duration_sec), '{}'::json)
        from jobs j join audio_segments s on s.id = j.payload->>'segmentId'
        where j.id in (${ids}) and j.kind = 'transcribe' and s.duration_sec > 0) as audio,
      (select coalesce(json_object_agg(id, sec), '{}'::json) from (
        select j.id, case when jsonb_typeof(j.payload->'durationSec') = 'number'
          then (j.payload->>'durationSec')::float end as sec
        from jobs j where j.id in (${ids}) and j.kind = 'youtube_import') v
        where sec > 0) as video,
      (select coalesce(json_object_agg(j.id, extract(epoch from now() - j.started_at)), '{}'::json)
        from jobs j
        where j.id in (${ids}) and j.status = 'running' and j.started_at is not null) as elapsed
      ${ahead.size ? slotStats : sql``}`);

  // starts[p]: seconds until a slot is free for the job at queue position p.
  const starts: number[] = [];
  const maxPosition = Math.max(-1, ...ahead.values());
  if (stats?.busy && stats.overall != null && maxPosition >= 0) {
    const overall = stats.overall;
    const slots = Math.min(
      MAX_WORKER_SLOTS,
      Math.max(stats.capacity || env.workerConcurrency, stats.busy.length),
    );
    const free = [...stats.busy, ...Array<number>(Math.max(0, slots - stats.busy.length)).fill(0)]
      .sort((a, b) => a - b)
      .slice(0, slots);
    for (let p = 0; p <= maxPosition; p++) {
      if (p > 0) {
        // The job ahead takes the earliest free slot for the median duration.
        const next = free.shift()! + overall;
        const at = free.findIndex((t) => t > next);
        free.splice(at === -1 ? free.length : at, 0, next);
      }
      starts.push(free[0]!);
    }
  }

  const own = (j: Job): number | undefined => {
    const audio = stats?.audio[j.id];
    if (j.kind === 'transcribe' && audio && stats?.per_audio_sec != null)
      return audio * stats.per_audio_sec;
    return stats?.per_job[j.kind];
  };
  return list.map((j) => {
    const position = ahead.get(j.id);
    const out: T = position === undefined ? j : { ...j, queuePosition: position };
    const duration = own(j);
    if (duration === undefined) return out;
    let eta: number | undefined;
    const elapsed = stats?.elapsed[j.id];
    if (j.status === 'running' && elapsed !== undefined) eta = Math.max(0, duration - elapsed);
    else if (position !== undefined && starts[position] !== undefined)
      eta = starts[position] + duration;
    const video = stats?.video[j.id];
    if (eta !== undefined && opts.untilTranscript && video && stats?.per_audio_sec != null)
      eta += video * stats.per_audio_sec;
    return eta === undefined ? out : { ...out, etaSec: Math.round(eta) };
  });
}
